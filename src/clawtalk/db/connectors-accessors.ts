// Compatibility accessors for the pre-greenfield channel/data-connector
// routes. Rows are stored in the final greenfield connectors model:
//   connectors           = workspace OAuth/configuration record
//   connector_bindings   = per-Talk exposure, optionally scoped by target

import { z } from 'zod';

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

export const CHANNEL_KINDS = ['slack'] as const;
type SupportedChannelKind = (typeof CHANNEL_KINDS)[number];
export type ChannelKind = SupportedChannelKind | 'telegram';

export const DATA_CONNECTOR_KINDS = ['google_docs', 'google_sheets'] as const;
type SupportedDataConnectorKind = (typeof DATA_CONNECTOR_KINDS)[number];
export type DataConnectorKind = SupportedDataConnectorKind | 'posthog';

type ConnectorService = 'slack' | 'gdrive';
type ConnectorConfig = Record<string, unknown>;
type CompatSurface = 'channel' | 'data_connector';
type WorkspaceRole = 'owner' | 'admin' | 'member' | 'guest';
type WorkspaceScopedInput = { workspaceId: string };

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

const SYSTEM_CONFIG_SCHEMA_KEYS = {
  compatSurface: z.unknown().optional(),
  kind: z.unknown().optional(),
  dataConnectorKind: z.unknown().optional(),
  displayName: z.unknown().optional(),
  enabled: z.unknown().optional(),
  credentialSource: z.unknown().optional(),
};

const CHANNEL_CONFIG_SCHEMAS: Record<SupportedChannelKind, z.ZodTypeAny> = {
  slack: z
    .object({
      ...SYSTEM_CONFIG_SCHEMA_KEYS,
      workspace_id: z.string().min(1).optional(),
      teamId: z.string().min(1).optional(),
      channel_id: z.string().min(1).optional(),
      channel_name: z.string().min(1).optional(),
      is_private: z.boolean().optional(),
    })
    .strict(),
};

const DATA_CONNECTOR_CONFIG_SCHEMAS: Record<
  SupportedDataConnectorKind,
  z.ZodTypeAny
> = {
  google_docs: z
    .object({
      ...SYSTEM_CONFIG_SCHEMA_KEYS,
      folder_id: z.string().min(1).optional(),
    })
    .strict(),
  google_sheets: z
    .object({
      ...SYSTEM_CONFIG_SCHEMA_KEYS,
      folder_id: z.string().min(1).optional(),
    })
    .strict(),
};

export class ConnectorConfigInvalidError extends Error {
  readonly issues: Array<{ path: string; message: string }>;
  constructor(issues: Array<{ path: string; message: string }>) {
    super(
      `Invalid connector config: ${issues
        .map((issue) => `${issue.path || '(root)'}: ${issue.message}`)
        .join('; ')}`,
    );
    this.name = 'ConnectorConfigInvalidError';
    this.issues = issues;
  }
}

export class ConnectorConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorConflictError';
  }
}

function zodIssues(
  error: z.ZodError,
): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

function validateChannelConfig(
  kind: SupportedChannelKind,
  config: unknown,
): ConnectorConfig {
  const result = CHANNEL_CONFIG_SCHEMAS[kind].safeParse(config ?? {});
  if (!result.success)
    throw new ConnectorConfigInvalidError(zodIssues(result.error));
  return stripSystemConfigKeys(result.data as ConnectorConfig);
}

function validateDataConnectorConfig(
  kind: SupportedDataConnectorKind,
  config: unknown,
): ConnectorConfig {
  const result = DATA_CONNECTOR_CONFIG_SCHEMAS[kind].safeParse(config ?? {});
  if (!result.success)
    throw new ConnectorConfigInvalidError(zodIssues(result.error));
  return stripSystemConfigKeys(result.data as ConnectorConfig);
}

function serviceForDataConnector(
  _kind: SupportedDataConnectorKind,
): ConnectorService {
  return 'gdrive';
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

const PRESERVED_CHANNEL_CONFIG_KEYS = ['credentialSource'] as const;
const SYSTEM_CONFIG_KEYS = new Set([
  'compatSurface',
  'kind',
  'dataConnectorKind',
  'displayName',
  'enabled',
  'credentialSource',
]);

function stripSystemConfigKeys(config: ConnectorConfig): ConnectorConfig {
  const cleaned = { ...config };
  for (const key of SYSTEM_CONFIG_KEYS) {
    delete cleaned[key];
  }
  return cleaned;
}

function readSlackTeamId(config: ConnectorConfig): string | null {
  return readString(config.teamId) ?? readString(config.workspace_id);
}

function readSlackChannelId(config: ConnectorConfig): string | null {
  return readString(config.channel_id);
}

function hasSlackChannelTargetConfig(config: ConnectorConfig): boolean {
  return (
    readSlackTeamId(config) !== null || readSlackChannelId(config) !== null
  );
}

function slackTargetImportError(): ConnectorConfigInvalidError {
  return new ConnectorConfigInvalidError([
    {
      path: 'channel_id',
      message:
        'Slack channels must be imported through the Slack channel picker.',
    },
  ]);
}

function isConfigOnlyGoogleDataConnector(row: ConnectorRow): boolean {
  const config = row.config_json ?? {};
  const kind = readString(config.dataConnectorKind);
  return (
    row.service === 'gdrive' &&
    config.compatSurface === 'data_connector' &&
    (kind === 'google_docs' || kind === 'google_sheets')
  );
}

function preserveChannelInternalConfig(
  existing: ConnectorConfig,
  next: ConnectorConfig,
): ConnectorConfig {
  const merged = { ...next };
  for (const key of PRESERVED_CHANNEL_CONFIG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(existing, key)) {
      merged[key] = existing[key];
    }
  }
  return merged;
}

