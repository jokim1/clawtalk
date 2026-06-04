// Workspace Slack install accessors.
//
// One row per installed Slack workspace. The bot token is encrypted via
// the same `encryptProviderSecret` pipeline as the rest of the connector
// credentials — the plaintext is only ever materialized inside
// `decryptWorkspaceSlackInstallToken`, which is called by privileged paths
// (the Slack API client for channel listing, future executor outbound posts).
// Decrypt is scoped by workspaceId + teamId so event/background runtimes can
// resolve a bot token without depending on an interactive owner/admin session.
//
// Read = SELECT for any authenticated user (members need to see the
// installed-workspace dropdown when creating channels).
// Write = admins only — enforced at the route layer via `isAdminLike(auth.role)`,
// with the underlying RLS policy in 0023 as belt + suspenders.
//
// The Slack OAuth callback runs outside `withUserContext` (no auth.uid()
// from Slack's browser redirect), so `upsertWorkspaceSlackInstall` is
// callable from the BYPASSRLS pool role.

import {
  getCurrentUserId,
  getDbPg,
  withTrustedDbWrites,
  type Sql,
} from '../../db.js';
import {
  decryptProviderSecret,
  encryptProviderSecret,
} from '../llm/provider-secret-store.js';

const SLACK_INSTALL_SURFACE = 'slack_install';

export interface WorkspaceSlackInstallRecord {
  id: string;
  workspace_id: string;
  team_id: string;
  team_name: string;
  bot_user_id: string | null;
  app_id: string | null;
  scopes: string[];
  enc_key_version: number;
  installed_by: string | null;
  installed_at: string;
  updated_at: string;
  bound_channel_count: number;
}

