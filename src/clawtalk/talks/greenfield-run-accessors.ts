import { getDbPg, type Sql, withTrustedDbWrites } from '../../db.js';
import { logger } from '../../logger.js';
import { lockDocumentEditMutationsOnSql } from '../documents/edit-locks.js';
import { emitOutboxEventOnSql, enqueueOutboxNotify } from './outbox-emit.js';
import type { TalkExecutionUsage } from './executor.js';
import { fitsProviderReplayBudget } from './provider-replay-budget.js';

export type GreenfieldRunStatus =
  | 'queued'
  | 'running'
  | 'awaiting'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface GreenfieldQueueRunRecord {
  id: string;
  workspace_id: string;
  talk_id: string;
  thread_id: string;
  round: number;
  run_kind: 'conversation' | 'content_improvement';
  snapshot_group_id: string;
  agent_snapshot_id: string;
  status: GreenfieldRunStatus;
  provider_id: string;
  model_id: string;
  requested_by: string;
  trigger_message_id: string | null;
  job_id: string | null;
  trigger: 'user' | 'scheduler' | 'manual';
  talk_mode: 'ordered' | 'parallel';
  response_group_id: string;
  sequence_index: number;
  error_json: unknown;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  target_agent_id: string | null;
  target_agent_name: string | null;
  owner_ids: string[];
}

export interface GreenfieldTriggerMessageRecord {
  id: string;
  workspace_id: string;
  talk_id: string;
  body: string | null;
}

type MarkGreenfieldRunRunningResult =
  | { status: 'claimed'; run: GreenfieldQueueRunRecord }
  | { status: 'blocked_by_sibling' }
  | { status: 'already_running' }
  | { status: 'terminal' }
  | { status: 'not_found' };

interface PendingOutboxNotify {
  topic: string;
  eventId: number;
  ownerIds: string[];
}

interface GreenfieldJobOutputTargets {
  jobId: string;
  title: string;
  emitTalkMessage: boolean;
  emitDocumentAppend: boolean;
}

interface JobDocumentAppendTarget {
  document_id: string;
  tab_id: string;
  list_version: number;
  after_block_id: string | null;
}

interface InsertedJobDocumentEdit {
  editId: string;
  documentId: string;
  tabId: string;
}

function terminalStatuses(): GreenfieldRunStatus[] {
  return ['completed', 'failed', 'cancelled'];
}

async function updateJobTerminalBookkeepingOnSql(
  sql: Sql,
  run: Pick<GreenfieldQueueRunRecord, 'workspace_id' | 'job_id'>,
  status: 'completed' | 'failed' | 'cancelled',
): Promise<void> {
  if (!run.job_id) return;
  await sql`
    update public.jobs
    set last_run_at = now(),
        last_run_status = ${status},
        run_count = run_count + 1,
        claimed_at = null,
        updated_at = now()
    where workspace_id = ${run.workspace_id}::uuid
      and id = ${run.job_id}::uuid
  `;
}

function errorJson(input: {
  code: string;
  message: string;
  metadata?: Record<string, unknown> | null;
}): Record<string, unknown> {
  return {
    code: input.code,
    message: input.message,
    ...(input.metadata && Object.keys(input.metadata).length > 0
      ? { metadata: input.metadata }
      : {}),
  };
}

function messageAppendedMetadata(
  metadata: Record<string, unknown> | null | undefined,
  identity: { providerId: string; modelId: string },
): Record<string, unknown> {
  const source = metadata ?? {};
  const {
    codexReasoningItems: _codexReasoningItems,
    codexMessageItems: _codexMessageItems,
    providerId: _providerId,
    modelId: _modelId,
    ...clientMetadata
  } = source;
  return {
    ...clientMetadata,
    providerId: identity.providerId,
    modelId: identity.modelId,
  };
}

function messageProviderReplayData(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!metadata) return null;
  const replay: Record<string, unknown> = {};
  if (
    Array.isArray(metadata.codexReasoningItems) &&
    metadata.codexReasoningItems.length > 0
  ) {
    replay.codexReasoningItems = metadata.codexReasoningItems;
  }
  if (
    Array.isArray(metadata.codexMessageItems) &&
    metadata.codexMessageItems.length > 0
  ) {
    replay.codexMessageItems = metadata.codexMessageItems;
  }
  return Object.keys(replay).length > 0 ? replay : null;
}

