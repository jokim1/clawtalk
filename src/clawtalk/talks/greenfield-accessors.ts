import { randomUUID } from 'node:crypto';

import { getDbPg, type Sql } from '../../db.js';

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
  is_system: boolean;
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

export interface GreenfieldTalkToolRecord {
  tool_id: string;
  enabled: boolean;
}

type GreenfieldSidebarOrderItem =
  | { type: 'folder'; id: string; sort_order: number }
  | {
      type: 'talk';
      id: string;
      folder_id: string | null;
      sort_order: number;
    };

type GreenfieldTalkOrderRow = {
  id: string;
  folder_id: string | null;
  sort_order: number;
};

type GreenfieldFolderOrderRow = {
  id: string;
  sort_order: number;
};

export type ReorderGreenfieldSidebarResult =
  | { status: 'ok' }
  | { status: 'item_not_found' }
  | { status: 'destination_not_found' }
  | { status: 'invalid_destination' }
  | { status: 'invalid_destination_index' };

async function withGreenfieldTransaction<T>(
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

function bySidebarOrder<T extends { sort_order: number; id: string }>(
  left: T,
  right: T,
): number {
  return left.sort_order - right.sort_order || left.id.localeCompare(right.id);
}

function insertAt<T>(items: T[], item: T, index: number): T[] {
  const next = [...items];
  next.splice(index, 0, item);
  return next;
}

function canInsertAt<T>(items: T[], index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index <= items.length;
}

function rootSidebarItems(input: {
  folders: GreenfieldFolderOrderRow[];
  talks: GreenfieldTalkOrderRow[];
}): GreenfieldSidebarOrderItem[] {
  return [
    ...input.talks
      .filter((talk) => talk.folder_id === null)
      .map((talk) => ({
        type: 'talk' as const,
        id: talk.id,
        folder_id: talk.folder_id,
        sort_order: talk.sort_order,
      })),
    ...input.folders.map((folder) => ({
      type: 'folder' as const,
      id: folder.id,
      sort_order: folder.sort_order,
    })),
  ].sort(bySidebarOrder);
}

async function persistRootSidebarOrder(input: {
  txSql: Sql;
  workspaceId: string;
  items: GreenfieldSidebarOrderItem[];
}): Promise<void> {
  for (const [index, item] of input.items.entries()) {
    if (item.type === 'folder') {
      await input.txSql`
        update public.folders
        set sort_order = ${index}
        where workspace_id = ${input.workspaceId}::uuid
          and id = ${item.id}::uuid
      `;
      continue;
    }
    await input.txSql`
      update public.talks
      set folder_id = null, sort_order = ${index}
      where workspace_id = ${input.workspaceId}::uuid
        and id = ${item.id}::uuid
    `;
  }
}

async function persistTalkBucketOrder(input: {
  txSql: Sql;
  workspaceId: string;
  folderId: string | null;
  talks: GreenfieldTalkOrderRow[];
}): Promise<void> {
  for (const [index, talk] of input.talks.entries()) {
    await input.txSql`
      update public.talks
      set folder_id = ${input.folderId ?? null}::uuid, sort_order = ${index}
      where workspace_id = ${input.workspaceId}::uuid
        and id = ${talk.id}::uuid
    `;
  }
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

export async function reorderGreenfieldSidebarItem(input: {
  workspaceId: string;
  itemType: 'talk' | 'folder';
  itemId: string;
  destinationFolderId: string | null;
  destinationIndex: number;
}): Promise<ReorderGreenfieldSidebarResult> {
  const db = getDbPg();
  const destinationIndex = input.destinationIndex;
  if (!Number.isInteger(destinationIndex) || destinationIndex < 0) {
    return { status: 'invalid_destination_index' };
  }

  return withGreenfieldTransaction(db, async (txSql) => {
    const folders = await txSql<GreenfieldFolderOrderRow[]>`
      select id, sort_order
      from public.folders
      where workspace_id = ${input.workspaceId}::uuid
      order by sort_order asc, id asc
      for update
    `;
    const talks = await txSql<GreenfieldTalkOrderRow[]>`
      select id, folder_id, sort_order
      from public.talks
      where workspace_id = ${input.workspaceId}::uuid
        and archived_at is null
        -- The system talk (Buddy) is hidden from the sidebar, so the client's
        -- drag indices are computed without it; including it here would shift
        -- every root-level drop by one slot.
        and is_system = false
      order by folder_id nulls first, sort_order asc, id asc
      for update
    `;

    const destinationFolderExists =
      input.destinationFolderId === null ||
      folders.some((folder) => folder.id === input.destinationFolderId);
    if (!destinationFolderExists) {
      return { status: 'destination_not_found' };
    }

    if (input.itemType === 'folder') {
      if (input.destinationFolderId !== null) {
        return { status: 'invalid_destination' };
      }
      const movingFolder = folders.find((folder) => folder.id === input.itemId);
      if (!movingFolder) return { status: 'item_not_found' };
      const rootItems = rootSidebarItems({ folders, talks }).filter(
        (item) => !(item.type === 'folder' && item.id === input.itemId),
      );
      if (!canInsertAt(rootItems, destinationIndex)) {
        return { status: 'invalid_destination_index' };
      }
      await persistRootSidebarOrder({
        txSql,
        workspaceId: input.workspaceId,
        items: insertAt(
          rootItems,
          { type: 'folder', ...movingFolder },
          destinationIndex,
        ),
      });
      return { status: 'ok' };
    }

    const movingTalk = talks.find((talk) => talk.id === input.itemId);
    if (!movingTalk) return { status: 'item_not_found' };

    const sourceFolderId = movingTalk.folder_id;
    const targetFolderId = input.destinationFolderId;
    const rootItems = rootSidebarItems({ folders, talks }).filter(
      (item) => !(item.type === 'talk' && item.id === input.itemId),
    );

    if (sourceFolderId === targetFolderId && targetFolderId !== null) {
      const bucket = talks
        .filter(
          (talk) =>
            talk.folder_id === targetFolderId && talk.id !== input.itemId,
        )
        .sort(bySidebarOrder);
      if (!canInsertAt(bucket, destinationIndex)) {
        return { status: 'invalid_destination_index' };
      }
      await persistTalkBucketOrder({
        txSql,
        workspaceId: input.workspaceId,
        folderId: targetFolderId,
        talks: insertAt(bucket, movingTalk, destinationIndex),
      });
      return { status: 'ok' };
    }

    if (targetFolderId === null) {
      if (!canInsertAt(rootItems, destinationIndex)) {
        return { status: 'invalid_destination_index' };
      }
      if (sourceFolderId !== null) {
        const sourceBucket = talks
          .filter(
            (talk) =>
              talk.folder_id === sourceFolderId && talk.id !== input.itemId,
          )
          .sort(bySidebarOrder);
        await persistTalkBucketOrder({
          txSql,
          workspaceId: input.workspaceId,
          folderId: sourceFolderId,
          talks: sourceBucket,
        });
      }
      await persistRootSidebarOrder({
        txSql,
        workspaceId: input.workspaceId,
        items: insertAt(
          rootItems,
          {
            type: 'talk',
            ...movingTalk,
            folder_id: null,
          },
          destinationIndex,
        ),
      });
      return { status: 'ok' };
    }

    if (sourceFolderId === null) {
      await persistRootSidebarOrder({
        txSql,
        workspaceId: input.workspaceId,
        items: rootItems,
      });
    } else {
      const sourceBucket = talks
        .filter(
          (talk) =>
            talk.folder_id === sourceFolderId && talk.id !== input.itemId,
        )
        .sort(bySidebarOrder);
      await persistTalkBucketOrder({
        txSql,
        workspaceId: input.workspaceId,
        folderId: sourceFolderId,
        talks: sourceBucket,
      });
    }

    const destinationBucket = talks
      .filter(
        (talk) => talk.folder_id === targetFolderId && talk.id !== input.itemId,
      )
      .sort(bySidebarOrder);
    if (!canInsertAt(destinationBucket, destinationIndex)) {
      return { status: 'invalid_destination_index' };
    }
    await persistTalkBucketOrder({
      txSql,
      workspaceId: input.workspaceId,
      folderId: targetFolderId,
      talks: insertAt(
        destinationBucket,
        { ...movingTalk, folder_id: targetFolderId },
        destinationIndex,
      ),
    });
    return { status: 'ok' };
  });
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
      t.is_system,
      t.archived_at,
      t.last_activity_at,
      t.created_at,
      t.updated_at,
      coalesce((
        select array_agg(ta.agent_id order by ta.sort_order asc)::text[]
        from public.talk_agents ta
        where ta.workspace_id = t.workspace_id
          and ta.talk_id = t.id
      ), '{}'::text[]) as agent_ids,
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
  const updated = await db<{ id: string }[]>`
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
      -- The system talk (Buddy) is bootstrap-managed: its title matches the
      -- hardcoded pinned sidebar row and it never moves into folders.
      and is_system = false
    returning id
  `;
  if (updated.length === 0) return undefined;
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
      -- The system talk (Buddy) anchors the sidebar's pinned row and is
      -- re-seeded by bootstrap; it can never be archived or deleted.
      and is_system = false
    returning id
  `;
  return rows.length > 0;
}

export async function unarchiveGreenfieldTalk(input: {
  workspaceId: string;
  talkId: string;
}): Promise<boolean> {
  const db = getDbPg();
  const rows = await db<{ id: string }[]>`
    update public.talks
    set archived_at = null
    where workspace_id = ${input.workspaceId}::uuid
      and id = ${input.talkId}::uuid
      and is_system = false
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
    join public.talks t
      on t.workspace_id = ta.workspace_id
     and t.id = ta.talk_id
    left join public.llm_provider_models m
      on m.model_id = a.model_id
    where ta.workspace_id = ${input.workspaceId}::uuid
      and ta.talk_id = ${input.talkId}::uuid
      -- System agents (Buddy) are visible on the roster of the system talk
      -- only; regular talks never list them.
      and (a.is_system = false or t.is_system = true)
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
      -- The system talk's roster (Buddy) is bootstrap-managed; a full replace
      -- would drop the system agent, so reject it like a missing talk.
      and is_system = false
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

export async function listGreenfieldTalkTools(input: {
  workspaceId: string;
  talkId: string;
}): Promise<GreenfieldTalkToolRecord[]> {
  const db = getDbPg();
  return db<GreenfieldTalkToolRecord[]>`
    select tool_id, enabled
    from public.talk_tools
    where workspace_id = ${input.workspaceId}::uuid
      and talk_id = ${input.talkId}::uuid
    order by tool_id asc
  `;
}

export async function setGreenfieldTalkTools(input: {
  workspaceId: string;
  talkId: string;
  toolIds: string[];
  enabled: boolean;
}): Promise<GreenfieldTalkToolRecord[] | null> {
  const db = getDbPg();
  const rows = await db<GreenfieldTalkToolRecord[]>`
    with talk_row as (
      select id
      from public.talks
      where workspace_id = ${input.workspaceId}::uuid
        and id = ${input.talkId}::uuid
      for update
    ),
    requested_tools as (
      select unnest(${input.toolIds}::text[]) as tool_id
    )
    insert into public.talk_tools (workspace_id, talk_id, tool_id, enabled)
    select
      ${input.workspaceId}::uuid,
      talk_row.id,
      requested_tools.tool_id,
      ${input.enabled}::boolean
    from talk_row
    cross join requested_tools
    on conflict (talk_id, tool_id) do update
      set enabled = excluded.enabled
    returning tool_id, enabled
  `;
  return rows.length === 0 ? null : rows;
}
