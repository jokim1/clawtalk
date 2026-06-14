import { randomUUID } from 'node:crypto';

import { getDbPg, type Sql, withTrustedDbWrites } from '../../db.js';
import {
  buildEffectiveToolsFromTalkToolRows,
  listUserToolPermissionsForUser,
  normalizeTalkToolFamiliesFromRows,
  type RegisteredAgentRecord,
} from '../db/agent-accessors.js';
import { resolveCredentialKindSnapshot } from '../agents/execution-resolver.js';
import { withGreenfieldDocumentEditToolAccess } from './greenfield-document-tools.js';
import { emitOutboxEventOnSql, enqueueOutboxNotify } from './outbox-emit.js';
import type { GreenfieldMessageRecord } from './greenfield-detail-accessors.js';

type GreenfieldRunStatus =
  | 'queued'
  | 'running'
  | 'awaiting'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface GreenfieldChatRunRecord {
  id: string;
  talk_id: string;
  status: GreenfieldRunStatus;
  response_group_id: string | null;
  sequence_index: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  trigger_message_id: string | null;
  target_agent_id: string | null;
  target_agent_name: string | null;
  provider_id: string;
  model_id: string;
  error_json: unknown;
}

interface GreenfieldChatRosterAgentRecord {
  id: string;
  role_key: string;
  name: string;
  handle: string;
  initials: string;
  accent: string;
  accent_dark: string | null;
  model_id: string;
  provider_id: string | null;
  temperature: string | number;
  persona: string | null;
  focus: string | null;
  method: string[];
  sort_order: number;
  created_from_template_version: number | null;
  credential_mode: 'api_key' | 'subscription' | null;
}

interface PendingOutboxNotify {
  topic: string;
  eventId: number;
  ownerIds: string[];
}

interface GreenfieldChatAgentWriteRow {
  ordinal: number;
  prompt_snapshot_id: string;
  source_agent_id: string;
  role_key: string;
  name: string;
  handle: string;
  initials: string;
  accent: string;
  accent_dark: string | null;
  provider_id: string;
  model_id: string;
  temperature: string;
  persona: string | null;
  focus: string | null;
  method_json: string[];
  sort_order: number;
  role_template_version: number | null;
  tool_manifest_json: Record<string, unknown>;
}

interface BatchedOutboxEventInput {
  topic: string;
  eventType: string;
  payload: Record<string, unknown>;
}

function uniqueOwnerIds(
  rows: Array<{ user_id: string }>,
  fallbackUserId: string,
): string[] {
  const ids = new Set(rows.map((row) => row.user_id).filter(Boolean));
  ids.add(fallbackUserId);
  return Array.from(ids);
}

async function listWorkspaceNotifyOwnerIdsOnSql(input: {
  sql: Sql;
  workspaceId: string;
  fallbackUserId: string;
}): Promise<string[]> {
  const rows = await withTrustedDbWrites(
    () => input.sql<Array<{ user_id: string }>>`
      select user_id::text as user_id
      from public.workspace_members
      where workspace_id = ${input.workspaceId}::uuid
      order by created_at asc, user_id asc
    `,
  );
  return uniqueOwnerIds(rows, input.fallbackUserId);
}

async function withExistingOrNewTransaction<T>(
  db: Sql,
  fn: (txSql: Sql) => Promise<T>,
): Promise<T> {
  const maybeTransaction = db as Sql & { savepoint?: unknown };
  if (
    typeof maybeTransaction.savepoint === 'function' ||
    typeof maybeTransaction.begin !== 'function'
  ) {
    return fn(db);
  }
  return (await maybeTransaction.begin(async (tx) =>
    fn(tx as unknown as Sql),
  )) as T;
}

function toCredentialSnapshotAgent(
  agent: GreenfieldChatRosterAgentRecord,
  ownerId: string,
): RegisteredAgentRecord {
  if (!agent.provider_id) {
    throw new Error(
      'Cannot snapshot credentials for an agent without provider',
    );
  }
  return {
    id: agent.id,
    owner_id: ownerId,
    name: agent.name,
    provider_id: agent.provider_id,
    model_id: agent.model_id,
    persona_role: agent.role_key,
    system_prompt: null,
    description: agent.focus,
    enabled: true,
    credential_mode: agent.credential_mode,
    model_auto_upgraded_from: null,
    model_auto_upgraded_at: null,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  };
}

