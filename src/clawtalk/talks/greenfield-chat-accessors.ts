import { randomUUID } from 'node:crypto';

import { getDbPg } from '../../db.js';
import { emitOutboxEvent } from './outbox-emit.js';
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
  temperature: string | number;
  persona: string | null;
  focus: string | null;
  method: string[];
  sort_order: number;
  created_from_template_version: number | null;
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
        | 'talk_agent_not_found';
    };

export async function enqueueGreenfieldChatTurn(input: {
  workspaceId: string;
  talkId: string;
  userId: string;
  content: string;
  targetAgentIds?: string[] | null;
}): Promise<EnqueueGreenfieldChatTurnResult> {
  const db = getDbPg();
  const talks = await db<
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
  if (!talk) return { ok: false, reason: 'talk_not_found' };
  if (talk.archived_at) return { ok: false, reason: 'talk_archived' };

  const active = await db<{ count: number }[]>`
    select count(*)::int as count
    from public.runs
    where workspace_id = ${input.workspaceId}::uuid
      and talk_id = ${input.talkId}::uuid
      and status in ('queued', 'running', 'awaiting')
  `;
  if ((active[0]?.count ?? 0) > 0) {
    return { ok: false, reason: 'talk_round_active' };
  }

  const roster = await db<GreenfieldChatRosterAgentRecord[]>`
    select
      a.id,
      a.role_key,
      a.name,
      a.handle,
      a.initials,
      a.accent,
      a.accent_dark,
      a.model_id,
      a.temperature,
      a.persona,
      a.focus,
      a.method,
      ta.sort_order,
      a.created_from_template_version
    from public.talk_agents ta
    join public.agents a
      on a.workspace_id = ta.workspace_id
     and a.id = ta.agent_id
    where ta.workspace_id = ${input.workspaceId}::uuid
      and ta.talk_id = ${input.talkId}::uuid
      and a.enabled = true
      and a.is_system = false
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
    return { ok: false, reason: 'talk_agent_not_found' };
  }

  const rounds = await db<{ round: number }[]>`
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

  const insertedMessages = await db<GreenfieldMessageRecord[]>`
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
      attachments_json,
      created_at
  `;
  const message = insertedMessages[0]!;
  const runs: GreenfieldChatRunRecord[] = [];

  for (const [index, agent] of selectedAgents.entries()) {
    const snapshots = await db<{ id: string; model_id: string }[]>`
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
        model_id,
        temperature,
        persona,
        focus,
        method,
        sort_order,
        role_template_version
      )
      values (
        ${input.workspaceId}::uuid,
        ${input.talkId}::uuid,
        ${snapshotGroupId}::uuid,
        ${agent.id}::uuid,
        ${agent.role_key},
        ${agent.name},
        ${agent.handle},
        ${agent.initials},
        ${agent.accent},
        ${agent.accent_dark},
        ${agent.model_id},
        ${agent.temperature},
        ${agent.persona},
        ${agent.focus},
        ${agent.method},
        ${agent.sort_order},
        ${agent.created_from_template_version}
      )
      returning id, model_id
    `;
    const snapshot = snapshots[0]!;
    const insertedRuns = await db<
      Array<
        Omit<GreenfieldChatRunRecord, 'target_agent_id' | 'target_agent_name'>
      >
    >`
      insert into public.runs (
        workspace_id,
        talk_id,
        round,
        snapshot_group_id,
        agent_snapshot_id,
        model_id,
        requested_by,
        trigger_message_id,
        response_group_id,
        sequence_index,
        status
      )
      values (
        ${input.workspaceId}::uuid,
        ${input.talkId}::uuid,
        ${round},
        ${snapshotGroupId}::uuid,
        ${snapshot.id}::uuid,
        ${snapshot.model_id},
        ${input.userId}::uuid,
        ${message.id}::uuid,
        ${responseGroupId},
        ${index},
        'queued'
      )
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
        error_json
    `;
    const run = insertedRuns[0]!;
    runs.push({
      ...run,
      target_agent_id: agent.id,
      target_agent_name: agent.name,
    });
  }

  await db`
    update public.talks
    set last_activity_at = now()
    where workspace_id = ${input.workspaceId}::uuid
      and id = ${input.talkId}::uuid
  `;

  await emitOutboxEvent({
    topic: `talk:${input.talkId}`,
    eventType: 'message_appended',
    payload: {
      talkId: input.talkId,
      threadId: input.talkId,
      messageId: message.id,
      runId: null,
      role: 'user',
      createdBy: input.userId,
      content: input.content,
      createdAt: message.created_at,
    },
    ownerIds: [input.userId],
  });

  for (const run of runs) {
    await emitOutboxEvent({
      topic: `talk:${input.talkId}`,
      eventType: 'talk_run_queued',
      payload: {
        talkId: input.talkId,
        threadId: input.talkId,
        runId: run.id,
        runKind: 'conversation',
        triggerMessageId: message.id,
        targetAgentId: run.target_agent_id,
        targetAgentNickname: run.target_agent_name,
        responseGroupId: run.response_group_id,
        sequenceIndex: run.sequence_index,
        status: 'queued',
        executorAlias: run.target_agent_name,
        executorModel: run.model_id,
      },
      ownerIds: [input.userId],
    });
  }

  return { ok: true, talkId: input.talkId, message, runs };
}

export async function cancelGreenfieldTalkRuns(input: {
  workspaceId: string;
  talkId: string;
  userId: string;
}): Promise<{
  cancelledRuns: number;
  cancelledRunIds: string[];
}> {
  const db = getDbPg();
  const updated = await db<{ id: string }[]>`
    update public.runs
    set
      status = 'cancelled',
      finished_at = coalesce(finished_at, now()),
      error_json = coalesce(error_json, '{}'::jsonb) || jsonb_build_object(
        'code', 'cancelled_by_user',
        'cancelledBy', ${input.userId}::text
      )
    where workspace_id = ${input.workspaceId}::uuid
      and talk_id = ${input.talkId}::uuid
      and status in ('queued', 'running', 'awaiting')
    returning id
  `;
  const cancelledRunIds = updated.map((row) => row.id);
  if (cancelledRunIds.length > 0) {
    await emitOutboxEvent({
      topic: `talk:${input.talkId}`,
      eventType: 'talk_run_cancelled',
      payload: {
        talkId: input.talkId,
        cancelledBy: input.userId,
        runIds: cancelledRunIds,
        threadIds: [input.talkId],
      },
      ownerIds: [input.userId],
    });
  }
  return {
    cancelledRuns: cancelledRunIds.length,
    cancelledRunIds,
  };
}
