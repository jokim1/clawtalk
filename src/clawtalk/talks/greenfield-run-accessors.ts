import { getDbPg } from '../../db.js';
import { emitOutboxEvent } from './outbox-emit.js';
import type { TalkExecutionUsage } from './executor.js';

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
  round: number;
  run_kind: 'conversation' | 'content_improvement';
  snapshot_group_id: string;
  agent_snapshot_id: string;
  status: GreenfieldRunStatus;
  model_id: string;
  requested_by: string;
  trigger_message_id: string | null;
  job_id: string | null;
  trigger: 'user' | 'scheduler' | 'manual';
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

function terminalStatuses(): GreenfieldRunStatus[] {
  return ['completed', 'failed', 'cancelled'];
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

export async function getGreenfieldQueueRunById(
  runId: string,
): Promise<GreenfieldQueueRunRecord | null> {
  const db = getDbPg();
  const rows = await db<GreenfieldQueueRunRecord[]>`
    select
      r.id,
      r.workspace_id,
      r.talk_id,
      r.round,
      r.run_kind,
      r.snapshot_group_id,
      r.agent_snapshot_id,
      r.status,
      r.model_id,
      r.requested_by,
      r.trigger_message_id,
      r.job_id,
      r.trigger,
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
    join public.talk_agent_snapshots tas
      on tas.workspace_id = r.workspace_id
     and tas.talk_id = r.talk_id
     and tas.id = r.agent_snapshot_id
    left join public.workspace_members wm
      on wm.workspace_id = r.workspace_id
    where r.id = ${runId}::uuid
    group by r.id, tas.source_agent_id, tas.name
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

export async function markGreenfieldRunRunning(
  runId: string,
): Promise<MarkGreenfieldRunRunningResult> {
  const existing = await getGreenfieldQueueRunById(runId);
  if (!existing) return { status: 'not_found' };
  if (existing.status === 'running') return { status: 'already_running' };
  if (existing.status !== 'queued') return { status: 'terminal' };

  const db = getDbPg();
  const blocking = await db<{ id: string }[]>`
    select id
    from public.runs prior
    where prior.workspace_id = ${existing.workspace_id}::uuid
      and prior.response_group_id = ${existing.response_group_id}
      and prior.sequence_index < ${existing.sequence_index}
      and prior.status not in ${db(terminalStatuses())}
    limit 1
  `;
  if (blocking.length > 0) return { status: 'blocked_by_sibling' };

  const claimedRows = await db<{ id: string }[]>`
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
  if (claimedRows.length !== 1) return { status: 'already_running' };

  const claimed = await getGreenfieldQueueRunById(runId);
  if (!claimed) return { status: 'not_found' };
  await emitOutboxEvent({
    topic: `talk:${claimed.talk_id}`,
    eventType: 'talk_run_started',
    payload: {
      talkId: claimed.talk_id,
      threadId: claimed.talk_id,
      runId: claimed.id,
      runKind: claimed.run_kind,
      triggerMessageId: claimed.trigger_message_id,
      targetAgentId: claimed.target_agent_id,
      targetAgentNickname: claimed.target_agent_name,
      responseGroupId: claimed.response_group_id,
      sequenceIndex: claimed.sequence_index,
      status: 'running',
      executorAlias: claimed.target_agent_name,
      executorModel: claimed.model_id,
    },
    ownerIds: claimed.owner_ids,
  });
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

  const updated = await db<{ id: string }[]>`
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
  if (updated.length !== 1) return { applied: false, talkId: run.talk_id };

  const messages = await db<Array<{ id: string; created_at: string }>>`
    insert into public.messages (
      id,
      workspace_id,
      talk_id,
      round,
      author_kind,
      agent_snapshot_id,
      run_id,
      body
    )
    values (
      ${input.responseMessageId}::uuid,
      ${run.workspace_id}::uuid,
      ${run.talk_id}::uuid,
      ${run.round},
      'agent',
      ${run.agent_snapshot_id}::uuid,
      ${run.id}::uuid,
      ${input.responseContent}
    )
    returning id, created_at
  `;
  const responseMessage = messages[0]!;

  await db`
    update public.talks
    set last_activity_at = now()
    where workspace_id = ${run.workspace_id}::uuid
      and id = ${run.talk_id}::uuid
  `;

  await emitOutboxEvent({
    topic: `talk:${run.talk_id}`,
    eventType: 'message_appended',
    payload: {
      talkId: run.talk_id,
      threadId: run.talk_id,
      messageId: responseMessage.id,
      runId: run.id,
      role: 'assistant',
      agentId: input.agentId ?? run.target_agent_id,
      agentNickname: input.agentNickname ?? run.target_agent_name,
      content: input.responseContent,
      createdAt: responseMessage.created_at,
      metadata: input.responseMetadata ?? null,
    },
    ownerIds: run.owner_ids,
  });

  await emitOutboxEvent({
    topic: `talk:${run.talk_id}`,
    eventType: 'talk_run_completed',
    payload: {
      talkId: run.talk_id,
      threadId: run.talk_id,
      runId: run.id,
      runKind: run.run_kind,
      triggerMessageId: run.trigger_message_id,
      responseMessageId: responseMessage.id,
      responseGroupId: run.response_group_id,
      sequenceIndex: run.sequence_index,
      executorAlias: input.agentNickname ?? run.target_agent_name,
      executorModel: input.modelId ?? run.model_id,
      providerId: input.providerId ?? null,
    },
    ownerIds: run.owner_ids,
  });
  return { applied: true, talkId: run.talk_id };
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
  const failed = await db<{ id: string }[]>`
    update public.runs
    set
      status = 'failed',
      finished_at = now(),
      error_json = ${db.json(
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
  if (failed.length !== 1) return { applied: false, talkId: run.talk_id };

  await emitOutboxEvent({
    topic: `talk:${run.talk_id}`,
    eventType: 'talk_run_failed',
    payload: {
      talkId: run.talk_id,
      threadId: run.talk_id,
      runId: run.id,
      runKind: run.run_kind,
      triggerMessageId: run.trigger_message_id,
      responseGroupId: run.response_group_id,
      sequenceIndex: run.sequence_index,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      executorAlias: run.target_agent_name,
      executorModel: run.model_id,
    },
    ownerIds: run.owner_ids,
  });
  return { applied: true, talkId: run.talk_id };
}

export async function findNextGreenfieldRunnableOrderedSibling(input: {
  workspaceId: string;
  responseGroupId: string;
}): Promise<string | null> {
  const db = getDbPg();
  const rows = await db<{ id: string }[]>`
    select r.id
    from public.runs r
    where r.workspace_id = ${input.workspaceId}::uuid
      and r.response_group_id = ${input.responseGroupId}
      and r.status = 'queued'
      and not exists (
        select 1
        from public.runs prior
        where prior.workspace_id = r.workspace_id
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

  const updated = await db<{ id: string }[]>`
    update public.runs
    set
      status = 'failed',
      finished_at = now(),
      error_json = ${db.json(
        errorJson({
          code: 'dlq_exhausted',
          message: 'Queue retries exhausted; run failed.',
        }) as never,
      )}
    where id = ${input.runId}::uuid
      and status in ('queued', 'running')
    returning id
  `;
  if (updated.length !== 1) return 'terminal';

  await emitOutboxEvent({
    topic: `talk:${run.talk_id}`,
    eventType: 'talk_run_failed',
    payload: {
      talkId: run.talk_id,
      threadId: run.talk_id,
      runId: run.id,
      runKind: run.run_kind,
      triggerMessageId: run.trigger_message_id,
      errorCode: 'dlq_exhausted',
      errorMessage: 'Queue retries exhausted; run failed.',
      executorAlias: run.target_agent_name,
      executorModel: run.model_id,
    },
    ownerIds: run.owner_ids,
  });
  return 'failed';
}