async function lockSlackChannelTarget(
  tx: Sql,
  input: { workspaceId: string; slackTeamId: string; slackChannelId: string },
): Promise<void> {
  await tx`
    select pg_advisory_xact_lock(
      hashtextextended(${`slack_channel:${input.workspaceId}:${input.slackTeamId}:${input.slackChannelId}`}, 0)
    )
  `;
}

async function hasAuthorizedSlackInstall(
  tx: Sql,
  input: { workspaceId: string; slackTeamId: string },
): Promise<boolean> {
  const rows = await tx<Array<{ id: string }>>`
    select id
    from public.connectors
    where workspace_id = ${input.workspaceId}::uuid
      and service = 'slack'
      and authorized = true
      and secret_ref is not null
      and config_json->>'compatSurface' = 'slack_install'
      and config_json->>'teamId' = ${input.slackTeamId}
    limit 1
  `;
  return rows.length === 1;
}

function applySlackDelegation(
  config: ConnectorConfig,
  delegatesToInstall: boolean,
): ConnectorConfig {
  const next = { ...config };
  if (delegatesToInstall) {
    next.credentialSource = 'workspace_slack_install';
  } else {
    delete next.credentialSource;
  }
  return next;
}

function channelConfig(input: {
  kind: ChannelKind;
  displayName: string;
  config: ConnectorConfig;
  enabled: boolean;
}): ConnectorConfig {
  return {
    ...input.config,
    compatSurface: 'channel',
    kind: input.kind,
    displayName: input.displayName,
    enabled: input.enabled,
  };
}

function dataConnectorConfig(input: {
  kind: DataConnectorKind;
  displayName: string;
  config: ConnectorConfig;
  enabled: boolean;
}): ConnectorConfig {
  return {
    ...input.config,
    compatSurface: 'data_connector',
    dataConnectorKind: input.kind,
    displayName: input.displayName,
    enabled: input.enabled,
  };
}

interface ConnectorRow {
  id: string;
  workspace_id: string;
  service: string;
  authorized: boolean;
  authorized_at: string | null;
  secret_ref: string | null;
  config_json: ConnectorConfig;
  created_at: string;
  updated_at: string;
  bound_talk_count: string | number;
  has_delegated_credential?: boolean | null;
}

export interface WorkspaceChannelRecord {
  id: string;
  workspace_id: string;
  kind: ChannelKind;
  display_name: string;
  config_json: ConnectorConfig;
  has_credential: boolean;
  enc_key_version: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
  bound_talk_count: number;
}

export interface WorkspaceDataConnectorRecord {
  id: string;
  workspace_id: string;
  kind: DataConnectorKind;
  display_name: string;
  config_json: ConnectorConfig;
  has_credential: boolean;
  enc_key_version: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
  bound_talk_count: number;
}

function toChannelRecord(row: ConnectorRow): WorkspaceChannelRecord {
  const config = row.config_json ?? {};
  const delegatesToSlackInstall =
    config.credentialSource === 'workspace_slack_install';
  const delegatedCredentialAvailable =
    row.has_delegated_credential ?? delegatesToSlackInstall;
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    kind: (readString(config.kind) ?? 'slack') as ChannelKind,
    display_name: readString(config.displayName) ?? 'Slack',
    config_json: config,
    has_credential:
      row.authorized &&
      (row.secret_ref !== null ||
        (delegatesToSlackInstall && delegatedCredentialAvailable === true)),
    enc_key_version: 1,
    enabled: readBoolean(config.enabled, true),
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: null,
    updated_by: null,
    bound_talk_count: Number(row.bound_talk_count) || 0,
  };
}

function toDataConnectorRecord(
  row: ConnectorRow,
): WorkspaceDataConnectorRecord {
  const config = row.config_json ?? {};
  // Google Docs/Sheets compatibility rows are configuration handles. Their
  // runtime credential is the acting user's google_tools connector, not a
  // per-data-source secret on this row.
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    kind: (readString(config.dataConnectorKind) ??
      'google_docs') as DataConnectorKind,
    display_name: readString(config.displayName) ?? 'Google Drive',
    config_json: config,
    has_credential:
      isConfigOnlyGoogleDataConnector(row) ||
      (row.secret_ref !== null && row.authorized),
    enc_key_version: 1,
    enabled: readBoolean(config.enabled, true),
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: null,
    updated_by: null,
    bound_talk_count: Number(row.bound_talk_count) || 0,
  };
}

