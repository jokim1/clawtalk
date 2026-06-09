import { getDbPg, withTrustedDbWrites } from '../../db.js';

export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'guest';

export interface WorkspaceSummaryRecord {
  id: string;
  name: string;
  role: WorkspaceRole;
  initials: string;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceUserRecord {
  id: string;
  email: string;
  name: string;
  avatar_color: string | null;
  initials: string | null;
  created_at: string;
}

export interface WorkspaceMemberRecord {
  workspace_id: string;
  user_id: string;
  email: string;
  name: string;
  avatar_color: string | null;
  initials: string | null;
  role: WorkspaceRole;
  created_at: string;
}

export type WorkspaceMemberMutationError = {
  ok: false;
  statusCode: number;
  code: string;
  message: string;
};

export type WorkspaceMemberMutationSuccess<T> = {
  ok: true;
  data: T;
};

export type WorkspaceMemberMutationResult<T> =
  | WorkspaceMemberMutationSuccess<T>
  | WorkspaceMemberMutationError;

const USER_INITIALS_SQL = `
  coalesce(
    nullif(u.initials, ''),
    nullif(upper(left(regexp_replace(coalesce(nullif(u.name, ''), split_part(u.email::text, '@', 1)), '[^[:alnum:]]+', '', 'g'), 2)), ''),
    '?'
  )
`;

function mutationError(
  statusCode: number,
  code: string,
  message: string,
): WorkspaceMemberMutationError {
  return { ok: false, statusCode, code, message };
}

export async function getWorkspaceUser(
  userId: string,
): Promise<WorkspaceUserRecord | undefined> {
  const db = getDbPg();
  const rows = await db<WorkspaceUserRecord[]>`
    select
      id,
      email::text as email,
      name,
      avatar_color,
      initials,
      created_at
    from public.users
    where id = ${userId}::uuid
    limit 1
  `;
  return rows[0];
}

export async function listWorkspacesForUser(
  userId: string,
): Promise<WorkspaceSummaryRecord[]> {
  const db = getDbPg();
  return db<WorkspaceSummaryRecord[]>`
    select
      w.id,
      w.name,
      wm.role,
      upper(left(regexp_replace(w.name, '[^[:alnum:]]+', '', 'g'), 2)) as initials,
      w.created_at,
      w.updated_at
    from public.workspace_members wm
    join public.workspaces w
      on w.id = wm.workspace_id
    where wm.user_id = ${userId}::uuid
    order by wm.created_at asc, w.created_at asc, w.id asc
  `;
}

export async function resolveWorkspaceForUser(input: {
  userId: string;
  requestedWorkspaceId?: string | null;
}): Promise<WorkspaceSummaryRecord | undefined> {
  const workspaces = await listWorkspacesForUser(input.userId);
  if (input.requestedWorkspaceId) {
    return workspaces.find(
      (workspace) => workspace.id === input.requestedWorkspaceId,
    );
  }
  return workspaces[0];
}

export async function listWorkspaceMembers(input: {
  workspaceId: string;
}): Promise<WorkspaceMemberRecord[]> {
  return withTrustedDbWrites(async () => {
    const db = getDbPg();
    return db<WorkspaceMemberRecord[]>`
      select
        wm.workspace_id,
        wm.user_id,
        u.email::text as email,
        u.name,
        u.avatar_color,
        ${db.unsafe(USER_INITIALS_SQL)} as initials,
        wm.role,
        wm.created_at
      from public.workspace_members wm
      join public.users u
        on u.id = wm.user_id
      where wm.workspace_id = ${input.workspaceId}::uuid
      order by
        case wm.role
          when 'owner' then 0
          when 'admin' then 1
          when 'member' then 2
          else 3
        end,
        lower(u.name),
        lower(u.email::text),
        wm.created_at asc
    `;
  });
}

async function getWorkspaceMember(input: {
  workspaceId: string;
  userId: string;
}): Promise<WorkspaceMemberRecord | undefined> {
  const rows = await listWorkspaceMembers({ workspaceId: input.workspaceId });
  return rows.find((member) => member.user_id === input.userId);
}

export async function addExistingWorkspaceMember(input: {
  workspaceId: string;
  email: string;
  role: Exclude<WorkspaceRole, 'owner'>;
}): Promise<WorkspaceMemberMutationResult<{ member: WorkspaceMemberRecord }>> {
  return withTrustedDbWrites(async () => {
    const db = getDbPg();
    const targetRows = await db<{ id: string }[]>`
      select id
      from public.users
      where lower(email::text) = lower(${input.email}::text)
      limit 1
    `;
    const target = targetRows[0];
    if (!target) {
      return mutationError(
        404,
        'user_not_found',
        'That user has not signed in yet.',
      );
    }

    await db`
      insert into public.workspace_members (workspace_id, user_id, role)
      values (${input.workspaceId}::uuid, ${target.id}::uuid, ${input.role})
      on conflict (workspace_id, user_id) do update set
        role = case
          when public.workspace_members.role = 'owner'
            then public.workspace_members.role
          else excluded.role
        end
    `;

    const member = await getWorkspaceMember({
      workspaceId: input.workspaceId,
      userId: target.id,
    });
    if (!member) {
      return mutationError(
        500,
        'member_write_failed',
        'Workspace member could not be saved.',
      );
    }
    return { ok: true, data: { member } };
  });
}

export async function updateWorkspaceMemberRole(input: {
  workspaceId: string;
  userId: string;
  role: Exclude<WorkspaceRole, 'owner'>;
}): Promise<WorkspaceMemberMutationResult<{ member: WorkspaceMemberRecord }>> {
  return withTrustedDbWrites(async () => {
    const db = getDbPg();
    const currentRows = await db<{ role: WorkspaceRole }[]>`
      select role
      from public.workspace_members
      where workspace_id = ${input.workspaceId}::uuid
        and user_id = ${input.userId}::uuid
      limit 1
      for update
    `;
    const current = currentRows[0];
    if (!current) {
      return mutationError(404, 'member_not_found', 'Member was not found.');
    }
    if (current.role === 'owner') {
      return mutationError(
        409,
        'owner_transfer_required',
        'Transfer ownership before changing the owner role.',
      );
    }

    await db`
      update public.workspace_members
      set role = ${input.role}
      where workspace_id = ${input.workspaceId}::uuid
        and user_id = ${input.userId}::uuid
    `;
    const member = await getWorkspaceMember({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });
    if (!member) {
      return mutationError(
        500,
        'member_update_failed',
        'Workspace member could not be updated.',
      );
    }
    return { ok: true, data: { member } };
  });
}

export async function removeWorkspaceMember(input: {
  workspaceId: string;
  actorUserId: string;
  userId: string;
}): Promise<WorkspaceMemberMutationResult<{ removed: true }>> {
  return withTrustedDbWrites(async () => {
    if (input.actorUserId === input.userId) {
      return mutationError(
        400,
        'self_remove_not_supported',
        'Use workspace switching or account settings instead of removing yourself.',
      );
    }

    const db = getDbPg();
    const currentRows = await db<{ role: WorkspaceRole }[]>`
      select role
      from public.workspace_members
      where workspace_id = ${input.workspaceId}::uuid
        and user_id = ${input.userId}::uuid
      limit 1
      for update
    `;
    const current = currentRows[0];
    if (!current) {
      return mutationError(404, 'member_not_found', 'Member was not found.');
    }
    if (current.role === 'owner') {
      return mutationError(
        409,
        'owner_removal_forbidden',
        'Transfer ownership before removing the owner.',
      );
    }

    await db`
      delete from public.workspace_members
      where workspace_id = ${input.workspaceId}::uuid
        and user_id = ${input.userId}::uuid
    `;
    return { ok: true, data: { removed: true } };
  });
}

export async function transferWorkspaceOwnership(input: {
  workspaceId: string;
  actorUserId: string;
  newOwnerUserId: string;
}): Promise<
  WorkspaceMemberMutationResult<{
    workspaceId: string;
    newOwnerUserId: string;
    members: WorkspaceMemberRecord[];
  }>
> {
  return withTrustedDbWrites(async () => {
    const db = getDbPg();
    const actorRows = await db<{ role: WorkspaceRole }[]>`
      select role
      from public.workspace_members
      where workspace_id = ${input.workspaceId}::uuid
        and user_id = ${input.actorUserId}::uuid
      for update
    `;
    if (actorRows[0]?.role !== 'owner') {
      return mutationError(
        403,
        'workspace_owner_required',
        'Workspace owner access is required.',
      );
    }

    const targetRows = await db<{ role: WorkspaceRole }[]>`
      select role
      from public.workspace_members
      where workspace_id = ${input.workspaceId}::uuid
        and user_id = ${input.newOwnerUserId}::uuid
      for update
    `;
    if (!targetRows[0]) {
      return mutationError(404, 'member_not_found', 'Member was not found.');
    }

    await db`
      update public.workspace_members
      set role = 'admin'
      where workspace_id = ${input.workspaceId}::uuid
        and role = 'owner'
        and user_id <> ${input.newOwnerUserId}::uuid
    `;
    await db`
      update public.workspace_members
      set role = 'owner'
      where workspace_id = ${input.workspaceId}::uuid
        and user_id = ${input.newOwnerUserId}::uuid
    `;
    await db`
      update public.workspaces
      set owner_id = ${input.newOwnerUserId}::uuid,
          updated_at = now()
      where id = ${input.workspaceId}::uuid
    `;

    return {
      ok: true,
      data: {
        workspaceId: input.workspaceId,
        newOwnerUserId: input.newOwnerUserId,
        members: await listWorkspaceMembers({ workspaceId: input.workspaceId }),
      },
    };
  });
}