async function insertGreenfieldRunBatchOnSql(input: {
  sql: Sql;
  workspaceId: string;
  talkId: string;
  userId: string;
  round: number;
  messageId: string;
  responseGroupId: string;
  snapshotGroupId: string;
  rows: GreenfieldChatAgentWriteRow[];
  // Talk Runtime v2 PR-B: the dispatch-runtime marker for these runs.
  runtime: 'queue' | 'do';
}): Promise<GreenfieldChatRunRecord[]> {
  if (input.rows.length === 0) return [];
  const rows = await input.sql<GreenfieldChatRunRecord[]>`
    with input_rows as (
      select *
      from jsonb_to_recordset(${input.sql.json(input.rows as never)}::jsonb)
        as input_rows (
          ordinal int,
          prompt_snapshot_id uuid,
          source_agent_id uuid,
          role_key text,
          name text,
          handle text,
          initials text,
          accent text,
          accent_dark text,
          provider_id text,
          model_id text,
          temperature text,
          persona text,
          focus text,
          method_json jsonb,
          sort_order int,
          role_template_version int,
          tool_manifest_json jsonb
        )
    ),
    inserted_snapshots as (
      insert into public.talk_agent_snapshots (
        workspace_id,
        talk_id,
        snapshot_group_id,
        source_agent_id,
        role_key,
        name,
        handle,
        initials,
        accent,
        accent_dark,
        provider_id,
        model_id,
        temperature,
        persona,
        focus,
        method,
        sort_order,
        role_template_version
      )
      select
        ${input.workspaceId}::uuid,
        ${input.talkId}::uuid,
        ${input.snapshotGroupId}::uuid,
        i.source_agent_id,
        i.role_key,
        i.name,
        i.handle,
        i.initials,
        i.accent,
        i.accent_dark,
        i.provider_id,
        i.model_id,
        i.temperature::numeric,
        i.persona,
        i.focus,
        array(select jsonb_array_elements_text(i.method_json)),
        i.sort_order,
        i.role_template_version
      from input_rows i
      order by i.ordinal asc
      returning id, model_id, source_agent_id
    ),
    inserted_runs as (
      insert into public.runs (
        workspace_id,
        talk_id,
        round,
        snapshot_group_id,
        agent_snapshot_id,
        model_id,
        requested_by,
        trigger,
        trigger_message_id,
        response_group_id,
        sequence_index,
        prompt_snapshot_id,
        status,
        runtime
      )
      select
        ${input.workspaceId}::uuid,
        ${input.talkId}::uuid,
        ${input.round},
        ${input.snapshotGroupId}::uuid,
        s.id,
        s.model_id,
        ${input.userId}::uuid,
        'user',
        ${input.messageId}::uuid,
        ${input.responseGroupId},
        i.ordinal,
        i.prompt_snapshot_id,
        'queued',
        ${input.runtime}
      from input_rows i
      join inserted_snapshots s
        on s.source_agent_id = i.source_agent_id
      order by i.ordinal asc
      returning
        id,
        talk_id,
        status,
        response_group_id,
        sequence_index,
        created_at,
        started_at,
        finished_at,
        trigger_message_id,
        model_id,
        error_json,
        agent_snapshot_id,
        prompt_snapshot_id
    ),
    inserted_prompt_snapshots as (
      insert into public.run_prompt_snapshots (
        id,
        workspace_id,
        run_id,
        talk_id,
        agent_snapshot_id,
        model_id,
        provider,
        role_template_version,
        prompt_assembly_version,
        tool_manifest_json
      )
      select
        i.prompt_snapshot_id,
        ${input.workspaceId}::uuid,
        r.id,
        ${input.talkId}::uuid,
        r.agent_snapshot_id,
        r.model_id,
        i.provider_id,
        i.role_template_version,
        1,
        i.tool_manifest_json
      from inserted_runs r
      join input_rows i
        on i.prompt_snapshot_id = r.prompt_snapshot_id
      order by i.ordinal asc
      returning run_id
    )
    select
      r.id,
      r.talk_id,
      r.status,
      r.response_group_id,
      r.sequence_index,
      r.created_at,
      r.started_at,
      r.finished_at,
      r.trigger_message_id,
      i.source_agent_id::text as target_agent_id,
      i.name as target_agent_name,
      i.provider_id,
      r.model_id,
      r.error_json
    from inserted_runs r
    join inserted_prompt_snapshots ps
      on ps.run_id = r.id
    join input_rows i
      on i.prompt_snapshot_id = r.prompt_snapshot_id
    order by r.sequence_index asc
  `;
  return rows;
}