async function listConnectorsBySurface(input: {
  workspaceId: string;
  compatSurface: CompatSurface;
}): Promise<ConnectorRow[]> {
  const db = getDbPg();
  return db<ConnectorRow[]>`
    select
      c.id,
      c.workspace_id,
      c.service,
      c.authorized,
      c.authorized_at,
      c.secret_ref,
      c.config_json,
      c.created_at,
      c.updated_at,
      count(distinct cb.talk_id)::bigint as bound_talk_count,
      exists (
        select 1
        from public.connectors si
        where si.workspace_id = c.workspace_id
          and si.service = 'slack'
          and si.authorized = true
          and si.secret_ref is not null
          and si.config_json->>'compatSurface' = 'slack_install'
          and si.config_json->>'teamId' =
            coalesce(c.config_json->>'teamId', c.config_json->>'workspace_id')
      ) as has_delegated_credential
    from public.connectors c
    left join public.connector_bindings cb
      on cb.workspace_id = c.workspace_id
     and cb.connector_id = c.id
    where c.config_json->>'compatSurface' = ${input.compatSurface}
      and c.workspace_id = ${input.workspaceId}::uuid
    group by c.id
    order by c.config_json->>'displayName' asc, c.id asc
  `;
}

async function getConnector(
  connectorId: string,
  workspaceId: string,
): Promise<ConnectorRow | undefined> {
  const db = getDbPg();
  const rows = await db<ConnectorRow[]>`
    select
      c.id,
      c.workspace_id,
      c.service,
      c.authorized,
      c.authorized_at,
      c.secret_ref,
      c.config_json,
      c.created_at,
      c.updated_at,
      count(distinct cb.talk_id)::bigint as bound_talk_count,
      exists (
        select 1
        from public.connectors si
        where si.workspace_id = c.workspace_id
          and si.service = 'slack'
          and si.authorized = true
          and si.secret_ref is not null
          and si.config_json->>'compatSurface' = 'slack_install'
          and si.config_json->>'teamId' =
            coalesce(c.config_json->>'teamId', c.config_json->>'workspace_id')
      ) as has_delegated_credential
    from public.connectors c
    left join public.connector_bindings cb
      on cb.workspace_id = c.workspace_id
     and cb.connector_id = c.id
    where c.id = ${connectorId}::uuid
      and c.workspace_id = ${workspaceId}::uuid
    group by c.id
    limit 1
  `;
  return rows[0];
}

async function resolveConnectorWorkspaceId(
  workspaceId: string | undefined,
): Promise<string> {
  if (workspaceId) return workspaceId;
  throw new Error('workspace_id is required');
}

async function currentUserIsWorkspaceAdmin(
  db: Sql,
  workspaceId: string,
): Promise<boolean> {
  const userId = getCurrentUserId();
  if (!userId) return false;
  const rows = await db<Array<{ role: WorkspaceRole }>>`
    select role
    from public.workspace_members
    where workspace_id = ${workspaceId}::uuid
      and user_id = ${userId}::uuid
      and role in ('owner', 'admin')
    limit 1
  `;
  return rows.length === 1;
}

export async function listWorkspaceChannels(
  input: WorkspaceScopedInput,
): Promise<WorkspaceChannelRecord[]> {
  const rows = await listConnectorsBySurface({
    workspaceId: input.workspaceId,
    compatSurface: 'channel',
  });
  return rows.map(toChannelRecord);
}

export async function getWorkspaceChannel(
  channelId: string,
  input: WorkspaceScopedInput,
): Promise<WorkspaceChannelRecord | null> {
  const row = await getConnector(channelId, input.workspaceId);
  if (!row || row.config_json?.compatSurface !== 'channel') return null;
  return toChannelRecord(row);
}

export interface CreateWorkspaceChannelInput {
  workspaceId?: string;
  kind: ChannelKind;
  displayName: string;
  config?: unknown;
  enabled?: boolean;
  authorized?: boolean;
  createdBy: string;
  allowSlackChannelImport?: boolean;
}

