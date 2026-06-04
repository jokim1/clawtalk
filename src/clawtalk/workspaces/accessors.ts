import { getDbPg } from '../../db.js';

export interface WorkspaceSummaryRecord {
  id: string;
  name: string;
  role: 'owner' | 'admin' | 'member' | 'guest';
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
