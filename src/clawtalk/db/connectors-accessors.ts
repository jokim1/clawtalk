// Connectors refactor PR 1 — workspace-global channel + data-connector
// accessors.
//
// Read = SELECT for any authenticated user (executor + Talk-link
// picker need to see the pool).
// Write = admins only — enforced at the route layer via
// `isAdminLike(auth.role)`, with the underlying `workspace_*` RLS
// policy in 0019/0020 as belt + suspenders (uses
// `current_user_is_workspace_admin()` from 0008).
//
// Talk-link tables use the talk-scoped `owner_id = auth.uid()` pattern
// from `talk_state_entries` / `talk_resource_bindings` (denormalized
// owner, RLS reads owner_id directly — no join-through-talks). Toggle
// ON inserts a row; toggle OFF deletes it. Upserts use
// `on conflict do nothing` so repeat-clicks are idempotent.
//
// `config_json` is validated against per-kind Zod schemas before
// insert/update. Schemas are intentionally loose — enough to reject
// obvious junk, not enough to lock out forward changes. Tightening
// happens kind-by-kind in PR 4 alongside real verification logic.
//
// Credentials live in the `ciphertext` column and are written via a
// separate `set*Credential` function so the encryption pipeline
// (`encryptProviderSecret`) is the only path that touches them.

import { z } from 'zod';

import { getDbPg } from '../../db.js';
import {
  decryptProviderSecret,
  encryptProviderSecret,
} from '../llm/provider-secret-store.js';

// ---------------------------------------------------------------------------
// Kind enums + Zod config schemas
// ---------------------------------------------------------------------------

export const CHANNEL_KINDS = ['slack', 'telegram'] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

export const DATA_CONNECTOR_KINDS = [
  'posthog',
  'google_docs',
  'google_sheets',
] as const;
export type DataConnectorKind = (typeof DATA_CONNECTOR_KINDS)[number];

// Per-kind config_json schemas. Loose by design — these reject obvious
// junk (empty strings, wrong types) without locking out future config
// additions. PR 4 will tighten alongside real verification logic.
const CHANNEL_CONFIG_SCHEMAS: Record<ChannelKind, z.ZodTypeAny> = {
  slack: z
    .object({
      workspace_id: z.string().min(1).optional(),
      channel_id: z.string().min(1).optional(),
    })
    .passthrough(),
  telegram: z
    .object({
      bot_id: z.string().min(1).optional(),
      chat_id: z.string().min(1).optional(),
    })
    .passthrough(),
};