async function insertOutboxEventsOnSql(
  sql: Sql,
  events: BatchedOutboxEventInput[],
): Promise<number[]> {
  if (events.length === 0) return [];
  const rows = await sql<Array<{ ordinal: number; event_id: number }>>`
    with input_events as (
      select *
      from jsonb_to_recordset(${sql.json(
        events.map((event, ordinal) => ({
          ordinal,
          topic: event.topic,
          event_type: event.eventType,
          payload: event.payload,
        })) as never,
      )}::jsonb)
        as input_events (
          ordinal int,
          topic text,
          event_type text,
          payload jsonb
        )
    ),
    sequenced_events as materialized (
      select
        ordinal,
        nextval('public.event_outbox_event_id_seq')::int as event_id,
        topic,
        event_type,
        payload
      from input_events
      order by ordinal asc
    ),
    inserted as (
      insert into public.event_outbox (event_id, topic, event_type, payload)
      select event_id, topic, event_type, payload
      from sequenced_events
      order by ordinal asc
      returning event_id::int as event_id
    )
    select s.ordinal, inserted.event_id
    from sequenced_events s
    join inserted
      on inserted.event_id = s.event_id
    order by s.ordinal asc
  `;
  if (rows.length !== events.length) {
    throw new Error('outbox_event_batch_return_count_mismatch');
  }
  return rows.map((row) => row.event_id);
}

export type EnqueueGreenfieldChatTurnResult =
  | {
      ok: true;
      talkId: string;
      message: GreenfieldMessageRecord;
      runs: GreenfieldChatRunRecord[];
    }
  | {
      ok: false;
      reason:
        | 'talk_not_found'
        | 'talk_archived'
        | 'talk_round_active'
        | 'talk_agent_not_found'
        | 'agent_model_not_found';
    };

