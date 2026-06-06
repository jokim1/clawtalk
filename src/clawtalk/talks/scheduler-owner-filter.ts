import type { Sql } from '../../db.js';

type OwnerEmailFilterWorkspaceAlias = 'jobs' | 'runs';

export function buildOwnerEmailWorkspaceFilter(
  sql: Sql,
  ownerEmailPattern: string | null | undefined,
  workspaceAlias: OwnerEmailFilterWorkspaceAlias,
): ReturnType<Sql> {
  if (!ownerEmailPattern) return sql``;
  const workspaceColumn =
    workspaceAlias === 'jobs' ? sql`j.workspace_id` : sql`r.workspace_id`;

  return sql`
    and exists (
      select 1
      from public.workspaces w
      join auth.users u
        on u.id = w.owner_id
      where w.id = ${workspaceColumn}
        and u.email like ${ownerEmailPattern}
    )
  `;
}