const DATA_CONNECTOR_CONFIG_SCHEMAS: Record<DataConnectorKind, z.ZodTypeAny> = {
  posthog: z
    .object({
      project_id: z.string().min(1).optional(),
      host: z.string().url().optional(),
    })
    .passthrough(),
  google_docs: z
    .object({
      folder_id: z.string().min(1).optional(),
    })
    .passthrough(),
  google_sheets: z
    .object({
      folder_id: z.string().min(1).optional(),
    })
    .passthrough(),
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

function validateChannelConfig(
  kind: ChannelKind,
  config: unknown,
): Record<string, unknown> {
  const result = CHANNEL_CONFIG_SCHEMAS[kind].safeParse(config ?? {});
  if (!result.success) {
    throw new ConnectorConfigInvalidError(
      result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data as Record<string, unknown>;
}

function validateDataConnectorConfig(
  kind: DataConnectorKind,
  config: unknown,
): Record<string, unknown> {
  const result = DATA_CONNECTOR_CONFIG_SCHEMAS[kind].safeParse(config ?? {});
  if (!result.success) {
    throw new ConnectorConfigInvalidError(
      result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Record types
// ---------------------------------------------------------------------------

export interface WorkspaceChannelRecord {
  id: string;
  kind: ChannelKind;
  display_name: string;
  config_json: Record<string, unknown>;
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
  kind: DataConnectorKind;
  display_name: string;
  config_json: Record<string, unknown>;
  has_credential: boolean;
  enc_key_version: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
  bound_talk_count: number;
}

interface ChannelRow {
  id: string;
  kind: ChannelKind;
  display_name: string;
  config_json: Record<string, unknown>;
  ciphertext: string | null;
  enc_key_version: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
  bound_talk_count: string | number;
}

interface DataConnectorRow {
  id: string;
  kind: DataConnectorKind;
  display_name: string;
  config_json: Record<string, unknown>;
  ciphertext: string | null;
  enc_key_version: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
  bound_talk_count: string | number;
}

function toChannelRecord(row: ChannelRow): WorkspaceChannelRecord {
  return {
    id: row.id,
    kind: row.kind,
    display_name: row.display_name,
    config_json: row.config_json ?? {},
    has_credential: row.ciphertext !== null && row.ciphertext.length > 0,
    enc_key_version: row.enc_key_version,
    enabled: row.enabled,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
    updated_by: row.updated_by,
    bound_talk_count: Number(row.bound_talk_count) || 0,
  };
}

function toDataConnectorRecord(
  row: DataConnectorRow,
): WorkspaceDataConnectorRecord {
  return {
    id: row.id,
    kind: row.kind,
    display_name: row.display_name,
    config_json: row.config_json ?? {},
    has_credential: row.ciphertext !== null && row.ciphertext.length > 0,
    enc_key_version: row.enc_key_version,
    enabled: row.enabled,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
    updated_by: row.updated_by,
    bound_talk_count: Number(row.bound_talk_count) || 0,
  };
}

// ---------------------------------------------------------------------------
// Workspace channel accessors
// ---------------------------------------------------------------------------

export async function listWorkspaceChannels(): Promise<
  WorkspaceChannelRecord[]
> {
  const db = getDbPg();
  const rows = await db<ChannelRow[]>`
    select c.id, c.kind, c.display_name, c.config_json, c.ciphertext,
           c.enc_key_version, c.enabled, c.created_at, c.updated_at,
           c.created_by, c.updated_by,
           public.workspace_channel_bound_talk_count(c.id) as bound_talk_count
    from public.workspace_channels c
    order by c.display_name asc, c.id asc
  `;
  return rows.map(toChannelRecord);
}

export async function getWorkspaceChannel(
  channelId: string,
): Promise<WorkspaceChannelRecord | null> {
  const db = getDbPg();
  const rows = await db<ChannelRow[]>`
    select c.id, c.kind, c.display_name, c.config_json, c.ciphertext,
           c.enc_key_version, c.enabled, c.created_at, c.updated_at,
           c.created_by, c.updated_by,
           public.workspace_channel_bound_talk_count(c.id) as bound_talk_count
    from public.workspace_channels c
    where c.id = ${channelId}::uuid
    limit 1
  `;
  return rows[0] ? toChannelRecord(rows[0]) : null;
}

export interface CreateWorkspaceChannelInput {
  kind: ChannelKind;
  displayName: string;
  config?: unknown;
  enabled?: boolean;
  createdBy: string;
}

export async function createWorkspaceChannel(
  input: CreateWorkspaceChannelInput,
): Promise<WorkspaceChannelRecord> {
  if (!CHANNEL_KINDS.includes(input.kind)) {
    throw new Error(`Unsupported channel kind: ${input.kind}`);
  }
  const displayName = input.displayName.trim();
  if (!displayName) {
    throw new Error('display_name is required');
  }
  const config = validateChannelConfig(input.kind, input.config);
  const enabled = input.enabled ?? true;
  const db = getDbPg();
  const rows = await db<ChannelRow[]>`
    with inserted as (
      insert into public.workspace_channels
        (kind, display_name, config_json, enabled, created_by, updated_by)
      values (${input.kind}, ${displayName}, ${db.json(config as never)},
              ${enabled}, ${input.createdBy}::uuid,
              ${input.createdBy}::uuid)
      returning *
    )
    select i.*, 0::bigint as bound_talk_count
    from inserted i
  `;
  if (!rows[0]) {
    throw new Error('createWorkspaceChannel returned no row');
  }
  return toChannelRecord(rows[0]);
}

export interface UpdateWorkspaceChannelInput {
  displayName?: string;
  config?: unknown;
  enabled?: boolean;
  updatedBy: string;
}

export async function updateWorkspaceChannel(
  channelId: string,
  patch: UpdateWorkspaceChannelInput,
): Promise<WorkspaceChannelRecord | null> {
  const existing = await getWorkspaceChannel(channelId);
  if (!existing) return null;

  const nextDisplayName =
    patch.displayName !== undefined
      ? patch.displayName.trim()
      : existing.display_name;
  if (!nextDisplayName) {
    throw new Error('display_name is required');
  }
  const nextConfig =
    patch.config !== undefined
      ? validateChannelConfig(existing.kind, patch.config)
      : existing.config_json;
  const nextEnabled = patch.enabled ?? existing.enabled;

  const db = getDbPg();
  const rows = await db<ChannelRow[]>`
    with updated as (
      update public.workspace_channels
      set display_name = ${nextDisplayName},
          config_json = ${db.json(nextConfig as never)},
          enabled = ${nextEnabled},
          updated_by = ${patch.updatedBy}::uuid,
          updated_at = now()
      where id = ${channelId}::uuid
      returning *
    )
    select u.*,
           public.workspace_channel_bound_talk_count(u.id) as bound_talk_count
    from updated u
  `;
  return rows[0] ? toChannelRecord(rows[0]) : null;
}

export async function deleteWorkspaceChannel(
  channelId: string,
): Promise<boolean> {
  const db = getDbPg();
  const rows = await db<Array<{ id: string }>>`
    delete from public.workspace_channels
    where id = ${channelId}::uuid
    returning id
  `;
  return rows.length > 0;
}

export async function setWorkspaceChannelCredential(
  channelId: string,
  payload: { apiKey: string; organizationId?: string } | null,
  updatedBy: string,
): Promise<WorkspaceChannelRecord | null> {
  const db = getDbPg();
  if (payload === null) {
    const rows = await db<ChannelRow[]>`
      with updated as (
        update public.workspace_channels
        set ciphertext = null,
            updated_by = ${updatedBy}::uuid,
            updated_at = now()
        where id = ${channelId}::uuid
        returning *
      )
      select u.*,
             public.workspace_channel_bound_talk_count(u.id) as bound_talk_count
      from updated u
    `;
    return rows[0] ? toChannelRecord(rows[0]) : null;
  }
  const ciphertext = await encryptProviderSecret({
    apiKey: payload.apiKey,
    ...(payload.organizationId
      ? { organizationId: payload.organizationId }
      : {}),
  });
  const rows = await db<ChannelRow[]>`
    with updated as (
      update public.workspace_channels
      set ciphertext = ${ciphertext},
          updated_by = ${updatedBy}::uuid,
          updated_at = now()
      where id = ${channelId}::uuid
      returning *
    )
    select u.*,
           public.workspace_channel_bound_talk_count(u.id) as bound_talk_count
    from updated u
  `;
  return rows[0] ? toChannelRecord(rows[0]) : null;
}

export async function decryptWorkspaceChannelCredential(
  channelId: string,
): Promise<{ apiKey: string; organizationId?: string } | null> {
  const db = getDbPg();
  const rows = await db<Array<{ ciphertext: string | null }>>`
    select ciphertext from public.workspace_channels
    where id = ${channelId}::uuid
    limit 1
  `;
  const ciphertext = rows[0]?.ciphertext;
  if (!ciphertext) return null;
  return decryptProviderSecret(ciphertext);
}

// ---------------------------------------------------------------------------
// Workspace data-connector accessors
// ---------------------------------------------------------------------------

export async function listWorkspaceDataConnectors(): Promise<
  WorkspaceDataConnectorRecord[]
> {
  const db = getDbPg();
  const rows = await db<DataConnectorRow[]>`
    select d.id, d.kind, d.display_name, d.config_json, d.ciphertext,
           d.enc_key_version, d.enabled, d.created_at, d.updated_at,
           d.created_by, d.updated_by,
           public.workspace_data_connector_bound_talk_count(d.id) as bound_talk_count
    from public.workspace_data_connectors d
    order by d.display_name asc, d.id asc
  `;
  return rows.map(toDataConnectorRecord);
}

export async function getWorkspaceDataConnector(
  connectorId: string,
): Promise<WorkspaceDataConnectorRecord | null> {
  const db = getDbPg();
  const rows = await db<DataConnectorRow[]>`
    select d.id, d.kind, d.display_name, d.config_json, d.ciphertext,
           d.enc_key_version, d.enabled, d.created_at, d.updated_at,
           d.created_by, d.updated_by,
           public.workspace_data_connector_bound_talk_count(d.id) as bound_talk_count
    from public.workspace_data_connectors d
    where d.id = ${connectorId}::uuid
    limit 1
  `;
  return rows[0] ? toDataConnectorRecord(rows[0]) : null;
}

export interface CreateWorkspaceDataConnectorInput {
  kind: DataConnectorKind;
  displayName: string;
  config?: unknown;
  enabled?: boolean;
  createdBy: string;
}

export async function createWorkspaceDataConnector(
  input: CreateWorkspaceDataConnectorInput,
): Promise<WorkspaceDataConnectorRecord> {
  if (!DATA_CONNECTOR_KINDS.includes(input.kind)) {
    throw new Error(`Unsupported data connector kind: ${input.kind}`);
  }
  const displayName = input.displayName.trim();
  if (!displayName) {
    throw new Error('display_name is required');
  }
  const config = validateDataConnectorConfig(input.kind, input.config);
  const enabled = input.enabled ?? true;
  const db = getDbPg();
  const rows = await db<DataConnectorRow[]>`
    with inserted as (
      insert into public.workspace_data_connectors
        (kind, display_name, config_json, enabled, created_by, updated_by)
      values (${input.kind}, ${displayName}, ${db.json(config as never)},
              ${enabled}, ${input.createdBy}::uuid,
              ${input.createdBy}::uuid)
      returning *
    )
    select i.*, 0::bigint as bound_talk_count
    from inserted i
  `;
  if (!rows[0]) {
    throw new Error('createWorkspaceDataConnector returned no row');
  }
  return toDataConnectorRecord(rows[0]);
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
): Promise<WorkspaceDataConnectorRecord | null> {
  const existing = await getWorkspaceDataConnector(connectorId);
  if (!existing) return null;

  const nextDisplayName =
    patch.displayName !== undefined
      ? patch.displayName.trim()
      : existing.display_name;
  if (!nextDisplayName) {
    throw new Error('display_name is required');
  }
  const nextConfig =
    patch.config !== undefined
      ? validateDataConnectorConfig(existing.kind, patch.config)
      : existing.config_json;
  const nextEnabled = patch.enabled ?? existing.enabled;

  const db = getDbPg();
  const rows = await db<DataConnectorRow[]>`
    with updated as (
      update public.workspace_data_connectors
      set display_name = ${nextDisplayName},
          config_json = ${db.json(nextConfig as never)},
          enabled = ${nextEnabled},
          updated_by = ${patch.updatedBy}::uuid,
          updated_at = now()
      where id = ${connectorId}::uuid
      returning *
    )
    select u.*,
           public.workspace_data_connector_bound_talk_count(u.id) as bound_talk_count
    from updated u
  `;
  return rows[0] ? toDataConnectorRecord(rows[0]) : null;
}

export async function deleteWorkspaceDataConnector(
  connectorId: string,
): Promise<boolean> {
  const db = getDbPg();
  const rows = await db<Array<{ id: string }>>`
    delete from public.workspace_data_connectors
    where id = ${connectorId}::uuid
    returning id
  `;
  return rows.length > 0;
}

export async function setWorkspaceDataConnectorCredential(
  connectorId: string,
  payload: { apiKey: string; organizationId?: string } | null,
  updatedBy: string,
): Promise<WorkspaceDataConnectorRecord | null> {
  const db = getDbPg();
  if (payload === null) {
    const rows = await db<DataConnectorRow[]>`
      with updated as (
        update public.workspace_data_connectors
        set ciphertext = null,
            updated_by = ${updatedBy}::uuid,
            updated_at = now()
        where id = ${connectorId}::uuid
        returning *
      )
      select u.*,
             public.workspace_data_connector_bound_talk_count(u.id) as bound_talk_count
      from updated u
    `;
    return rows[0] ? toDataConnectorRecord(rows[0]) : null;
  }
  const ciphertext = await encryptProviderSecret({
    apiKey: payload.apiKey,
    ...(payload.organizationId
      ? { organizationId: payload.organizationId }
      : {}),
  });
  const rows = await db<DataConnectorRow[]>`
    with updated as (
      update public.workspace_data_connectors
      set ciphertext = ${ciphertext},
          updated_by = ${updatedBy}::uuid,
          updated_at = now()
      where id = ${connectorId}::uuid
      returning *
    )
    select u.*,
           public.workspace_data_connector_bound_talk_count(u.id) as bound_talk_count
    from updated u
  `;
  return rows[0] ? toDataConnectorRecord(rows[0]) : null;
}

export async function decryptWorkspaceDataConnectorCredential(
  connectorId: string,
): Promise<{ apiKey: string; organizationId?: string } | null> {
  const db = getDbPg();
  const rows = await db<Array<{ ciphertext: string | null }>>`
    select ciphertext from public.workspace_data_connectors
    where id = ${connectorId}::uuid
    limit 1
  `;
  const ciphertext = rows[0]?.ciphertext;
  if (!ciphertext) return null;
  return decryptProviderSecret(ciphertext);
}

// ---------------------------------------------------------------------------
// Talk-link accessors (talk-scoped, owner_id = auth.uid())
// ---------------------------------------------------------------------------

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

export async function listTalkChannelLinks(
  talkId: string,
): Promise<TalkChannelLink[]> {
  const db = getDbPg();
  const rows = await db<
    Array<{
      talk_id: string;
      channel_id: string;
      owner_id: string;
      created_at: string;
    }>
  >`
    select talk_id, channel_id, owner_id, created_at
    from public.talk_channel_links
    where talk_id = ${talkId}::uuid
  `;
  return rows.map((row) => ({
    talkId: row.talk_id,
    channelId: row.channel_id,
    ownerId: row.owner_id,
    createdAt: row.created_at,
  }));
}

export async function listTalkDataConnectorLinks(
  talkId: string,
): Promise<TalkDataConnectorLink[]> {
  const db = getDbPg();
  const rows = await db<
    Array<{
      talk_id: string;
      data_connector_id: string;
      owner_id: string;
      created_at: string;
    }>
  >`
    select talk_id, data_connector_id, owner_id, created_at
    from public.talk_data_connector_links
    where talk_id = ${talkId}::uuid
  `;
  return rows.map((row) => ({
    talkId: row.talk_id,
    dataConnectorId: row.data_connector_id,
    ownerId: row.owner_id,
    createdAt: row.created_at,
  }));
}

/**
 * Upsert a (talk_id, channel_id) link. Idempotent on conflict — a
 * repeated toggle-on click is a no-op rather than an error. Returns
 * `true` when a row exists after the call (insert or pre-existing),
 * `false` only on RLS rejection / missing parent rows (postgres throws
 * in that case, caught at the route layer).
 */
export async function linkTalkChannel(input: {
  talkId: string;
  channelId: string;
  ownerId: string;
}): Promise<boolean> {
  const db = getDbPg();
  await db`
    insert into public.talk_channel_links (talk_id, channel_id, owner_id)
    values (${input.talkId}::uuid, ${input.channelId}::uuid,
            ${input.ownerId}::uuid)
    on conflict (talk_id, channel_id) do nothing
  `;
  return true;
}

export async function unlinkTalkChannel(input: {
  talkId: string;
  channelId: string;
}): Promise<boolean> {
  const db = getDbPg();
  const rows = await db<Array<{ talk_id: string }>>`
    delete from public.talk_channel_links
    where talk_id = ${input.talkId}::uuid
      and channel_id = ${input.channelId}::uuid
    returning talk_id
  `;
  return rows.length > 0;
}

export async function linkTalkDataConnector(input: {
  talkId: string;
  dataConnectorId: string;
  ownerId: string;
}): Promise<boolean> {
  const db = getDbPg();
  await db`
    insert into public.talk_data_connector_links
      (talk_id, data_connector_id, owner_id)
    values (${input.talkId}::uuid, ${input.dataConnectorId}::uuid,
            ${input.ownerId}::uuid)
    on conflict (talk_id, data_connector_id) do nothing
  `;
  return true;
}

export async function unlinkTalkDataConnector(input: {
  talkId: string;
  dataConnectorId: string;
}): Promise<boolean> {
  const db = getDbPg();
  const rows = await db<Array<{ talk_id: string }>>`
    delete from public.talk_data_connector_links
    where talk_id = ${input.talkId}::uuid
      and data_connector_id = ${input.dataConnectorId}::uuid
    returning talk_id
  `;
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Combined view for the Talk picker (`GET /talks/:id/connectors`)
// ---------------------------------------------------------------------------

export interface TalkConnectorPickerItem {
  id: string;
  kind: ChannelKind | DataConnectorKind;
  displayName: string;
  enabled: boolean;
  linked: boolean;
}

export interface TalkConnectorsView {
  channels: TalkConnectorPickerItem[];
  dataConnectors: TalkConnectorPickerItem[];
}

export async function getTalkConnectorsView(
  talkId: string,
): Promise<TalkConnectorsView> {
  const [channels, dataConnectors, channelLinks, dataConnectorLinks] =
    await Promise.all([
      listWorkspaceChannels(),
      listWorkspaceDataConnectors(),
      listTalkChannelLinks(talkId),
      listTalkDataConnectorLinks(talkId),
    ]);
  const linkedChannelIds = new Set(channelLinks.map((l) => l.channelId));
  const linkedDataConnectorIds = new Set(
    dataConnectorLinks.map((l) => l.dataConnectorId),
  );
  return {
    channels: channels.map((c) => ({
      id: c.id,
      kind: c.kind,
      displayName: c.display_name,
      enabled: c.enabled,
      linked: linkedChannelIds.has(c.id),
    })),
    dataConnectors: dataConnectors.map((d) => ({
      id: d.id,
      kind: d.kind,
      displayName: d.display_name,
      enabled: d.enabled,
      linked: linkedDataConnectorIds.has(d.id),
    })),
  };
}
