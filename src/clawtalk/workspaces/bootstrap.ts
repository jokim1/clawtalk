import { getDbPg } from '../../db.js';

export type WorkspaceCreationEntitlement =
  | { allowed: true }
  | {
      allowed: false;
      statusCode: number;
      code: string;
      message: string;
    };

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

export async function getWorkspaceCreationEntitlement(input: {
  userId: string;
}): Promise<WorkspaceCreationEntitlement> {
  void input;
  // Single gate for future billing/plan checks. For now, every authenticated
  // user may create unlimited workspaces.
  return { allowed: true };
}

export async function createWorkspaceForUser(input: {
  userId: string;
  name: string;
}): Promise<string> {
  const db = getDbPg();
  const rows = await db<{ workspace_id: string }[]>`
    select public.create_user_workspace(
      ${input.userId}::uuid,
      ${input.name}::text
    ) as workspace_id
  `;
  const workspaceId = rows[0]?.workspace_id;
  if (!workspaceId) {
    throw new Error(`Workspace creation did not return a workspace`);
  }
  return workspaceId;
}
