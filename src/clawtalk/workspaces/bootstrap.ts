import { getDbPg } from '../../db.js';

export async function ensureWorkspaceBootstrapForUser(
  userId: string,
): Promise<string> {
  const db = getDbPg();
  const rows = await db<{ workspace_id: string }[]>`
    select public.ensure_user_workspace_bootstrap(${userId}::uuid) as workspace_id
  `;
  const workspaceId = rows[0]?.workspace_id;
  if (!workspaceId) {
    throw new Error(
      `Workspace bootstrap did not return a workspace for ${userId}`,
    );
  }
  return workspaceId;
}