export async function enqueueGreenfieldChatTurn(input: {
  workspaceId: string;
  talkId: string;
  userId: string;
  content: string;
  targetAgentIds?: string[] | null;
  // Talk Runtime v2 PR-B: which runtime the runs are dispatched to ('queue' v1
  // path, 'do' TalkRunner DO). Recorded on each run so the reconciliation cron
  // stays path-aware. Default 'queue' (flag OFF); PR-C flips the flag.
  runtime?: 'queue' | 'do';
}): Promise<EnqueueGreenfieldChatTurnResult> {
  const db = getDbPg();
  let pendingNotifies: PendingOutboxNotify[] = [];
  const result = await withExistingOrNewTransaction(db, async (txSql) => {
    const talks = await txSql<
      Array<{
        id: string;
        archived_at: string | null;
        mode: 'ordered' | 'parallel';
      }>
    >`
      select id, archived_at, mode
      from public.talks
      where workspace_id = ${input.workspaceId}::uuid
        and id = ${input.talkId}::uuid
      for update
    `;
    const talk = talks[0];
    if (!talk) return { ok: false, reason: 'talk_not_found' } as const;
    if (talk.archived_at) {
      return { ok: false, reason: 'talk_archived' } as const;
    }

    const active = await txSql<{ count: number }[]>`
      select count(*)::int as count
      from public.runs
      where workspace_id = ${input.workspaceId}::uuid
        and talk_id = ${input.talkId}::uuid
        and status in ('queued', 'running', 'awaiting')
    `;
    if ((active[0]?.count ?? 0) > 0) {
      return { ok: false, reason: 'talk_round_active' } as const;
    }

    const roster = await txSql<GreenfieldChatRosterAgentRecord[]>`
      select
        a.id,
        a.role_key,
        a.name,
        a.handle,
        a.initials,
        a.accent,
        a.accent_dark,
        a.model_id,
        lpm.provider_id,
        a.temperature,
        a.persona,
        a.focus,
        a.method,
        ta.sort_order,
        a.created_from_template_version,
        a.credential_mode
      from public.talk_agents ta
      join public.agents a
        on a.workspace_id = ta.workspace_id
       and a.id = ta.agent_id
      join public.talks t
        on t.workspace_id = ta.workspace_id
       and t.id = ta.talk_id
      left join lateral (
        select lpm.provider_id
        from public.llm_provider_models lpm
        join public.llm_providers lp
          on lp.id = lpm.provider_id
         and lp.enabled = true
        where lpm.model_id = a.model_id
          and lpm.enabled = true
        order by lpm.provider_id asc
        limit 1
      ) lpm on true
      where ta.workspace_id = ${input.workspaceId}::uuid
        and ta.talk_id = ${input.talkId}::uuid
        and a.enabled = true
        -- System agents (Buddy) may speak only in the system talk; regular
        -- talks never roster them.
        and (a.is_system = false or t.is_system = true)
      order by ta.sort_order asc, a.name asc, a.id asc
    `;

    const requestedTargetIds = Array.from(
      new Set(
        (input.targetAgentIds ?? []).map((id) => id.trim()).filter(Boolean),
      ),
    );
    const requestedTargetSet = new Set(requestedTargetIds);
    const selectedAgents =
      requestedTargetIds.length > 0
        ? roster.filter((agent) => requestedTargetSet.has(agent.id))
        : roster;
    if (
      selectedAgents.length === 0 ||
      selectedAgents.length !==
        (requestedTargetIds.length > 0
          ? requestedTargetIds.length
          : selectedAgents.length)
    ) {
      return { ok: false, reason: 'talk_agent_not_found' } as const;
    }
    if (selectedAgents.some((agent) => !agent.provider_id)) {
      return { ok: false, reason: 'agent_model_not_found' } as const;
    }

    const rounds = await txSql<{ round: number }[]>`
      select greatest(
        coalesce((
          select max(round)
          from public.messages
          where workspace_id = ${input.workspaceId}::uuid
            and talk_id = ${input.talkId}::uuid
        ), 0),
        coalesce((
          select max(round)
          from public.runs
          where workspace_id = ${input.workspaceId}::uuid
            and talk_id = ${input.talkId}::uuid
        ), 0)
      ) + 1 as round
    `;
    const round = rounds[0]?.round ?? 1;
    const responseGroupId = randomUUID();
    const snapshotGroupId = randomUUID();
    const toolRows = await txSql<{ tool_id: string; enabled: boolean }[]>`
      select tool_id, enabled
      from public.talk_tools
      where workspace_id = ${input.workspaceId}::uuid
        and talk_id = ${input.talkId}::uuid
    `;
    const activeToolFamilies = normalizeTalkToolFamiliesFromRows(toolRows);
    const userToolPermissions = await listUserToolPermissionsForUser(
      input.userId,
    );
    const attachedDocuments = await txSql<{ id: string }[]>`
      select id
      from public.documents
      where workspace_id = ${input.workspaceId}::uuid
        and primary_talk_id = ${input.talkId}::uuid
      limit 1
    `;
    const baseEffectiveTools = buildEffectiveToolsFromTalkToolRows(
      toolRows,
      userToolPermissions,
    );
    const effectiveTools =
      attachedDocuments.length > 0
        ? withGreenfieldDocumentEditToolAccess(baseEffectiveTools)
        : baseEffectiveTools;
    const toolManifest = {
      active: activeToolFamilies,
      effectiveTools,
    };
    const credentialKindSnapshots = new Map<string, string | null>();
    for (const agent of selectedAgents) {
      credentialKindSnapshots.set(
        agent.id,
        await resolveCredentialKindSnapshot(
          toCredentialSnapshotAgent(agent, input.userId),
          {
            principalUserId: input.userId,
            workspaceId: input.workspaceId,
          },
          txSql,
        ),
      );
    }

    let message: GreenfieldMessageRecord | null = null;
    let runs: GreenfieldChatRunRecord[] = [];

    await withTrustedDbWrites(async () => {
      const insertedMessages = await txSql<GreenfieldMessageRecord[]>`
          insert into public.messages (
            workspace_id, talk_id, round, author_kind, author_user_id, body
          )
          values (
            ${input.workspaceId}::uuid,
            ${input.talkId}::uuid,
            ${round},
            'user',
            ${input.userId}::uuid,
            ${input.content}
          )
          returning
            id,
            workspace_id,
            talk_id,
            round,
            author_kind,
            author_user_id,
            null::uuid as agent_id,
            null::text as agent_name,
            null::text as agent_role_key,
            run_id,
            body,
            created_at
        `;
      message = insertedMessages[0]!;
      const agentWriteRows = selectedAgents.map((agent, index) => {
        const providerId = agent.provider_id;
        if (!providerId) throw new Error('agent_provider_missing');
        return {
          ordinal: index,
          prompt_snapshot_id: randomUUID(),
          source_agent_id: agent.id,
          role_key: agent.role_key,
          name: agent.name,
          handle: agent.handle,
          initials: agent.initials,
          accent: agent.accent,
          accent_dark: agent.accent_dark,
          provider_id: providerId,
          model_id: agent.model_id,
          temperature: String(agent.temperature),
          persona: agent.persona,
          focus: agent.focus,
          method_json: agent.method,
          sort_order: agent.sort_order,
          role_template_version: agent.created_from_template_version,
          tool_manifest_json: {
            ...toolManifest,
            agentCredentialMode: credentialKindSnapshots.get(agent.id) ?? null,
          },
        } satisfies GreenfieldChatAgentWriteRow;
      });
      runs = await insertGreenfieldRunBatchOnSql({
        sql: txSql,
        workspaceId: input.workspaceId,
        talkId: input.talkId,
        userId: input.userId,
        round,
        messageId: message.id,
        responseGroupId,
        snapshotGroupId,
        rows: agentWriteRows,
        runtime: input.runtime ?? 'queue',
      });

      await txSql`
          update public.talks
          set last_activity_at = now()
          where workspace_id = ${input.workspaceId}::uuid
            and id = ${input.talkId}::uuid
        `;

      const ownerIds = await listWorkspaceNotifyOwnerIdsOnSql({
        sql: txSql,
        workspaceId: input.workspaceId,
        fallbackUserId: input.userId,
      });
      const topic = `talk:${input.talkId}`;
      const outboxEvents: BatchedOutboxEventInput[] = [
        {
          topic,
          eventType: 'message_appended',
          payload: {
            talkId: input.talkId,
            messageId: message.id,
            runId: null,
            role: 'user',
            createdBy: input.userId,
            content: input.content,
            createdAt: message.created_at,
          },
        },
        ...runs.map((run) => ({
          topic,
          eventType: 'talk_run_queued',
          payload: {
            talkId: input.talkId,
            runId: run.id,
            runKind: 'conversation',
            triggerMessageId: message!.id,
            targetAgentId: run.target_agent_id,
            targetAgentNickname: run.target_agent_name,
            responseGroupId: run.response_group_id,
            sequenceIndex: run.sequence_index,
            status: 'queued',
            executorAlias: run.target_agent_name,
            executorModel: run.model_id,
            providerId: run.provider_id,
          },
        })),
      ];
      const eventIds = await insertOutboxEventsOnSql(txSql, outboxEvents);
      pendingNotifies = eventIds.map((eventId) => ({
        topic,
        eventId,
        ownerIds,
      }));
    });
    if (!message) throw new Error('greenfield_message_insert_missing');
    return { ok: true, talkId: input.talkId, message, runs } as const;
  });

  for (const notify of pendingNotifies) {
    enqueueOutboxNotify(notify);
  }
  return result;
}