export async function createWorkspaceChannel(
  input: CreateWorkspaceChannelInput,
): Promise<WorkspaceChannelRecord> {
  if (!CHANNEL_KINDS.includes(input.kind as SupportedChannelKind)) {
    throw new Error(`Unsupported channel kind: ${input.kind}`);
  }
  const kind = input.kind as SupportedChannelKind;
  const workspaceId = await resolveConnectorWorkspaceId(input.workspaceId);
  const displayName = input.displayName.trim();
  if (!displayName) throw new Error('display_name is required');
  const baseConfig = channelConfig({
    kind,
    displayName,
    config: validateChannelConfig(kind, input.config),
    enabled: input.enabled ?? true,
  });
  const db = getDbPg();
  const slackTeamId = readSlackTeamId(baseConfig);
  const slackChannelId = readSlackChannelId(baseConfig);
  if (
    hasSlackChannelTargetConfig(baseConfig) &&
    !input.allowSlackChannelImport
  ) {
    throw slackTargetImportError();
  }
  if (slackTeamId && slackChannelId) {
    return withExistingOrNewTransaction(db, async (tx) => {
      await lockSlackChannelTarget(tx, {
        workspaceId,
        slackTeamId,
        slackChannelId,
      });
      const delegatesToInstall = await hasAuthorizedSlackInstall(tx, {
        workspaceId,
        slackTeamId,
      });
      const config = applySlackDelegation(baseConfig, delegatesToInstall);
      const authorized = (input.authorized ?? false) || delegatesToInstall;
      const existingRows = await tx<
        Array<{ id: string; config_json: ConnectorConfig }>
      >`
        select id
             , config_json
        from public.connectors
        where workspace_id = ${workspaceId}::uuid
          and service = 'slack'
          and config_json->>'compatSurface' = 'channel'
          and config_json->>'kind' = ${kind}
          and coalesce(config_json->>'teamId', config_json->>'workspace_id') = ${slackTeamId}
          and config_json->>'channel_id' = ${slackChannelId}
        for update
      `;
      const existing = existingRows[0];
      if (existing) {
        const preservedConfig = applySlackDelegation(
          existing.config_json ?? config,
          delegatesToInstall,
        );
        const rows = await tx<ConnectorRow[]>`
          with updated as (
            update public.connectors
            set config_json = ${tx.json(preservedConfig as never)},
                authorized = case
                  when ${authorized}::boolean then true
                  when secret_ref is null then false
                  else authorized
                end,
                authorized_at = case
                  when ${authorized}::boolean or secret_ref is not null
                    then coalesce(authorized_at, now())
                  else null
                end,
                updated_at = now()
            where id = ${existing.id}::uuid
            returning *
          )
          select u.*,
                 (select count(distinct cb.talk_id)::bigint from public.connector_bindings cb where cb.connector_id = u.id) as bound_talk_count
          from updated u
        `;
        return toChannelRecord(rows[0]!);
      }
      const rows = await tx<ConnectorRow[]>`
        with inserted as (
          insert into public.connectors (workspace_id, service, authorized, authorized_at, config_json)
          values (
            ${workspaceId}::uuid,
            'slack',
            ${authorized},
            case when ${authorized}::boolean then now() else null end,
            ${tx.json(config as never)}
          )
          returning *
        )
        select i.*, 0::bigint as bound_talk_count
        from inserted i
      `;
      return toChannelRecord(rows[0]!);
    });
  }
  const rows = await db<ConnectorRow[]>`
    with inserted as (
      insert into public.connectors (workspace_id, service, authorized, authorized_at, config_json)
      values (
        ${workspaceId}::uuid,
        'slack',
        ${input.authorized ?? false},
        case when ${input.authorized ?? false}::boolean then now() else null end,
        ${db.json(baseConfig as never)}
      )
      returning *
    )
    select i.*, 0::bigint as bound_talk_count
    from inserted i
  `;
  return toChannelRecord(rows[0]!);
}

export interface UpdateWorkspaceChannelInput {
  displayName?: string;
  config?: unknown;
  enabled?: boolean;
  updatedBy: string;
  allowSlackChannelImport?: boolean;
}

export async function updateWorkspaceChannel(
  channelId: string,
  patch: UpdateWorkspaceChannelInput,
  input: WorkspaceScopedInput,
): Promise<WorkspaceChannelRecord | null> {
  const existing = await getWorkspaceChannel(channelId, {
    workspaceId: input.workspaceId,
  });
  if (!existing) return null;
  const displayName =
    patch.displayName !== undefined
      ? patch.displayName.trim()
      : existing.display_name;
  if (!displayName) throw new Error('display_name is required');
  const baseConfig = channelConfig({
    kind: existing.kind as SupportedChannelKind,
    displayName,
    config:
      patch.config !== undefined
        ? validateChannelConfig(
            existing.kind as SupportedChannelKind,
            patch.config,
          )
        : stripSystemConfigKeys(existing.config_json),
    enabled: patch.enabled ?? existing.enabled,
  });
  let nextConfig = preserveChannelInternalConfig(
    existing.config_json,
    baseConfig,
  );
  if (patch.config !== undefined && !patch.allowSlackChannelImport) {
    throw slackTargetImportError();
  }
  const db = getDbPg();
  const update = async (
    tx: Sql,
    delegatesToInstall: boolean,
  ): Promise<ConnectorRow | undefined> => {
    const rows = await tx<ConnectorRow[]>`
      with updated as (
        update public.connectors
        set config_json = ${tx.json(nextConfig as never)},
            authorized = case
              when ${delegatesToInstall}::boolean then true
              when secret_ref is null then false
              else authorized
            end,
            authorized_at = case
              when ${delegatesToInstall}::boolean or secret_ref is not null
                then coalesce(authorized_at, now())
              else null
            end,
            updated_at = now()
        where id = ${channelId}::uuid
          and workspace_id = ${existing.workspace_id}::uuid
          and config_json->>'compatSurface' = 'channel'
        returning *
      )
      select u.*,
             (select count(distinct cb.talk_id)::bigint from public.connector_bindings cb where cb.connector_id = u.id) as bound_talk_count
      from updated u
    `;
    return rows[0];
  };
  const slackTeamId = readSlackTeamId(nextConfig);
  const slackChannelId = readSlackChannelId(nextConfig);
  if (slackTeamId && slackChannelId) {
    return withExistingOrNewTransaction(db, async (tx) => {
      await lockSlackChannelTarget(tx, {
        workspaceId: existing.workspace_id,
        slackTeamId,
        slackChannelId,
      });
      const duplicateRows = await tx<Array<{ id: string }>>`
        select id
        from public.connectors
        where workspace_id = ${existing.workspace_id}::uuid
          and service = 'slack'
          and config_json->>'compatSurface' = 'channel'
          and config_json->>'kind' = ${existing.kind}
          and coalesce(config_json->>'teamId', config_json->>'workspace_id') = ${slackTeamId}
          and config_json->>'channel_id' = ${slackChannelId}
          and id <> ${channelId}::uuid
        for update
      `;
      if (duplicateRows.length > 0) {
        throw new ConnectorConflictError(
          'A Slack channel with this workspace and channel id already exists.',
        );
      }
      const delegatesToInstall = await hasAuthorizedSlackInstall(tx, {
        workspaceId: existing.workspace_id,
        slackTeamId,
      });
      nextConfig = applySlackDelegation(nextConfig, delegatesToInstall);
      const row = await update(tx, delegatesToInstall);
      return row ? toChannelRecord(row) : null;
    });
  }
  nextConfig = applySlackDelegation(nextConfig, false);
  const row = await update(db, false);
  return row ? toChannelRecord(row) : null;
}