function boolFromSnapshot(value: string | null, fallback: boolean): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function isForeignKeyViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === '23503'
  );
}

async function getJobOutputTargetsOnSql(
  sql: Sql,
  run: GreenfieldQueueRunRecord,
): Promise<GreenfieldJobOutputTargets | null> {
  if (!run.job_id) return null;
  const rows = await sql<
    Array<{
      id: string;
      title: string;
      emit_talk_message: boolean;
      emit_document_append: boolean;
      snapshot_emit_talk_message: string | null;
      snapshot_emit_document_append: string | null;
    }>
  >`
    select
      j.id,
      j.title,
      j.emit_talk_message,
      j.emit_document_append,
      rps.tool_manifest_json #>> '{jobOutputTargets,emitTalkMessage}'
        as snapshot_emit_talk_message,
      rps.tool_manifest_json #>> '{jobOutputTargets,emitDocumentAppend}'
        as snapshot_emit_document_append
    from public.runs r
    join public.jobs j
      on j.workspace_id = r.workspace_id
     and j.id = r.job_id
    left join public.run_prompt_snapshots rps
      on rps.workspace_id = r.workspace_id
     and rps.id = r.prompt_snapshot_id
    where r.workspace_id = ${run.workspace_id}::uuid
      and r.id = ${run.id}::uuid
    limit 1
    for update of j
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    jobId: row.id,
    title: row.title,
    emitTalkMessage: boolFromSnapshot(
      row.snapshot_emit_talk_message,
      row.emit_talk_message,
    ),
    emitDocumentAppend: boolFromSnapshot(
      row.snapshot_emit_document_append,
      row.emit_document_append,
    ),
  };
}

async function getJobDocumentAppendTargetOnSql(
  sql: Sql,
  run: GreenfieldQueueRunRecord,
): Promise<JobDocumentAppendTarget | null> {
  const rows = await sql<JobDocumentAppendTarget[]>`
    select
      d.id as document_id,
      primary_tab.id as tab_id,
      primary_tab.list_version,
      last_block.id as after_block_id
    from public.documents d
    join lateral (
      select dt.id, dt.list_version
      from public.doc_tabs dt
      where dt.workspace_id = d.workspace_id
        and dt.document_id = d.id
      order by dt.sort_order asc, dt.id asc
      limit 1
    ) primary_tab on true
    left join lateral (
      select db.id
      from public.doc_blocks db
      where db.workspace_id = d.workspace_id
        and db.document_id = d.id
        and db.tab_id = primary_tab.id
      order by db.sort_order desc, db.id desc
      limit 1
    ) last_block on true
    where d.workspace_id = ${run.workspace_id}::uuid
      and d.primary_talk_id = ${run.talk_id}::uuid
    order by d.id asc
    limit 1
  `;
  return rows[0] ?? null;
}

async function insertJobDocumentEditWithAgentOnSql(input: {
  sql: Sql;
  run: GreenfieldQueueRunRecord;
  target: JobDocumentAppendTarget;
  responseContent: string;
  agentId: string | null;
}): Promise<string> {
  const rows = await input.sql<{ id: string }[]>`
    insert into public.document_edits (
      workspace_id,
      document_id,
      tab_id,
      block_id,
      base_block_version,
      base_list_version,
      after_block_id,
      proposed_by_agent_id,
      proposed_by_run_id,
      op,
      new_kind,
      new_text,
      new_attrs_json,
      source
    )
    values (
      ${input.run.workspace_id}::uuid,
      ${input.target.document_id}::uuid,
      ${input.target.tab_id}::uuid,
      null,
      null,
      ${input.target.list_version},
      ${input.target.after_block_id ?? null}::uuid,
      ${input.agentId ?? null}::uuid,
      ${input.run.id}::uuid,
      'insert',
      'p',
      ${input.responseContent},
      null,
      'job'
    )
    returning id
  `;
  return rows[0]!.id;
}

async function insertJobDocumentAppendOnSql(input: {
  sql: Sql;
  run: GreenfieldQueueRunRecord;
  responseContent: string;
}): Promise<InsertedJobDocumentEdit> {
  const target = await getJobDocumentAppendTargetOnSql(input.sql, input.run);
  if (!target) {
    throw new Error('Job document append target not found');
  }

  await lockDocumentEditMutationsOnSql(input.sql, {
    workspaceId: input.run.workspace_id,
    documentId: target.document_id,
  });

  let editId: string;
  try {
    await input.sql`savepoint job_document_append_agent_fk`;
    editId = await insertJobDocumentEditWithAgentOnSql({
      sql: input.sql,
      run: input.run,
      target,
      responseContent: input.responseContent,
      agentId: input.run.target_agent_id,
    });
    await input.sql`release savepoint job_document_append_agent_fk`;
  } catch (err) {
    if (!input.run.target_agent_id || !isForeignKeyViolation(err)) throw err;
    await input.sql`rollback to savepoint job_document_append_agent_fk`;
    await input.sql`release savepoint job_document_append_agent_fk`;
    editId = await insertJobDocumentEditWithAgentOnSql({
      sql: input.sql,
      run: input.run,
      target,
      responseContent: input.responseContent,
      agentId: null,
    });
  }

  return {
    editId,
    documentId: target.document_id,
    tabId: target.tab_id,
  };
}

async function insertJobOutputReadyInboxItemOnSql(input: {
  sql: Sql;
  run: GreenfieldQueueRunRecord;
  job: GreenfieldJobOutputTargets;
  responseMessageId: string | null;
  documentEdit: InsertedJobDocumentEdit | null;
}): Promise<string> {
  const targetJson = {
    jobId: input.job.jobId,
    talkId: input.run.talk_id,
    runId: input.run.id,
    emittedMessageId: input.responseMessageId,
    emittedEditId: input.documentEdit?.editId ?? null,
  };
  const primaryAction = input.documentEdit
    ? {
        type: 'open_document_edit',
        talkId: input.run.talk_id,
        documentId: input.documentEdit.documentId,
        editId: input.documentEdit.editId,
      }
    : {
        type: 'open_talk_run',
        talkId: input.run.talk_id,
        runId: input.run.id,
      };
  const rows = await input.sql<{ id: string }[]>`
    insert into public.home_inbox_items (
      workspace_id,
      type,
      target_kind,
      target_json,
      talk_id,
      document_id,
      run_id,
      tab_id,
      job_id,
      ref_id,
      severity,
      title,
      summary,
      reason,
      primary_action_json,
      group_key
    )
    values (
      ${input.run.workspace_id}::uuid,
      'job_output_ready',
      'job',
      ${input.sql.json(targetJson as never)},
      ${input.run.talk_id}::uuid,
      ${input.documentEdit?.documentId ?? null}::uuid,
      ${input.run.id}::uuid,
      ${input.documentEdit?.tabId ?? null}::uuid,
      ${input.job.jobId}::uuid,
      ${input.run.id}::uuid,
      'info',
      ${`${input.job.title} finished`},
      ${
        input.documentEdit
          ? 'The job proposed a Document edit for review.'
          : 'The job posted a Talk message.'
      },
      'job_run_completed',
      ${input.sql.json(primaryAction as never)},
      ${`job:${input.job.jobId}:output`}
    )
    on conflict (workspace_id, type, ref_id) where ref_id is not null
    do update set updated_at = public.home_inbox_items.updated_at
    returning id
  `;
  return rows[0]!.id;
}

export async function getGreenfieldQueueRunById(
  runId: string,
): Promise<GreenfieldQueueRunRecord | null> {
  const db = getDbPg();
  const rows = await db<GreenfieldQueueRunRecord[]>`
    select
      r.id,
      r.workspace_id,
      r.talk_id,
      r.talk_id as thread_id,
      r.round,
      r.run_kind,
      r.snapshot_group_id,
      r.agent_snapshot_id,
      r.status,
      tas.provider_id,
      tas.model_id,
      r.requested_by,
      r.trigger_message_id,
      r.job_id,
      r.trigger,
      t.mode as talk_mode,
      r.response_group_id,
      r.sequence_index,
      r.error_json,
      r.started_at,
      r.finished_at,
      r.created_at,
      tas.source_agent_id as target_agent_id,
      tas.name as target_agent_name,
      coalesce(
        array_agg(wm.user_id order by wm.created_at asc)
          filter (where wm.user_id is not null),
        '{}'::uuid[]
      )::text[] as owner_ids
    from public.runs r
    join public.talks t
      on t.workspace_id = r.workspace_id
     and t.id = r.talk_id
    join public.talk_agent_snapshots tas
      on tas.workspace_id = r.workspace_id
     and tas.talk_id = r.talk_id
     and tas.id = r.agent_snapshot_id
    left join public.workspace_members wm
      on wm.workspace_id = r.workspace_id
    where r.id = ${runId}::uuid
    group by r.id, t.mode, tas.source_agent_id, tas.name, tas.provider_id, tas.model_id
    limit 1
  `;
  return rows[0] ?? null;
}

export async function getGreenfieldTriggerMessageById(
  messageId: string,
): Promise<GreenfieldTriggerMessageRecord | null> {
  const db = getDbPg();
  const rows = await db<GreenfieldTriggerMessageRecord[]>`
    select id, workspace_id, talk_id, body
    from public.messages
    where id = ${messageId}::uuid
    limit 1
  `;
  return rows[0] ?? null;
}

export async function getGreenfieldRunPromptSnapshotText(
  runId: string,
): Promise<string | null> {
  const db = getDbPg();
  const rows = await db<{ prompt_text_redacted: string | null }[]>`
    select rps.prompt_text_redacted
    from public.runs r
    join public.run_prompt_snapshots rps
      on rps.workspace_id = r.workspace_id
     and rps.id = r.prompt_snapshot_id
    where r.id = ${runId}::uuid
    limit 1
  `;
  return rows[0]?.prompt_text_redacted ?? null;
}

export async function markGreenfieldRunRunning(
  runId: string,
): Promise<MarkGreenfieldRunRunningResult> {
  const existing = await getGreenfieldQueueRunById(runId);
  if (!existing) return { status: 'not_found' };
  if (existing.status === 'running') return { status: 'already_running' };
  if (existing.status !== 'queued') return { status: 'terminal' };

  const db = getDbPg();
  if (existing.talk_mode === 'ordered' && existing.sequence_index > 0) {
    const blocking = await db<{ id: string }[]>`
      select id
      from public.runs prior
      where prior.workspace_id = ${existing.workspace_id}::uuid
        and prior.talk_id = ${existing.talk_id}::uuid
        and prior.response_group_id = ${existing.response_group_id}
        and prior.sequence_index < ${existing.sequence_index}
        and prior.status not in ${db(terminalStatuses())}
      limit 1
    `;
    if (blocking.length > 0) return { status: 'blocked_by_sibling' };
  }

  const pendingNotify = await withTrustedDbWrites(() =>
    db.begin(async (tx) => {
      const txSql = tx as unknown as Sql;
      const claimedRows = await txSql<{ id: string }[]>`
        update public.runs
        set
          status = 'running',
          started_at = now(),
          finished_at = null,
          error_json = null
        where id = ${runId}::uuid
          and status = 'queued'
        returning id
      `;
      if (claimedRows.length !== 1) return null;

      const eventId = await emitOutboxEventOnSql(txSql, {
        topic: `talk:${existing.talk_id}`,
        eventType: 'talk_run_started',
        payload: {
          talkId: existing.talk_id,
          threadId: existing.thread_id,
          runId: existing.id,
          runKind: existing.run_kind,
          triggerMessageId: existing.trigger_message_id,
          targetAgentId: existing.target_agent_id,
          targetAgentNickname: existing.target_agent_name,
          responseGroupId: existing.response_group_id,
          sequenceIndex: existing.sequence_index,
          status: 'running',
          executorAlias: existing.target_agent_name,
          executorModel: existing.model_id,
          providerId: existing.provider_id,
        },
        ownerIds: existing.owner_ids,
      });
      return {
        topic: `talk:${existing.talk_id}`,
        eventId,
        ownerIds: existing.owner_ids,
      } satisfies PendingOutboxNotify;
    }),
  );
  if (!pendingNotify) return { status: 'already_running' };

  const claimed = await getGreenfieldQueueRunById(runId);
  if (!claimed) return { status: 'not_found' };
  enqueueOutboxNotify(pendingNotify);
  return { status: 'claimed', run: claimed };
}

export async function completeGreenfieldRun(input: {
  runId: string;
  responseMessageId: string;
  responseContent: string;
  responseMetadata?: Record<string, unknown> | null;
  agentId?: string | null;
  agentNickname?: string | null;
  providerId?: string | null;
  modelId?: string | null;
  latencyMs?: number | null;
  usage?: TalkExecutionUsage | null;
  responseSequenceInRun?: number | null;
}): Promise<{ applied: boolean; talkId: string | null }> {
  const db = getDbPg();
  const run = await getGreenfieldQueueRunById(input.runId);
  if (!run || run.status !== 'running') {
    return { applied: false, talkId: run?.talk_id ?? null };
  }

  const pendingNotifies = await withTrustedDbWrites(() =>
    db.begin(async (tx) => {
      const txSql = tx as unknown as Sql;
      const updated = await txSql<{ id: string }[]>`
      update public.runs
      set
        status = 'completed',
        finished_at = now(),
        tokens_in = coalesce(${input.usage?.inputTokens ?? null}, tokens_in),
        tokens_out = coalesce(${input.usage?.outputTokens ?? null}, tokens_out),
        error_json = null
      where id = ${input.runId}::uuid
        and status = 'running'
      returning id
    `;
      if (updated.length !== 1) return null;

      const jobOutputTargets = await getJobOutputTargetsOnSql(txSql, run);
      const clientMetadata = messageAppendedMetadata(input.responseMetadata, {
        providerId: run.provider_id,
        modelId: run.model_id,
      });
      let responseMessage: { id: string; created_at: string } | null = null;
      const shouldEmitTalkMessage =
        !jobOutputTargets || jobOutputTargets.emitTalkMessage;
      if (shouldEmitTalkMessage) {
        const messages = await txSql<Array<{ id: string; created_at: string }>>`
          insert into public.messages (
            id,
            workspace_id,
            talk_id,
            round,
            author_kind,
            agent_snapshot_id,
            run_id,
            body,
            metadata_json
          )
          values (
            ${input.responseMessageId}::uuid,
            ${run.workspace_id}::uuid,
            ${run.talk_id}::uuid,
            ${run.round},
            'agent',
            ${run.agent_snapshot_id}::uuid,
            ${run.id}::uuid,
            ${input.responseContent},
            ${txSql.json(clientMetadata as never)}
          )
          returning id, created_at
        `;
        responseMessage = messages[0]!;
        const providerReplay = messageProviderReplayData(
          input.responseMetadata,
        );
        const replaySourceAgentId = run.target_agent_id;
        if (
          providerReplay &&
          replaySourceAgentId &&
          fitsProviderReplayBudget(providerReplay)
        ) {
          await txSql`
          insert into public.message_provider_replay (
            workspace_id,
            talk_id,
            message_id,
            run_id,
            source_agent_id,
            provider_id,
            model_id,
            provider_data_json
          )
          values (
            ${run.workspace_id}::uuid,
            ${run.talk_id}::uuid,
            ${responseMessage.id}::uuid,
            ${run.id}::uuid,
            ${replaySourceAgentId}::uuid,
            ${run.provider_id},
            ${run.model_id},
            ${txSql.json(providerReplay as never)}
          )
          on conflict (workspace_id, message_id) do update set
            run_id = excluded.run_id,
            source_agent_id = excluded.source_agent_id,
            provider_id = excluded.provider_id,
            model_id = excluded.model_id,
            provider_data_json = excluded.provider_data_json
        `;
        }
      }

      const documentEdit =
        jobOutputTargets?.emitDocumentAppend === true
          ? await insertJobDocumentAppendOnSql({
              sql: txSql,
              run,
              responseContent: input.responseContent,
            })
          : null;

      await txSql`
      update public.talks
      set last_activity_at = now()
      where workspace_id = ${run.workspace_id}::uuid
        and id = ${run.talk_id}::uuid
    `;
      await updateJobTerminalBookkeepingOnSql(txSql, run, 'completed');

      const notifies: PendingOutboxNotify[] = [];
      if (responseMessage) {
        const messageAppendedEventId = await emitOutboxEventOnSql(txSql, {
          topic: `talk:${run.talk_id}`,
          eventType: 'message_appended',
          payload: {
            talkId: run.talk_id,
            threadId: run.thread_id,
            messageId: responseMessage.id,
            runId: run.id,
            role: 'assistant',
            agentId: input.agentId ?? run.target_agent_id,
            agentNickname: input.agentNickname ?? run.target_agent_name,
            content: input.responseContent,
            createdAt: responseMessage.created_at,
            metadata: clientMetadata,
          },
          ownerIds: run.owner_ids,
        });
        notifies.push({
          topic: `talk:${run.talk_id}`,
          eventId: messageAppendedEventId,
          ownerIds: run.owner_ids,
        });
      }

      const runCompletedEventId = await emitOutboxEventOnSql(txSql, {
        topic: `talk:${run.talk_id}`,
        eventType: 'talk_run_completed',
        payload: {
          talkId: run.talk_id,
          threadId: run.thread_id,
          runId: run.id,
          runKind: run.run_kind,
          triggerMessageId: run.trigger_message_id,
          responseMessageId: responseMessage?.id ?? null,
          responseGroupId: run.response_group_id,
          sequenceIndex: run.sequence_index,
          executorAlias: input.agentNickname ?? run.target_agent_name,
          executorModel: run.model_id,
          providerId: run.provider_id,
        },
        ownerIds: run.owner_ids,
      });
      notifies.push({
        topic: `talk:${run.talk_id}`,
        eventId: runCompletedEventId,
        ownerIds: run.owner_ids,
      });

      if (jobOutputTargets) {
        const inboxItemId = await insertJobOutputReadyInboxItemOnSql({
          sql: txSql,
          run,
          job: jobOutputTargets,
          responseMessageId: responseMessage?.id ?? null,
          documentEdit,
        });
        for (const ownerId of run.owner_ids) {
          const eventId = await emitOutboxEventOnSql(txSql, {
            topic: `user:${ownerId}`,
            eventType: 'job_output_ready',
            payload: {
              jobId: jobOutputTargets.jobId,
              runId: run.id,
              talkId: run.talk_id,
              emittedMessageId: responseMessage?.id ?? undefined,
              emittedEditId: documentEdit?.editId ?? undefined,
              inboxItemId,
            },
            ownerIds: [ownerId],
          });
          notifies.push({
            topic: `user:${ownerId}`,
            eventId,
            ownerIds: [ownerId],
          });
        }
      }

      return notifies;
    }),
  );
  if (pendingNotifies) {
    for (const notify of pendingNotifies) {
      enqueueOutboxNotify(notify);
    }
  }
  return { applied: pendingNotifies !== null, talkId: run.talk_id };
}

export async function failGreenfieldRun(input: {
  runId: string;
  errorCode: string;
  errorMessage: string;
  metadataPatch?: Record<string, unknown> | null;
}): Promise<{ applied: boolean; talkId: string | null }> {
  const db = getDbPg();
  const run = await getGreenfieldQueueRunById(input.runId);
  if (!run || run.status !== 'running') {
    return { applied: false, talkId: run?.talk_id ?? null };
  }
  let pendingNotify: PendingOutboxNotify | null;
  try {
    pendingNotify = await withTrustedDbWrites(() =>
      db.begin(async (tx) => {
        const txSql = tx as unknown as Sql;
        const failed = await txSql<{ id: string }[]>`
          update public.runs
          set
            status = 'failed',
            finished_at = now(),
            error_json = ${txSql.json(
              errorJson({
                code: input.errorCode,
                message: input.errorMessage,
                metadata: input.metadataPatch,
              }) as never,
            )}
          where id = ${input.runId}::uuid
            and status = 'running'
          returning id
        `;
        if (failed.length !== 1) return null;
        await updateJobTerminalBookkeepingOnSql(txSql, run, 'failed');

        const eventId = await emitOutboxEventOnSql(txSql, {
          topic: `talk:${run.talk_id}`,
          eventType: 'talk_run_failed',
          payload: {
            talkId: run.talk_id,
            threadId: run.thread_id,
            runId: run.id,
            runKind: run.run_kind,
            triggerMessageId: run.trigger_message_id,
            responseGroupId: run.response_group_id,
            sequenceIndex: run.sequence_index,
            errorCode: input.errorCode,
            errorMessage: input.errorMessage,
            executorAlias: run.target_agent_name,
            executorModel: run.model_id,
            providerId: run.provider_id,
          },
          ownerIds: run.owner_ids,
        });
        return {
          topic: `talk:${run.talk_id}`,
          eventId,
          ownerIds: run.owner_ids,
        } satisfies PendingOutboxNotify;
      }),
    );
  } catch (err) {
    const reset = await withTrustedDbWrites(
      () => db<{ id: string }[]>`
        update public.runs
        set
          status = 'queued',
          started_at = null,
          finished_at = null,
          error_json = ${db.json(
            errorJson({
              code: 'failure_finalization_retry',
              message:
                'Run failure finalization failed before outbox commit; queue retry required.',
              metadata: {
                originalErrorCode: input.errorCode,
              },
            }) as never,
          )}
        where id = ${input.runId}::uuid
          and status = 'running'
        returning id
      `,
    );
    logger.warn(
      { err, runId: run.id, resetForRetry: reset.length === 1 },
      'failGreenfieldRun: failed to finalize run failure atomically; re-queued for retry if possible',
    );
    throw err;
  }
  if (!pendingNotify) return { applied: false, talkId: run.talk_id };
  enqueueOutboxNotify(pendingNotify);
  return { applied: true, talkId: run.talk_id };
}

export async function findNextGreenfieldRunnableOrderedSibling(input: {
  workspaceId: string;
  talkId: string;
  responseGroupId: string;
}): Promise<string | null> {
  const db = getDbPg();
  const rows = await db<{ id: string }[]>`
    select r.id
    from public.runs r
    where r.workspace_id = ${input.workspaceId}::uuid
      and r.talk_id = ${input.talkId}::uuid
      and r.response_group_id = ${input.responseGroupId}
      and r.status = 'queued'
      and not exists (
        select 1
        from public.runs prior
        where prior.workspace_id = r.workspace_id
          and prior.talk_id = r.talk_id
          and prior.response_group_id = r.response_group_id
          and prior.sequence_index < r.sequence_index
          and prior.status not in ${db(terminalStatuses())}
      )
    order by r.sequence_index asc
    limit 1
  `;
  return rows[0]?.id ?? null;
}

export async function failGreenfieldDlqRun(input: {
  runId: string;
}): Promise<'missing' | 'terminal' | 'failed'> {
  const db = getDbPg();
  const run = await getGreenfieldQueueRunById(input.runId);
  if (!run) return 'missing';
  if (run.status !== 'queued' && run.status !== 'running') return 'terminal';

  let pendingNotify: PendingOutboxNotify | null;
  pendingNotify = await withTrustedDbWrites(() =>
    db.begin(async (tx) => {
      const txSql = tx as unknown as Sql;
      const updated = await txSql<{ id: string }[]>`
        update public.runs
        set
          status = 'failed',
          finished_at = now(),
          error_json = ${txSql.json(
            errorJson({
              code: 'dlq_exhausted',
              message: 'Queue retries exhausted; run failed.',
            }) as never,
          )}
        where id = ${input.runId}::uuid
          and status in ('queued', 'running')
        returning id
      `;
      if (updated.length !== 1) return null;
      await updateJobTerminalBookkeepingOnSql(txSql, run, 'failed');

      const eventId = await emitOutboxEventOnSql(txSql, {
        topic: `talk:${run.talk_id}`,
        eventType: 'talk_run_failed',
        payload: {
          talkId: run.talk_id,
          threadId: run.thread_id,
          runId: run.id,
          runKind: run.run_kind,
          triggerMessageId: run.trigger_message_id,
          errorCode: 'dlq_exhausted',
          errorMessage: 'Queue retries exhausted; run failed.',
          executorAlias: run.target_agent_name,
          executorModel: run.model_id,
          providerId: run.provider_id,
        },
        ownerIds: run.owner_ids,
      });
      return {
        topic: `talk:${run.talk_id}`,
        eventId,
        ownerIds: run.owner_ids,
      } satisfies PendingOutboxNotify;
    }),
  );
  if (!pendingNotify) return 'terminal';
  enqueueOutboxNotify(pendingNotify);
  return 'failed';
}