export async function cancelGreenfieldTalkRuns(input: {
  workspaceId: string;
  talkId: string;
  userId: string;
  includeJobRuns?: boolean;
}): Promise<{
  cancelledRuns: number;
  cancelledRunIds: string[];
  // Talk Runtime v2 PR-B: the subset of cancelled runs that were dispatched to
  // the TalkRunner DO (runs.runtime='do'). The caller pings those DOs so they
  // observe the cancel and stop streaming. Derived from the STORED marker, not a
  // fresh flag read — so a do→queue rollback mid-run still notifies the DO.
  doCancelledRunIds: string[];
}> {
  const db = getDbPg();
  let pendingNotify: PendingOutboxNotify | null = null;
  const updated = await withExistingOrNewTransaction(db, async (txSql) => {
    const authorization = await txSql<
      Array<{
        created_by: string;
        role: 'owner' | 'admin' | 'member' | 'guest';
      }>
    >`
      select t.created_by, wm.role
      from public.talks t
      join public.workspace_members wm
        on wm.workspace_id = t.workspace_id
       and wm.user_id = ${input.userId}::uuid
      where t.workspace_id = ${input.workspaceId}::uuid
        and t.id = ${input.talkId}::uuid
      limit 1
    `;
    const auth = authorization[0];
    if (!auth) return [];
    if (auth.role === 'guest') return [];
    const canCancelOwnedJobRuns = input.includeJobRuns === true;

    return withTrustedDbWrites(async () => {
      const rows = await txSql<
        { id: string; job_id: string | null; runtime: string }[]
      >`
      update public.runs r
      set
        status = 'cancelled',
        finished_at = coalesce(finished_at, now()),
        error_json = coalesce(error_json, '{}'::jsonb) || jsonb_build_object(
          'code', 'cancelled_by_user',
          'cancelledBy', ${input.userId}::text
        )
      where r.workspace_id = ${input.workspaceId}::uuid
        and r.talk_id = ${input.talkId}::uuid
        and r.status in ('queued', 'running', 'awaiting')
        and (
          r.job_id is null
          or (
            ${canCancelOwnedJobRuns}::boolean
            and exists (
              select 1
              from public.jobs j
              where j.workspace_id = r.workspace_id
                and j.id = r.job_id
                and j.created_by = ${input.userId}::uuid
            )
          )
        )
      returning r.id, r.job_id, r.runtime
    `;
      const runIds = rows.map((row) => row.id);
      for (const run of rows) {
        if (!run.job_id) continue;
        await txSql`
        update public.jobs
        set last_run_at = now(),
            last_run_status = 'cancelled',
            run_count = run_count + 1,
            claimed_at = null,
            updated_at = now()
        where workspace_id = ${input.workspaceId}::uuid
          and id = ${run.job_id}::uuid
      `;
      }
      if (runIds.length > 0) {
        const ownerIds = await listWorkspaceNotifyOwnerIdsOnSql({
          sql: txSql,
          workspaceId: input.workspaceId,
          fallbackUserId: input.userId,
        });
        const eventId = await emitOutboxEventOnSql(txSql, {
          topic: `talk:${input.talkId}`,
          eventType: 'talk_run_cancelled',
          payload: {
            talkId: input.talkId,
            cancelledBy: input.userId,
            runIds,
          },
          ownerIds,
        });
        pendingNotify = {
          topic: `talk:${input.talkId}`,
          eventId,
          ownerIds,
        };
      }
      return rows;
    });
  });
  if (pendingNotify) {
    enqueueOutboxNotify(pendingNotify);
  }
  const cancelledRunIds = updated.map((row) => row.id);
  const doCancelledRunIds = updated
    .filter((row) => row.runtime === 'do')
    .map((row) => row.id);
  return {
    cancelledRuns: cancelledRunIds.length,
    cancelledRunIds,
    doCancelledRunIds,
  };
}