export async function deleteWorkspaceChannel(
  channelId: string,
  input: WorkspaceScopedInput,
): Promise<boolean> {
  return deleteConnectorBySurface({
    connectorId: channelId,
    compatSurface: 'channel',
    workspaceId: input.workspaceId,
  });
}

export async function listWorkspaceDataConnectors(
  input: WorkspaceScopedInput,
): Promise<WorkspaceDataConnectorRecord[]> {
  const rows = await listConnectorsBySurface({
    workspaceId: input.workspaceId,
    compatSurface: 'data_connector',
  });
  return rows.map(toDataConnectorRecord);
}

export async function getWorkspaceDataConnector(
  connectorId: string,
  input: WorkspaceScopedInput,
): Promise<WorkspaceDataConnectorRecord | null> {
  const row = await getConnector(connectorId, input.workspaceId);
  if (!row || row.config_json?.compatSurface !== 'data_connector') return null;
  return toDataConnectorRecord(row);
}

export interface CreateWorkspaceDataConnectorInput {
  workspaceId?: string;
  kind: DataConnectorKind;
  displayName: string;
  config?: unknown;
  enabled?: boolean;
  createdBy: string;
}

export async function createWorkspaceDataConnector(
  input: CreateWorkspaceDataConnectorInput,
): Promise<WorkspaceDataConnectorRecord> {
  if (
    !DATA_CONNECTOR_KINDS.includes(input.kind as SupportedDataConnectorKind)
  ) {
    throw new Error(`Unsupported data connector kind: ${input.kind}`);
  }
  const kind = input.kind as SupportedDataConnectorKind;
  const workspaceId = await resolveConnectorWorkspaceId(input.workspaceId);
  const displayName = input.displayName.trim();
  if (!displayName) throw new Error('display_name is required');
  const config = dataConnectorConfig({
    kind,
    displayName,
    config: validateDataConnectorConfig(kind, input.config),
    enabled: input.enabled ?? true,
  });
  const db = getDbPg();
  const rows = await db<ConnectorRow[]>`
    with inserted as (
      insert into public.connectors (workspace_id, service, config_json)
      values (${workspaceId}::uuid, ${serviceForDataConnector(kind)}, ${db.json(config as never)})
      returning *
    )
    select i.*, 0::bigint as bound_talk_count
    from inserted i
  `;
  return toDataConnectorRecord(rows[0]!);
}

export interface UpdateWorkspaceDataConnectorInput {
  displayName?: string;
  config?: unknown;
  enabled?: boolean;
  updatedBy: string;
}

export async function updateWorkspaceDataConnector(
  connectorId: string,
  patch: UpdateWorkspaceDataConnectorInput,
  input: WorkspaceScopedInput,
): Promise<WorkspaceDataConnectorRecord | null> {
  const existing = await getWorkspaceDataConnector(connectorId, {
    workspaceId: input.workspaceId,
  });
  if (!existing) return null;
  const displayName =
    patch.displayName !== undefined
      ? patch.displayName.trim()
      : existing.display_name;
  if (!displayName) throw new Error('display_name is required');
  const config = dataConnectorConfig({
    kind: existing.kind as SupportedDataConnectorKind,
    displayName,
    config:
      patch.config !== undefined
        ? validateDataConnectorConfig(
            existing.kind as SupportedDataConnectorKind,
            patch.config,
          )
        : stripSystemConfigKeys(existing.config_json),
    enabled: patch.enabled ?? existing.enabled,
  });
  const db = getDbPg();
  const rows = await db<ConnectorRow[]>`
    with updated as (
      update public.connectors
      set config_json = ${db.json(config as never)},
          updated_at = now()
      where id = ${connectorId}::uuid
        and workspace_id = ${input.workspaceId}::uuid
        and config_json->>'compatSurface' = 'data_connector'
      returning *
    )
    select u.*,
           (select count(distinct cb.talk_id)::bigint from public.connector_bindings cb where cb.connector_id = u.id) as bound_talk_count
    from updated u
  `;
  return rows[0] ? toDataConnectorRecord(rows[0]) : null;
}

export async function deleteWorkspaceDataConnector(
  connectorId: string,
  input: WorkspaceScopedInput,
): Promise<boolean> {
  return deleteConnectorBySurface({
    connectorId,
    compatSurface: 'data_connector',
    workspaceId: input.workspaceId,
  });
}

