import { randomUUID } from 'node:crypto';

import { getDbPg } from '../../db.js';

export interface GreenfieldFolderRecord {
  id: string;
  workspace_id: string;
  title: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface GreenfieldTalkRecord {
  id: string;
  workspace_id: string;
  folder_id: string | null;
  sort_order: number;
  title: string;
  mode: 'ordered' | 'parallel';
  rounds_limit: 1 | 2 | 3 | 5;
  created_by: string;
  archived_at: string | null;
  last_activity_at: string;
  created_at: string;
  updated_at: string;
  agent_ids: string[];
  message_count: number;
  has_active_run: boolean;
  primary_document_id: string | null;
}

export interface GreenfieldTalkAgentRecord {
  id: string;
  workspace_id: string;
  role_key: string;
  name: string;
  handle: string;
  initials: string;
  provider_id: string | null;
  model_id: string;
  model_display_name: string | null;
  sort_order: number;
  enabled: boolean;
}

export async function listGreenfieldFolders(input: {
  workspaceId: string;
}): Promise<GreenfieldFolderRecord[]> {
  const db = getDbPg();
  return db<GreenfieldFolderRecord[]>`
    select id, workspace_id, title, sort_order, created_at, updated_at
    from public.folders
    where workspace_id = ${input.workspaceId}::uuid
    order by sort_order asc, title asc, id asc
  `;
}

export async function createGreenfieldFolder(input: {
  workspaceId: string;
  title: string;
}): Promise<GreenfieldFolderRecord> {
  const db = getDbPg();
  const rows = await db<GreenfieldFolderRecord[]>`
    with next_order as (
      select coalesce(max(sort_order) + 1, 0) as sort_order
      from public.folders
      where workspace_id = ${input.workspaceId}::uuid
    )
    insert into public.folders (workspace_id, title, sort_order)
    select ${input.workspaceId}::uuid, ${input.title}, sort_order
    from next_order
    returning id, workspace_id, title, sort_order, created_at, updated_at
  `;
  return rows[0]!;
}

export async function updateGreenfieldFolder(input: {
  workspaceId: string;
  folderId: string;
  title?: string;
  sortOrder?: number;
}): Promise<GreenfieldFolderRecord | undefined> {
  const db = getDbPg();
  const rows = await db<GreenfieldFolderRecord[]>`
    update public.folders
    set
      title = coalesce(${input.title ?? null}, title),
      sort_order = coalesce(${input.sortOrder ?? null}, sort_order)
    where workspace_id = ${input.workspaceId}::uuid
      and id = ${input.folderId}::uuid
    returning id, workspace_id, title, sort_order, created_at, updated_at
  `;
  return rows[0];
}

export async function deleteGreenfieldFolder(input: {
  workspaceId: string;
  folderId: string;
}): Promise<boolean> {
  const db = getDbPg();
  const rows = await db<{ id: string }[]>`
    delete from public.folders
    where workspace_id = ${input.workspaceId}::uuid
      and id = ${input.folderId}::uuid
    returning id
  `;
  return rows.length > 0;
}

export async function listGreenfieldTalks(input: {
  workspaceId: string;
  folderId?: string | null | 'all' | 'unfiled';
  includeArchived?: boolean;
}): Promise<GreenfieldTalkRecord[]> {
  const db = getDbPg();
  return db<GreenfieldTalkRecord[]>`
    select
      t.id,
      t.workspace_id,
      t.folder_id,
      t.sort_order,
      t.title,
      t.mode,
      t.rounds_limit,
      t.created_by,
      t.archived_at,
      t.last_activity_at,
      t.created_at,
      t.updated_at,
      coalesce(
        array_agg(ta.agent_id order by ta.sort_order asc)
          filter (where ta.agent_id is not null),
        '{}'::uuid[]
      )::text[] as agent_ids,
      count(distinct m.id)::int as message_count,
      exists (
        select 1
        from public.runs r
        where r.workspace_id = t.workspace_id
          and r.talk_id = t.id
          and r.status in ('queued', 'running', 'awaiting')
      ) as has_active_run,
      (
        select d.id::text
        from public.documents d
        where d.workspace_id = t.workspace_id
          and d.primary_talk_id = t.id
        limit 1
      ) as primary_document_id
    from public.talks t
    left join public.talk_agents ta
      on ta.workspace_id = t.workspace_id
     and ta.talk_id = t.id
    left join public.messages m
      on m.workspace_id = t.workspace_id
     and m.talk_id = t.id
    where t.workspace_id = ${input.workspaceId}::uuid
      and (${input.includeArchived === true}::boolean or t.archived_at is null)
      and (
        ${input.folderId ?? 'all'} = 'all'
        or (${input.folderId ?? 'all'} = 'unfiled' and t.folder_id is null)
        or t.folder_id::text = ${input.folderId ?? 'all'}
      )
    group by t.id
    order by t.folder_id nulls first, t.sort_order asc, t.last_activity_at desc, t.id asc
  `;
}

export async function getGreenfieldTalk(input: {
  workspaceId: string;
  talkId: string;
}): Promise<GreenfieldTalkRecord | undefined> {
  const rows = await listGreenfieldTalks({
    workspaceId: input.workspaceId,
    folderId: 'all',
    includeArchived: true,
  });
  return rows.find((talk) => talk.id === input.talkId);
}

export async function listDefaultTalkAgentIds(input: {
  workspaceId: string;
  requestedAgentIds?: string[];
}): Promise<string[]> {
  const db = getDbPg();
  if (input.requestedAgentIds && input.requestedAgentIds.length > 0) {
    const rows = await db<{ id: string }[]>`
      select id
      from public.agents
      where workspace_id = ${input.workspaceId}::uuid
        and id in ${db(input.requestedAgentIds)}
        and is_system = false
        and enabled = true
      order by
        case role_key
          when 'strategist' then 1
          when 'critic' then 2
          when 'researcher' then 3
          when 'quant' then 4
          when 'editor' then 5
          else 50
        end,
        id asc
    `;
    return rows.map((row) => row.id);
  }

  const rows = await db<{ id: string }[]>`
    select id
    from public.agents
    where workspace_id = ${input.workspaceId}::uuid
      and is_default = true
      and is_system = false
      and enabled = true
    order by
      case role_key
        when 'strategist' then 1
        when 'critic' then 2
        when 'researcher' then 3
        when 'quant' then 4
        when 'editor' then 5
        else 50
      end,
      id asc
  `;
  return rows.map((row) => row.id);
}

export async function createGreenfieldTalk(input: {
  workspaceId: string;
  createdBy: string;
  title: string;
  folderId?: string | null;
  mode?: 'ordered' | 'parallel';
  roundsLimit?: 1 | 2 | 3 | 5;
  agentIds: string[];
}): Promise<GreenfieldTalkRecord> {
  const db = getDbPg();
  const talkId = randomUUID();
  await db`
    with next_order as (
      select coalesce(max(sort_order) + 1, 0) as sort_order
      from public.talks
      where workspace_id = ${input.workspaceId}::uuid
        and folder_id is not distinct from ${input.folderId ?? null}::uuid
        and archived_at is null
    )
    insert into public.talks (
      id, workspace_id, folder_id, sort_order, title, mode, rounds_limit,
      created_by
    )
    select
      ${talkId}::uuid,
      ${input.workspaceId}::uuid,
      ${input.folderId ?? null}::uuid,
      sort_order,
      ${input.title},
      ${input.mode ?? 'ordered'},
      ${input.roundsLimit ?? 3},
      ${input.createdBy}::uuid
    from next_order
  `;

  for (const [index, agentId] of input.agentIds.entries()) {
    await db`
      insert into public.talk_agents (workspace_id, talk_id, agent_id, sort_order)
      values (
        ${input.workspaceId}::uuid,
        ${talkId}::uuid,
        ${agentId}::uuid,
        ${index}
      )
    `;
  }

  const talk = await getGreenfieldTalk({
    workspaceId: input.workspaceId,
    talkId,
  });
  if (!talk) throw new Error(`Created talk ${talkId} could not be loaded`);
  return talk;
}

export async function updateGreenfieldTalk(input: {
  workspaceId: string;
  talkId: string;
  title?: string;
  folderId?: string | null;
  mode?: 'ordered' | 'parallel';
  roundsLimit?: 1 | 2 | 3 | 5;
  sortOrder?: number;
}): Promise<GreenfieldTalkRecord | undefined> {
  const db = getDbPg();
  await db`
    update public.talks
    set
      title = coalesce(${input.title ?? null}, title),
      folder_id = case
        when ${input.folderId === undefined}::boolean then folder_id
        else ${input.folderId ?? null}::uuid
      end,
      mode = coalesce(${input.mode ?? null}, mode),
      rounds_limit = coalesce(${input.roundsLimit ?? null}, rounds_limit),
      sort_order = coalesce(${input.sortOrder ?? null}, sort_order)
    where workspace_id = ${input.workspaceId}::uuid
      and id = ${input.talkId}::uuid
  `;
  return getGreenfieldTalk({
    workspaceId: input.workspaceId,
    talkId: input.talkId,
  });
}

export async function archiveGreenfieldTalk(input: {
  workspaceId: string;
  talkId: string;
}): Promise<boolean> {
  const db = getDbPg();
  const rows = await db<{ id: string }[]>`
    update public.talks
    set archived_at = coalesce(archived_at, now())
    where workspace_id = ${input.workspaceId}::uuid
      and id = ${input.talkId}::uuid
    returning id
  `;
  return rows.length > 0;
}

export async function listGreenfieldTalkAgents(input: {
  workspaceId: string;
  talkId: string;
}): Promise<GreenfieldTalkAgentRecord[]> {
  const db = getDbPg();
  return db<GreenfieldTalkAgentRecord[]>`
    select
      a.id,
      a.workspace_id,
      a.role_key,
      a.name,
      a.handle,
      a.initials,
      m.provider_id,
      a.model_id,
      m.display_name as model_display_name,
      ta.sort_order,
      a.enabled
    from public.talk_agents ta
    join public.agents a
      on a.workspace_id = ta.workspace_id
     and a.id = ta.agent_id
    left join public.llm_provider_models m
      on m.model_id = a.model_id
    where ta.workspace_id = ${input.workspaceId}::uuid
      and ta.talk_id = ${input.talkId}::uuid
      and a.is_system = false
    order by ta.sort_order asc, a.name asc
  `;
}

export async function replaceGreenfieldTalkAgents(input: {
  workspaceId: string;
  talkId: string;
  agentIds: string[];
}): Promise<
  | { status: 'ok'; agents: GreenfieldTalkAgentRecord[] }
  | { status: 'talk_not_found' }
  | { status: 'agents_unavailable' }
> {
  const db = getDbPg();
  // Route callers enter through withResolvedWorkspace -> withUserContext, so
  // this full replace runs in one transaction. Lock the parent talk row to
  // serialize concurrent roster replacements for the same talk.
  const talks = await db<{ id: string }[]>`
    select id
    from public.talks
    where workspace_id = ${input.workspaceId}::uuid
      and id = ${input.talkId}::uuid
    for update
  `;
  if (talks.length === 0) return { status: 'talk_not_found' };

  const available = await db<{ id: string }[]>`
    select id
    from public.agents
    where workspace_id = ${input.workspaceId}::uuid
      and id in ${db(input.agentIds)}
      and is_system = false
      and enabled = true
  `;
  if (available.length !== input.agentIds.length) {
    return { status: 'agents_unavailable' };
  }

  await db`
    delete from public.talk_agents
    where workspace_id = ${input.workspaceId}::uuid
      and talk_id = ${input.talkId}::uuid
  `;
  for (const [index, agentId] of input.agentIds.entries()) {
    await db`
      insert into public.talk_agents (workspace_id, talk_id, agent_id, sort_order)
      values (
        ${input.workspaceId}::uuid,
        ${input.talkId}::uuid,
        ${agentId}::uuid,
        ${index}
      )
    `;
  }

  const agents = await listGreenfieldTalkAgents({
    workspaceId: input.workspaceId,
    talkId: input.talkId,
  });
  return { status: 'ok', agents };
}