interface SlackInstallRow {
  id: string;
  workspace_id: string;
  secret_ref: string | null;
  config_json: Record<string, unknown>;
  installed_at: string;
  updated_at: string;
  bound_channel_count: string | number;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function toRecord(row: SlackInstallRow): WorkspaceSlackInstallRecord {
  const config = row.config_json ?? {};
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    team_id: readString(config.teamId) ?? '',
    team_name: readString(config.teamName) ?? 'Slack',
    bot_user_id: readString(config.botUserId),
    app_id: readString(config.appId),
    scopes: readStringArray(config.scopes),
    enc_key_version: 1,
    installed_by: readString(config.installedBy),
    installed_at: row.installed_at,
    updated_at: row.updated_at,
    bound_channel_count: Number(row.bound_channel_count) || 0,
  };
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

async function currentUserIsWorkspaceAdmin(
  db: Sql,
  workspaceId: string,
): Promise<boolean> {
  const userId = getCurrentUserId();
  if (!userId) return false;
  const rows = await db<Array<{ role: 'owner' | 'admin' }>>`
    select role
    from public.workspace_members
    where workspace_id = ${workspaceId}::uuid
      and user_id = ${userId}::uuid
      and role in ('owner', 'admin')
    limit 1
  `;
  return rows.length === 1;
}

async function selectInstallRows(input: {
  sql?: Sql;
  workspaceId: string;
  teamId?: string | null;
}): Promise<SlackInstallRow[]> {
  const sql = input.sql ?? getDbPg();
  return sql<SlackInstallRow[]>`
    select
      i.id,
      i.workspace_id,
      i.secret_ref,
      i.config_json,
      i.created_at as installed_at,
      i.updated_at,
      count(ch.id)::bigint as bound_channel_count
    from public.connectors i
    left join public.connectors ch
      on ch.workspace_id = i.workspace_id
     and ch.service = 'slack'
     and ch.config_json->>'compatSurface' = 'channel'
     and ch.config_json->>'credentialSource' = 'workspace_slack_install'
     and coalesce(ch.config_json->>'teamId', ch.config_json->>'workspace_id') =
       i.config_json->>'teamId'
    where i.service = 'slack'
      and i.config_json->>'compatSurface' = ${SLACK_INSTALL_SURFACE}
      and i.workspace_id = ${input.workspaceId}::uuid
      and (${input.teamId ?? null}::text is null or i.config_json->>'teamId' = ${input.teamId ?? null})
    group by i.id
    order by i.config_json->>'teamName' asc, i.config_json->>'teamId' asc
  `;
}

export async function listWorkspaceSlackInstalls(input: {
  workspaceId: string;
}): Promise<WorkspaceSlackInstallRecord[]> {
  const rows = await selectInstallRows({ workspaceId: input.workspaceId });
  return rows.map(toRecord);
}

export async function getWorkspaceSlackInstall(
  teamId: string,
  input: { workspaceId: string },
): Promise<WorkspaceSlackInstallRecord | null> {
  const rows = await selectInstallRows({
    workspaceId: input.workspaceId,
    teamId,
  });
  return rows[0] ? toRecord(rows[0]) : null;
}

export interface UpsertWorkspaceSlackInstallInput {
  workspaceId: string;
  teamId: string;
  teamName: string;
  botUserId: string | null;
  appId: string | null;
  botToken: string;
  scopes: string[];
  installedBy: string | null;
}

export async function upsertWorkspaceSlackInstall(
  input: UpsertWorkspaceSlackInstallInput,
): Promise<WorkspaceSlackInstallRecord> {
  if (!input.teamId) {
    throw new Error('teamId is required');
  }
  if (!input.botToken) {
    throw new Error('botToken is required');
  }
  const ciphertext = await encryptProviderSecret({ apiKey: input.botToken });
  const config = {
    compatSurface: SLACK_INSTALL_SURFACE,
    teamId: input.teamId,
    teamName: input.teamName,
    botUserId: input.botUserId,
    appId: input.appId,
    scopes: input.scopes,
    installedBy: input.installedBy,
  };
  const db = getDbPg();
  return withExistingOrNewTransaction(db, async (tx) => {
    await tx`
      select pg_advisory_xact_lock(
        hashtextextended(${`slack_install:${input.workspaceId}:${input.teamId}`}, 0)
      )
    `;
    const existingRows = await tx<
      Array<{ id: string; secret_ref: string | null }>
    >`
      select id, secret_ref
      from public.connectors
      where workspace_id = ${input.workspaceId}::uuid
        and service = 'slack'
        and config_json->>'compatSurface' = ${SLACK_INSTALL_SURFACE}
        and config_json->>'teamId' = ${input.teamId}
      for update
    `;
    const existing = existingRows[0];

    return withTrustedDbWrites(async () => {
      const secretRows = await tx<Array<{ id: string }>>`
        insert into public.connector_secrets (workspace_id, ciphertext)
        values (${input.workspaceId}::uuid, ${ciphertext})
        returning id
      `;
      const nextSecretRef = secretRows[0]!.id;

      const connectorRows = existing
        ? await tx<Array<{ id: string }>>`
            update public.connectors
            set secret_ref = ${nextSecretRef}::uuid,
                authorized = true,
                authorized_at = coalesce(authorized_at, now()),
                config_json = ${tx.json(config as never)},
                updated_at = now()
            where workspace_id = ${input.workspaceId}::uuid
              and id = ${existing.id}::uuid
            returning id
          `
        : await tx<Array<{ id: string }>>`
            insert into public.connectors (
              workspace_id,
              service,
              authorized,
              authorized_at,
              secret_ref,
              config_json
            )
            values (
              ${input.workspaceId}::uuid,
              'slack',
              true,
              now(),
              ${nextSecretRef}::uuid,
              ${tx.json(config as never)}
            )
            returning id
          `;

      await tx`
        update public.connectors
        set authorized = true,
            authorized_at = coalesce(authorized_at, now()),
            updated_at = now()
        where workspace_id = ${input.workspaceId}::uuid
          and service = 'slack'
          and config_json->>'compatSurface' = 'channel'
          and config_json->>'credentialSource' = 'workspace_slack_install'
          and coalesce(config_json->>'teamId', config_json->>'workspace_id') =
            ${input.teamId}
      `;

      if (existing?.secret_ref && existing.secret_ref !== nextSecretRef) {
        await tx`
          delete from public.connector_secrets
          where workspace_id = ${input.workspaceId}::uuid
            and id = ${existing.secret_ref}::uuid
        `;
      }

      const rows = await selectInstallRows({
        sql: tx,
        workspaceId: input.workspaceId,
        teamId: input.teamId,
      });
      if (!connectorRows[0] || !rows[0]) {
        throw new Error('upsertWorkspaceSlackInstall returned no row');
      }
      return toRecord(rows[0]);
    });
  });
}

export async function deleteWorkspaceSlackInstall(
  teamId: string,
  input: { workspaceId: string },
): Promise<boolean> {
  const db = getDbPg();
  return withExistingOrNewTransaction(db, async (tx) => {
    const rows = await tx<
      Array<{ id: string; workspace_id: string; secret_ref: string | null }>
    >`
      select id, workspace_id, secret_ref
      from public.connectors
      where service = 'slack'
        and config_json->>'compatSurface' = ${SLACK_INSTALL_SURFACE}
        and config_json->>'teamId' = ${teamId}
        and workspace_id = ${input.workspaceId}::uuid
      for update
    `;
    const existing = rows[0];
    if (!existing) return false;
    if (!(await currentUserIsWorkspaceAdmin(tx, existing.workspace_id))) {
      return false;
    }

    return withTrustedDbWrites(async () => {
      await tx`
        update public.connectors
        set authorized = false,
            authorized_at = null,
            updated_at = now()
        where workspace_id = ${existing.workspace_id}::uuid
          and service = 'slack'
          and config_json->>'compatSurface' = 'channel'
          and config_json->>'credentialSource' = 'workspace_slack_install'
          and coalesce(config_json->>'teamId', config_json->>'workspace_id') =
            ${teamId}
      `;
      const deletedRows = await tx<Array<{ id: string }>>`
        delete from public.connectors
        where workspace_id = ${existing.workspace_id}::uuid
          and id = ${existing.id}::uuid
        returning id
      `;
      if (existing.secret_ref) {
        await tx`
          delete from public.connector_secrets
          where workspace_id = ${existing.workspace_id}::uuid
            and id = ${existing.secret_ref}::uuid
        `;
      }
      return deletedRows.length > 0;
    });
  });
}

export async function decryptWorkspaceSlackInstallToken(
  teamId: string,
  input: { workspaceId: string },
): Promise<string | null> {
  const db = getDbPg();
  const connectorRows = await db<
    Array<{ workspace_id: string; secret_ref: string | null }>
  >`
    select c.workspace_id, c.secret_ref
    from public.connectors c
    where c.service = 'slack'
      and c.config_json->>'compatSurface' = ${SLACK_INSTALL_SURFACE}
      and c.config_json->>'teamId' = ${teamId}
      and c.authorized = true
      and c.secret_ref is not null
      and c.workspace_id = ${input.workspaceId}::uuid
    limit 1
  `;
  const connector = connectorRows[0];
  if (!connector?.secret_ref) return null;
  const rows = await withTrustedDbWrites(
    () => db<Array<{ ciphertext: string }>>`
      select ciphertext
      from public.connector_secrets
      where workspace_id = ${connector.workspace_id}::uuid
        and id = ${connector.secret_ref}::uuid
      limit 1
    `,
  );
  const ciphertext = rows[0]?.ciphertext;
  if (!ciphertext) return null;
  const decoded = await decryptProviderSecret(ciphertext);
  return decoded.apiKey;
}