async function deleteConnectorBySurface(input: {
  connectorId: string;
  compatSurface: CompatSurface;
  workspaceId: string;
}): Promise<boolean> {
  const db = getDbPg();
  return withExistingOrNewTransaction(db, async (tx) => {
    const existingRows = await tx<
      Array<{ workspace_id: string; secret_ref: string | null }>
    >`
      select workspace_id, secret_ref
      from public.connectors
      where id = ${input.connectorId}::uuid
        and config_json->>'compatSurface' = ${input.compatSurface}
        and workspace_id = ${input.workspaceId}::uuid
      for update
    `;
    const existing = existingRows[0];
    if (!existing) return false;
    if (!(await currentUserIsWorkspaceAdmin(tx, existing.workspace_id))) {
      return false;
    }
    return withTrustedDbWrites(async () => {
      const rows = await tx<Array<{ id: string }>>`
        delete from public.connectors
        where id = ${input.connectorId}::uuid
          and config_json->>'compatSurface' = ${input.compatSurface}
          and workspace_id = ${input.workspaceId}::uuid
        returning id
      `;
      if (existing.secret_ref) {
        await tx`
          delete from public.connector_secrets
          where workspace_id = ${existing.workspace_id}::uuid
            and id = ${existing.secret_ref}::uuid
        `;
      }
      return rows.length > 0;
    });
  });
}

async function setConnectorCredential(
  connectorId: string,
  compatSurface: CompatSurface,
  payload: { apiKey: string; organizationId?: string } | null,
  workspaceId: string,
): Promise<ConnectorRow | undefined> {
  const db = getDbPg();
  return withExistingOrNewTransaction(db, async (tx) => {
    const existingRows = await tx<
      Array<{ workspace_id: string; secret_ref: string | null }>
    >`
      select workspace_id, secret_ref
      from public.connectors
      where id = ${connectorId}::uuid
        and config_json->>'compatSurface' = ${compatSurface}
        and workspace_id = ${workspaceId}::uuid
      for update
    `;
    const existing = existingRows[0];
    if (!existing) return undefined;
    if (!(await currentUserIsWorkspaceAdmin(tx, existing.workspace_id))) {
      return undefined;
    }

    return withTrustedDbWrites(async () => {
      let nextSecretRef: string | null = null;
      if (payload) {
        const ciphertext = await encryptProviderSecret({
          apiKey: payload.apiKey,
          ...(payload.organizationId
            ? { organizationId: payload.organizationId }
            : {}),
        });
        const secretRows = await tx<Array<{ id: string }>>`
          insert into public.connector_secrets (workspace_id, ciphertext)
          values (${existing.workspace_id}::uuid, ${ciphertext})
          returning id
        `;
        nextSecretRef = secretRows[0]!.id;
      }

      const updated = await tx<ConnectorRow[]>`
        with updated as (
          update public.connectors
          set secret_ref = ${nextSecretRef}::uuid,
              authorized = ${payload !== null},
              authorized_at = case when ${payload !== null}::boolean then now() else null end,
              updated_at = now()
          where id = ${connectorId}::uuid
            and config_json->>'compatSurface' = ${compatSurface}
            and workspace_id = ${workspaceId}::uuid
          returning *
        )
        select u.*,
               (select count(distinct cb.talk_id)::bigint from public.connector_bindings cb where cb.connector_id = u.id) as bound_talk_count
        from updated u
      `;

      if (existing.secret_ref && existing.secret_ref !== nextSecretRef) {
        await tx`
          delete from public.connector_secrets
          where workspace_id = ${existing.workspace_id}::uuid
            and id = ${existing.secret_ref}::uuid
        `;
      }
      return updated[0];
    });
  });
}

export async function setWorkspaceChannelCredential(
  channelId: string,
  payload: { apiKey: string; organizationId?: string } | null,
  _updatedBy: string,
  input: WorkspaceScopedInput,
): Promise<WorkspaceChannelRecord | null> {
  const row = await setConnectorCredential(
    channelId,
    'channel',
    payload,
    input.workspaceId,
  );
  return row && row.config_json?.compatSurface === 'channel'
    ? toChannelRecord(row)
    : null;
}

export async function setWorkspaceDataConnectorCredential(
  connectorId: string,
  payload: { apiKey: string; organizationId?: string } | null,
  _updatedBy: string,
  input: WorkspaceScopedInput,
): Promise<WorkspaceDataConnectorRecord | null> {
  const row = await setConnectorCredential(
    connectorId,
    'data_connector',
    payload,
    input.workspaceId,
  );
  return row && row.config_json?.compatSurface === 'data_connector'
    ? toDataConnectorRecord(row)
    : null;
}

export async function decryptWorkspaceChannelCredential(
  channelId: string,
  input: WorkspaceScopedInput,
): Promise<{ apiKey: string; organizationId?: string } | null> {
  return decryptConnectorCredential(channelId, 'channel', input.workspaceId);
}

export async function decryptWorkspaceDataConnectorCredential(
  connectorId: string,
  input: WorkspaceScopedInput,
): Promise<{ apiKey: string; organizationId?: string } | null> {
  return decryptConnectorCredential(
    connectorId,
    'data_connector',
    input.workspaceId,
  );
}

async function decryptConnectorCredential(
  connectorId: string,
  compatSurface: CompatSurface,
  workspaceId: string,
): Promise<{ apiKey: string; organizationId?: string } | null> {
  const db = getDbPg();
  const connectorRows = await db<
    Array<{
      workspace_id: string;
      secret_ref: string | null;
      config_json: ConnectorConfig;
    }>
  >`
    select c.workspace_id, c.secret_ref, c.config_json
    from public.connectors c
    where c.id = ${connectorId}::uuid
      and c.config_json->>'compatSurface' = ${compatSurface}
      and c.authorized = true
      and (
        c.secret_ref is not null
        or (
          ${compatSurface} = 'channel'
          and c.config_json->>'credentialSource' = 'workspace_slack_install'
        )
      )
      and c.workspace_id = ${workspaceId}::uuid
    limit 1
  `;
  const connector = connectorRows[0];
  if (!connector) return null;
  let secretRef = connector.secret_ref;
  if (!secretRef && compatSurface === 'channel') {
    const slackTeamId = readSlackTeamId(connector.config_json ?? {});
    if (!slackTeamId) return null;
    const installRows = await db<Array<{ secret_ref: string | null }>>`
      select secret_ref
      from public.connectors
      where workspace_id = ${connector.workspace_id}::uuid
        and service = 'slack'
        and authorized = true
        and secret_ref is not null
        and config_json->>'compatSurface' = 'slack_install'
        and config_json->>'teamId' = ${slackTeamId}
      limit 1
    `;
    secretRef = installRows[0]?.secret_ref ?? null;
  }
  if (!secretRef) return null;
  const rows = await withTrustedDbWrites(
    () => db<Array<{ ciphertext: string }>>`
      select ciphertext
      from public.connector_secrets
      where workspace_id = ${connector.workspace_id}::uuid
        and id = ${secretRef}::uuid
      limit 1
    `,
  );
  const ciphertext = rows[0]?.ciphertext;
  if (!ciphertext) return null;
  return decryptProviderSecret(ciphertext);
}

export interface TalkChannelLink {
  talkId: string;
  channelId: string;
  ownerId: string;
  createdAt: string;
}

export interface TalkDataConnectorLink {
  talkId: string;
  dataConnectorId: string;
  ownerId: string;
  createdAt: string;
}

async function listDefaultTargetBindings(input: {
  talkId: string;
  compatSurface: CompatSurface;
}): Promise<
  Array<{
    talk_id: string;
    connector_id: string;
    created_by_user_id: string | null;
    created_at: string;
  }>
> {
  const db = getDbPg();
  return db`
    select cb.talk_id, cb.connector_id, cb.created_by_user_id, cb.created_at
    from public.connector_bindings cb
    join public.connectors c
      on c.workspace_id = cb.workspace_id
     and c.id = cb.connector_id
    where cb.talk_id = ${input.talkId}::uuid
      and cb.target is null
      and c.config_json->>'compatSurface' = ${input.compatSurface}
    order by cb.created_at asc, cb.id asc
  `;
}

async function resolveEditableTalkConnector(input: {
  talkId: string;
  connectorId: string;
  actorId: string;
  compatSurface: CompatSurface;
  requireAuthorized: boolean;
}): Promise<{ workspace_id: string } | null> {
  const db = getDbPg();
  const rows = await db<
    Array<{
      workspace_id: string;
      created_by: string;
      role: 'owner' | 'admin' | 'member' | 'guest';
      authorized: boolean;
      enabled: boolean;
      has_required_credential: boolean;
    }>
  >`
    select
      t.workspace_id,
      t.created_by,
      wm.role,
      case
        when c.service = 'gdrive'
          and c.config_json->>'compatSurface' = 'data_connector'
          and c.config_json->>'dataConnectorKind' in ('google_docs', 'google_sheets')
          then true
        else c.authorized
      end as authorized,
      coalesce((c.config_json->>'enabled')::boolean, true) as enabled,
      case
        when c.service = 'gdrive'
          and c.config_json->>'compatSurface' = 'data_connector'
          and c.config_json->>'dataConnectorKind' in ('google_docs', 'google_sheets')
          then true
        when c.secret_ref is not null then true
        when c.config_json->>'credentialSource' = 'workspace_slack_install'
          then exists (
            select 1
            from public.connectors si
            where si.workspace_id = c.workspace_id
              and si.service = 'slack'
              and si.authorized = true
              and si.secret_ref is not null
              and si.config_json->>'compatSurface' = 'slack_install'
              and si.config_json->>'teamId' =
                coalesce(c.config_json->>'teamId', c.config_json->>'workspace_id')
          )
        else false
      end as has_required_credential
    from public.talks t
    join public.workspace_members wm
      on wm.workspace_id = t.workspace_id
     and wm.user_id = ${input.actorId}::uuid
    join public.connectors c
      on c.workspace_id = t.workspace_id
     and c.id = ${input.connectorId}::uuid
     and c.config_json->>'compatSurface' = ${input.compatSurface}
    where t.id = ${input.talkId}::uuid
    limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  if (
    row.role === 'guest' ||
    (row.role !== 'owner' &&
      row.role !== 'admin' &&
      row.created_by !== input.actorId)
  ) {
    return null;
  }
  if (
    input.requireAuthorized &&
    (!row.enabled || !row.authorized || !row.has_required_credential)
  ) {
    return null;
  }
  return { workspace_id: row.workspace_id };
}

export async function listTalkChannelLinks(
  talkId: string,
): Promise<TalkChannelLink[]> {
  const rows = await listDefaultTargetBindings({
    talkId,
    compatSurface: 'channel',
  });
  return rows.map((row) => ({
    talkId: row.talk_id,
    channelId: row.connector_id,
    ownerId: row.created_by_user_id ?? '',
    createdAt: row.created_at,
  }));
}

export async function listTalkDataConnectorLinks(
  talkId: string,
): Promise<TalkDataConnectorLink[]> {
  const rows = await listDefaultTargetBindings({
    talkId,
    compatSurface: 'data_connector',
  });
  return rows.map((row) => ({
    talkId: row.talk_id,
    dataConnectorId: row.connector_id,
    ownerId: row.created_by_user_id ?? '',
    createdAt: row.created_at,
  }));
}

async function insertDefaultTargetBinding(input: {
  talkId: string;
  connectorId: string;
  createdBy: string;
  compatSurface: CompatSurface;
}): Promise<boolean> {
  const db = getDbPg();
  const currentUserId = getCurrentUserId();
  if (!currentUserId || currentUserId !== input.createdBy) return false;
  const row = await resolveEditableTalkConnector({
    talkId: input.talkId,
    connectorId: input.connectorId,
    actorId: currentUserId,
    compatSurface: input.compatSurface,
    requireAuthorized: true,
  });
  if (!row) return false;
  await withTrustedDbWrites(async () => {
    await db`
      insert into public.connector_bindings (
        workspace_id,
        connector_id,
        talk_id,
        target,
        scope,
        enabled,
        meta_json,
        created_by_user_id
      )
      values (
        ${row.workspace_id}::uuid,
        ${input.connectorId}::uuid,
        ${input.talkId}::uuid,
        null,
        '{}'::text[],
        true,
        ${db.json({ compatSurface: input.compatSurface } as never)},
        ${input.createdBy}::uuid
      )
      on conflict (connector_id, talk_id) where target is null do nothing
    `;
  });
  return true;
}

export async function linkTalkChannel(input: {
  talkId: string;
  channelId: string;
  ownerId: string;
}): Promise<boolean> {
  return insertDefaultTargetBinding({
    talkId: input.talkId,
    connectorId: input.channelId,
    createdBy: input.ownerId,
    compatSurface: 'channel',
  });
}

export async function unlinkTalkChannel(input: {
  talkId: string;
  channelId: string;
}): Promise<boolean> {
  return deleteDefaultTargetBinding({
    talkId: input.talkId,
    connectorId: input.channelId,
    compatSurface: 'channel',
  });
}

export async function linkTalkDataConnector(input: {
  talkId: string;
  dataConnectorId: string;
  ownerId: string;
}): Promise<boolean> {
  return insertDefaultTargetBinding({
    talkId: input.talkId,
    connectorId: input.dataConnectorId,
    createdBy: input.ownerId,
    compatSurface: 'data_connector',
  });
}

export async function unlinkTalkDataConnector(input: {
  talkId: string;
  dataConnectorId: string;
}): Promise<boolean> {
  return deleteDefaultTargetBinding({
    talkId: input.talkId,
    connectorId: input.dataConnectorId,
    compatSurface: 'data_connector',
  });
}

async function deleteDefaultTargetBinding(input: {
  talkId: string;
  connectorId: string;
  compatSurface: CompatSurface;
}): Promise<boolean> {
  const db = getDbPg();
  const actorId = getCurrentUserId();
  if (!actorId) return false;
  const row = await resolveEditableTalkConnector({
    talkId: input.talkId,
    connectorId: input.connectorId,
    actorId,
    compatSurface: input.compatSurface,
    requireAuthorized: false,
  });
  if (!row) return false;
  return withTrustedDbWrites(async () => {
    const rows = await db<Array<{ id: string }>>`
      delete from public.connector_bindings
      where workspace_id = ${row.workspace_id}::uuid
        and talk_id = ${input.talkId}::uuid
        and connector_id = ${input.connectorId}::uuid
        and target is null
      returning id
    `;
    return rows.length > 0;
  });
}

export interface TalkConnectorChannelPickerItem {
  id: string;
  kind: ChannelKind;
  displayName: string;
  enabled: boolean;
  hasCredential: boolean;
  linked: boolean;
}

export interface TalkConnectorDataConnectorPickerItem {
  id: string;
  kind: DataConnectorKind;
  displayName: string;
  enabled: boolean;
  hasCredential: boolean;
  linked: boolean;
}

export interface TalkConnectorsView {
  channels: TalkConnectorChannelPickerItem[];
  dataConnectors: TalkConnectorDataConnectorPickerItem[];
}

export async function getTalkConnectorsView(input: {
  workspaceId: string;
  talkId: string;
}): Promise<TalkConnectorsView> {
  const [channels, dataConnectors, channelLinks, dataConnectorLinks] =
    await Promise.all([
      listWorkspaceChannels({ workspaceId: input.workspaceId }),
      listWorkspaceDataConnectors({ workspaceId: input.workspaceId }),
      listTalkChannelLinks(input.talkId),
      listTalkDataConnectorLinks(input.talkId),
    ]);
  const linkedChannelIds = new Set(channelLinks.map((link) => link.channelId));
  const linkedDataConnectorIds = new Set(
    dataConnectorLinks.map((link) => link.dataConnectorId),
  );
  return {
    channels: channels.map((channel) => ({
      id: channel.id,
      kind: channel.kind,
      displayName: channel.display_name,
      enabled: channel.enabled,
      hasCredential: channel.has_credential,
      linked: linkedChannelIds.has(channel.id),
    })),
    dataConnectors: dataConnectors.map((connector) => ({
      id: connector.id,
      kind: connector.kind,
      displayName: connector.display_name,
      enabled: connector.enabled,
      hasCredential: connector.has_credential,
      linked: linkedDataConnectorIds.has(connector.id),
    })),
  };
}
