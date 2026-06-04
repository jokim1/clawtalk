// Talk tool compatibility accessors backed by the greenfield schema.
//
// Legacy route/API names stay stable while storage moves to:
//   - connector_bindings for per-Talk Drive resource targets.
//   - connectors + connector_secrets for Google tool credentials.
//   - talk_tools for the pre-greenfield active-tool toggle API shape.

import {
  getCurrentUserId,
  getDbPg,
  withTrustedDbWrites,
  type Sql,
} from '../../db.js';
import {
  normalizeTalkToolFamiliesFromRows,
  TALK_TOOL_IDS_BY_FAMILY,
} from './agent-accessors.js';
import { normalizeGoogleScopeAliases } from '../identity/google-scopes.js';

type JsonMap = Record<string, unknown>;

export type TalkToolFamily =
  | 'saved_sources'
  | 'attachments'
  | 'web'
  | 'gmail'
  | 'google_drive'
  | 'google_docs'
  | 'google_sheets'
  | 'data_connectors';

export type TalkResourceBindingKind =
  | 'google_drive_folder'
  | 'google_drive_file'
  | 'data_connector'
  | 'saved_source'
  | 'message_attachment';

export interface BuiltinTalkToolDefinition {
  id: string;
  family: TalkToolFamily;
  displayName: string;
  description: string | null;
  requiresBinding: boolean;
  defaultGrant: boolean;
  mutatesExternalState: boolean;
  sortOrder: number;
}

export const BUILTIN_TALK_TOOLS: ReadonlyArray<BuiltinTalkToolDefinition> = [
  {
    id: 'saved_sources',
    family: 'saved_sources',
    displayName: 'Saved Sources',
    description: 'Read saved Talk sources.',
    requiresBinding: false,
    defaultGrant: true,
    mutatesExternalState: false,
    sortOrder: 10,
  },
  {
    id: 'attachments',
    family: 'attachments',
    displayName: 'Message Attachments',
    description: 'Read attached Talk files.',
    requiresBinding: false,
    defaultGrant: true,
    mutatesExternalState: false,
    sortOrder: 20,
  },
  {
    id: 'web_search',
    family: 'web',
    displayName: 'Web Search',
    description: 'Search the public web.',
    requiresBinding: false,
    defaultGrant: true,
    mutatesExternalState: false,
    sortOrder: 30,
  },
  {
    id: 'web_fetch',
    family: 'web',
    displayName: 'Web Fetch',
    description: 'Fetch public web pages.',
    requiresBinding: false,
    defaultGrant: true,
    mutatesExternalState: false,
    sortOrder: 40,
  },
  {
    id: 'gmail_read',
    family: 'gmail',
    displayName: 'Gmail Read',
    description: 'Search and read mailbox content.',
    requiresBinding: false,
    defaultGrant: false,
    mutatesExternalState: false,
    sortOrder: 50,
  },
  {
    id: 'gmail_send',
    family: 'gmail',
    displayName: 'Gmail Send',
    description: 'Draft and send email.',
    requiresBinding: false,
    defaultGrant: false,
    mutatesExternalState: true,
    sortOrder: 60,
  },
  {
    id: 'google_drive_search',
    family: 'google_drive',
    displayName: 'Google Drive Search',
    description: 'Search within bound Google Drive resources.',
    requiresBinding: true,
    defaultGrant: true,
    mutatesExternalState: false,
    sortOrder: 70,
  },
  {
    id: 'google_drive_read',
    family: 'google_drive',
    displayName: 'Google Drive Read',
    description: 'Read bound Google Drive files.',
    requiresBinding: true,
    defaultGrant: true,
    mutatesExternalState: false,
    sortOrder: 80,
  },
  {
    id: 'google_drive_list_folder',
    family: 'google_drive',
    displayName: 'Google Drive List Folder',
    description: 'List bound Google Drive folders.',
    requiresBinding: true,
    defaultGrant: true,
    mutatesExternalState: false,
    sortOrder: 90,
  },
  {
    id: 'google_docs_create',
    family: 'google_docs',
    displayName: 'Google Docs Create',
    description: 'Create a new Google Doc and bind it to this Talk.',
    requiresBinding: false,
    defaultGrant: false,
    mutatesExternalState: true,
    sortOrder: 95,
  },
  {
    id: 'google_docs_read',
    family: 'google_docs',
    displayName: 'Google Docs Read',
    description: 'Read bound Google Docs.',
    requiresBinding: true,
    defaultGrant: false,
    mutatesExternalState: false,
    sortOrder: 100,
  },
  {
    id: 'google_docs_batch_update',
    family: 'google_docs',
    displayName: 'Google Docs Update',
    description: 'Update bound Google Docs.',
    requiresBinding: true,
    defaultGrant: false,
    mutatesExternalState: true,
    sortOrder: 110,
  },
  {
    id: 'google_sheets_read_range',
    family: 'google_sheets',
    displayName: 'Google Sheets Read',
    description: 'Read bound Google Sheets.',
    requiresBinding: true,
    defaultGrant: false,
    mutatesExternalState: false,
    sortOrder: 120,
  },
  {
    id: 'google_sheets_batch_update',
    family: 'google_sheets',
    displayName: 'Google Sheets Update',
    description: 'Update bound Google Sheets.',
    requiresBinding: true,
    defaultGrant: false,
    mutatesExternalState: true,
    sortOrder: 130,
  },
  {
    id: 'data_connectors',
    family: 'data_connectors',
    displayName: 'Data Connectors',
    description: 'Use attached Talk data connectors.',
    requiresBinding: false,
    defaultGrant: true,
    mutatesExternalState: false,
    sortOrder: 140,
  },
];

// ---------------------------------------------------------------------------
// Records (API-facing, camelCase)
// ---------------------------------------------------------------------------

export interface TalkResourceBindingRecord {
  id: string;
  talkId: string;
  ownerId: string;
  bindingKind: TalkResourceBindingKind;
  externalId: string;
  displayName: string;
  metadata: JsonMap | null;
  createdAt: string;
  createdBy: string | null;
}

export interface UserGoogleCredentialRecord {
  id: string;
  userId: string;
  googleSubject: string;
  email: string;
  displayName: string | null;
  scopes: string[];
  ciphertext: string;
  accessExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const GOOGLE_TOOLS_COMPAT_SURFACE = 'google_tools';
const TALK_RESOURCE_COMPAT_SURFACE = 'talk_resource';
const GOOGLE_TOOL_CONNECTOR_SERVICES = ['gdrive', 'gmail'] as const;
type GoogleToolConnectorService =
  (typeof GOOGLE_TOOL_CONNECTOR_SERVICES)[number];

const LEGACY_ACTIVE_TOOL_FAMILY_ALIASES: Record<string, string> = {
  data_connectors: 'connectors',
  gmail: 'gmail_read',
  google_docs: 'google_read',
  google_drive: 'google_read',
  google_sheets: 'google_read',
};

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

async function resolveGoogleToolsWorkspaceId(
  db: Sql,
  userId: string,
  requestedWorkspaceId: string,
): Promise<string | undefined> {
  const rows = await db<{ workspace_id: string }[]>`
    select workspace_id
    from public.workspace_members
    where workspace_id = ${requestedWorkspaceId}::uuid
      and user_id = ${userId}::uuid
    limit 1
  `;
  return rows[0]?.workspace_id;
}

// ---------------------------------------------------------------------------
// Internal raw row shapes (postgres returns jsonb as parsed objects)
// ---------------------------------------------------------------------------

interface RawTalkResourceBindingRow {
  id: string;
  talk_id: string;
  owner_id: string;
  binding_kind: TalkResourceBindingKind;
  external_id: string;
  display_name: string;
  metadata_json: JsonMap | null;
  created_at: string;
  created_by: string | null;
}

interface RawUserGoogleCredentialRow {
  id: string;
  user_id: string;
  google_subject: string;
  email: string;
  display_name: string | null;
  scopes_json: string[];
  ciphertext: string;
  access_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

function toTalkResourceBindingRecord(
  row: RawTalkResourceBindingRow,
): TalkResourceBindingRecord {
  return {
    id: row.id,
    talkId: row.talk_id,
    ownerId: row.owner_id,
    bindingKind: row.binding_kind,
    externalId: row.external_id,
    displayName: row.display_name,
    metadata: row.metadata_json,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

function toUserGoogleCredentialRecord(
  row: RawUserGoogleCredentialRow,
): UserGoogleCredentialRecord {
  return {
    id: row.id,
    userId: row.user_id,
    googleSubject: row.google_subject,
    email: row.email,
    displayName: row.display_name,
    scopes: Array.isArray(row.scopes_json) ? row.scopes_json : [],
    ciphertext: row.ciphertext,
    accessExpiresAt: row.access_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function googleToolConnectorServicesForScopes(
  scopes: string[],
): GoogleToolConnectorService[] {
  const services = new Set<GoogleToolConnectorService>();
  for (const scope of scopes) {
    if (scope === 'gmail.readonly' || scope === 'gmail.send') {
      services.add('gmail');
      continue;
    }
    if (
      scope === 'drive.readonly' ||
      scope === 'documents' ||
      scope === 'documents.readonly' ||
      scope === 'spreadsheets' ||
      scope === 'spreadsheets.readonly'
    ) {
      services.add('gdrive');
    }
  }
  return Array.from(services).sort();
}

// ---------------------------------------------------------------------------
// Talk resource bindings
// ---------------------------------------------------------------------------

export async function listTalkResourceBindings(
  talkId: string,
): Promise<TalkResourceBindingRecord[]> {
  const db = getDbPg();
  const rows = await db<RawTalkResourceBindingRow[]>`
    select
      cb.id,
      cb.talk_id,
      cb.created_by_user_id as owner_id,
      coalesce(cb.meta_json->>'resourceKind', 'google_drive_file') as binding_kind,
      coalesce(cb.target, '') as external_id,
      coalesce(cb.display_name, cb.target, '') as display_name,
      cb.meta_json->'metadata' as metadata_json,
      cb.created_at,
      cb.created_by_user_id as created_by
    from public.connector_bindings cb
    join public.connectors c
      on c.workspace_id = cb.workspace_id
     and c.id = cb.connector_id
    where cb.talk_id = ${talkId}::uuid
      and c.service = 'gdrive'
      and cb.target is not null
      and cb.meta_json->>'compatSurface' = ${TALK_RESOURCE_COMPAT_SURFACE}
    order by cb.created_at asc, cb.id asc
  `;
  return rows.map(toTalkResourceBindingRecord);
}

export async function createTalkResourceBinding(input: {
  ownerId: string;
  talkId: string;
  bindingKind: TalkResourceBindingKind;
  externalId: string;
  displayName: string;
  metadata?: JsonMap | null;
  createdBy?: string | null;
}): Promise<TalkResourceBindingRecord> {
  const db = getDbPg();
  const currentUserId = getCurrentUserId();
  if (!currentUserId || currentUserId !== input.ownerId) {
    throw new Error('resource binding owner must match current user');
  }
  if (input.createdBy && input.createdBy !== currentUserId) {
    throw new Error('resource binding creator must match current user');
  }
  const authRows = await db<
    Array<{
      workspace_id: string;
      created_by: string;
      role: 'owner' | 'admin' | 'member' | 'guest';
    }>
  >`
    select t.workspace_id, t.created_by, wm.role
    from public.talks t
    join public.workspace_members wm
      on wm.workspace_id = t.workspace_id
     and wm.user_id = ${currentUserId}::uuid
    where t.id = ${input.talkId}::uuid
    limit 1
  `;
  const auth = authRows[0];
  if (!auth) {
    throw new Error('talk not found or not visible for resource binding');
  }
  if (
    auth.role === 'guest' ||
    (auth.role !== 'owner' &&
      auth.role !== 'admin' &&
      auth.created_by !== currentUserId)
  ) {
    throw new Error('user cannot edit talk resource bindings');
  }
  await withTrustedDbWrites(async () => {
    const connectorRows = await db<Array<{ id: string }>>`
      insert into public.connectors (
        workspace_id,
        service,
        authorized,
        authorized_at,
        secret_ref,
        config_json
      )
      values (
        ${auth.workspace_id}::uuid,
        'gdrive',
        false,
        null,
        null,
        ${db.json({
          compatSurface: TALK_RESOURCE_COMPAT_SURFACE,
          displayName: 'Google Drive resources',
          authMode: 'resource_binding_only',
        } as never)}
      )
      on conflict (workspace_id, service)
        where config_json->>'compatSurface' = 'talk_resource'
      do update set
        authorized = false,
        authorized_at = null,
        secret_ref = null,
        config_json = excluded.config_json,
        updated_at = now()
      returning id
    `;
    const connectorId = connectorRows[0]?.id;
    if (!connectorId) {
      throw new Error('failed to resolve Google Drive resource connector');
    }
    await db`
      insert into public.connector_bindings (
        workspace_id,
        connector_id,
        talk_id,
        target,
        scope,
        enabled,
        display_name,
        meta_json,
        created_by_user_id
      )
      values (
        ${auth.workspace_id}::uuid,
        ${connectorId}::uuid,
        ${input.talkId}::uuid,
        ${input.externalId},
        ${[input.bindingKind]}::text[],
        true,
        ${input.displayName},
        ${db.json({
          compatSurface: TALK_RESOURCE_COMPAT_SURFACE,
          resourceKind: input.bindingKind,
          metadata: input.metadata ?? null,
        } as never)},
        ${currentUserId}::uuid
      )
      on conflict (
        connector_id,
        talk_id,
        target,
        created_by_user_id,
        (coalesce(meta_json->>'resourceKind', ''))
      )
        where target is not null
      do update set
        scope = excluded.scope,
        enabled = true,
        display_name = excluded.display_name,
        meta_json = excluded.meta_json,
        updated_at = now()
    `;
  });
  const rows = await db<RawTalkResourceBindingRow[]>`
    select
      cb.id,
      cb.talk_id,
      cb.created_by_user_id as owner_id,
      coalesce(cb.meta_json->>'resourceKind', 'google_drive_file') as binding_kind,
      coalesce(cb.target, '') as external_id,
      coalesce(cb.display_name, cb.target, '') as display_name,
      cb.meta_json->'metadata' as metadata_json,
      cb.created_at,
      cb.created_by_user_id as created_by
    from public.connector_bindings cb
    join public.connectors c
      on c.workspace_id = cb.workspace_id
     and c.id = cb.connector_id
    where cb.talk_id = ${input.talkId}::uuid
      and c.service = 'gdrive'
      and cb.target = ${input.externalId}
      and cb.created_by_user_id = ${currentUserId}::uuid
      and cb.meta_json->>'compatSurface' = ${TALK_RESOURCE_COMPAT_SURFACE}
      and coalesce(cb.meta_json->>'resourceKind', 'google_drive_file') = ${input.bindingKind}
    limit 1
  `;
  if (!rows[0]) {
    throw new Error('failed to load talk resource binding after insert');
  }
  return toTalkResourceBindingRecord(rows[0]);
}

export async function deleteTalkResourceBinding(
  talkId: string,
  bindingId: string,
): Promise<boolean> {
  const db = getDbPg();
  const userId = getCurrentUserId();
  if (!userId) return false;

  const authRows = await db<
    Array<{
      workspace_id: string;
      created_by: string;
      role: 'owner' | 'admin' | 'member' | 'guest';
    }>
  >`
    select t.workspace_id, t.created_by, wm.role
    from public.talks t
    join public.workspace_members wm
      on wm.workspace_id = t.workspace_id
     and wm.user_id = ${userId}::uuid
    where t.id = ${talkId}::uuid
    limit 1
  `;
  const auth = authRows[0];
  if (
    !auth ||
    auth.role === 'guest' ||
    (auth.role !== 'owner' &&
      auth.role !== 'admin' &&
      auth.created_by !== userId)
  ) {
    return false;
  }

  return withTrustedDbWrites(async () => {
    const rows = await db<{ id: string }[]>`
      delete from public.connector_bindings
      where workspace_id = ${auth.workspace_id}::uuid
        and talk_id = ${talkId}::uuid
        and id = ${bindingId}::uuid
        and meta_json->>'compatSurface' = ${TALK_RESOURCE_COMPAT_SURFACE}
      returning id
    `;
    return rows.length > 0;
  });
}

// ---------------------------------------------------------------------------
// User Google credentials
// ---------------------------------------------------------------------------

export async function getUserGoogleCredential(input: {
  workspaceId: string | null;
}): Promise<UserGoogleCredentialRecord | undefined> {
  const userId = getCurrentUserId();
  if (!userId) return undefined;
  if (!input.workspaceId) return undefined;
  const db = getDbPg();

  const rows = await withTrustedDbWrites(
    () => db<RawUserGoogleCredentialRow[]>`
      select
        c.id,
        c.config_json->>'authorizedByUserId' as user_id,
        coalesce(c.config_json->>'googleSubject', '') as google_subject,
        coalesce(c.config_json->>'email', '') as email,
        c.config_json->>'displayName' as display_name,
        coalesce(c.config_json->'scopes', '[]'::jsonb) as scopes_json,
        cs.ciphertext,
        c.config_json->>'accessExpiresAt' as access_expires_at,
        c.created_at,
        c.updated_at
      from public.connectors c
      join public.workspace_members wm
        on wm.workspace_id = c.workspace_id
       and wm.user_id = ${userId}::uuid
      join public.connector_secrets cs
        on cs.workspace_id = c.workspace_id
       and cs.id = c.secret_ref
      where c.workspace_id = ${input.workspaceId}::uuid
        and c.service in ${db(GOOGLE_TOOL_CONNECTOR_SERVICES)}
        and c.authorized = true
        and c.secret_ref is not null
        and c.config_json->>'compatSurface' = ${GOOGLE_TOOLS_COMPAT_SURFACE}
        and c.config_json->>'authorizedByUserId' = ${userId}
      order by
        case when c.service = 'gdrive' then 0 else 1 end,
        c.updated_at desc,
        c.created_at desc,
        c.id desc
      limit 1
    `,
  );
  return rows[0] ? toUserGoogleCredentialRecord(rows[0]) : undefined;
}

export async function upsertUserGoogleCredential(input: {
  workspaceId: string;
  userId: string;
  googleSubject: string;
  email: string;
  displayName?: string | null;
  scopes: string[];
  ciphertext: string;
  accessExpiresAt?: string | null;
}): Promise<UserGoogleCredentialRecord> {
  const currentUserId = getCurrentUserId();
  if (!currentUserId || currentUserId !== input.userId) {
    throw new Error('upsertUserGoogleCredential: user mismatch');
  }
  const sortedScopes = normalizeGoogleScopeAliases(input.scopes);
  const connectorServices = googleToolConnectorServicesForScopes(sortedScopes);
  if (connectorServices.length === 0) {
    throw new Error(
      'upsertUserGoogleCredential: at least one Google tool scope is required',
    );
  }
  const db = getDbPg();
  if (!input.workspaceId) {
    throw new Error('upsertUserGoogleCredential: workspaceId is required');
  }
  const workspaceId = await resolveGoogleToolsWorkspaceId(
    db,
    input.userId,
    input.workspaceId,
  );
  if (!workspaceId) {
    throw new Error('upsertUserGoogleCredential: workspace is not available');
  }
  const config = {
    compatSurface: GOOGLE_TOOLS_COMPAT_SURFACE,
    authorizedByUserId: input.userId,
    googleSubject: input.googleSubject,
    email: input.email,
    displayName: input.displayName ?? null,
    scopes: sortedScopes,
    accessExpiresAt: input.accessExpiresAt ?? null,
  };

  await withTrustedDbWrites(async () => {
    await withExistingOrNewTransaction(db, async (tx) => {
      await tx`
        select pg_advisory_xact_lock(
          hashtext(${`google_tools:${workspaceId}:${input.userId}`})
        )
      `;
      const existingRows = await tx<
        Array<{
          id: string;
          service: GoogleToolConnectorService;
          secret_ref: string | null;
        }>
      >`
        select id, service, secret_ref
        from public.connectors
        where workspace_id = ${workspaceId}::uuid
          and service in ${tx(GOOGLE_TOOL_CONNECTOR_SERVICES)}
          and config_json->>'compatSurface' = ${GOOGLE_TOOLS_COMPAT_SURFACE}
          and config_json->>'authorizedByUserId' = ${input.userId}
        order by
          case when service = 'gdrive' then 0 else 1 end,
          updated_at desc,
          created_at desc,
          id desc
        for update
      `;
      let secretId =
        existingRows.find((row) => row.secret_ref)?.secret_ref ?? null;
      if (secretId) {
        const updated = await tx<{ id: string }[]>`
          update public.connector_secrets
          set ciphertext = ${input.ciphertext},
              enc_key_version = 1,
              updated_at = now()
          where workspace_id = ${workspaceId}::uuid
            and id = ${secretId}::uuid
          returning id
        `;
        secretId = updated[0]?.id ?? null;
      }
      if (!secretId) {
        const inserted = await tx<{ id: string }[]>`
          insert into public.connector_secrets (workspace_id, ciphertext)
          values (${workspaceId}::uuid, ${input.ciphertext})
          returning id
        `;
        secretId = inserted[0]?.id ?? null;
      }
      if (!secretId) {
        throw new Error('upsertUserGoogleCredential: failed to persist secret');
      }

      for (const service of connectorServices) {
        await tx`
          insert into public.connectors (
            workspace_id,
            service,
            authorized,
            authorized_at,
            secret_ref,
            config_json
          )
          values (
            ${workspaceId}::uuid,
            ${service},
            true,
            now(),
            ${secretId}::uuid,
            ${tx.json(config as never)}
          )
          on conflict (workspace_id, service, (coalesce(config_json->>'authorizedByUserId', '')))
            where config_json->>'compatSurface' = 'google_tools'
          do update set
            authorized = true,
            authorized_at = coalesce(public.connectors.authorized_at, now()),
            secret_ref = excluded.secret_ref,
            config_json = excluded.config_json,
            updated_at = now()
        `;
      }
      await tx`
        delete from public.connectors
        where workspace_id = ${workspaceId}::uuid
          and service in ${tx(GOOGLE_TOOL_CONNECTOR_SERVICES)}
          and service not in ${tx(connectorServices)}
          and config_json->>'compatSurface' = ${GOOGLE_TOOLS_COMPAT_SURFACE}
          and config_json->>'authorizedByUserId' = ${input.userId}
      `;
    });
  });

  const got = await getUserGoogleCredential({ workspaceId });
  if (!got) {
    throw new Error('upsertUserGoogleCredential: missing row after upsert');
  }
  return got;
}

export async function deleteUserGoogleCredential(input: {
  workspaceId: string | null;
}): Promise<boolean> {
  const userId = getCurrentUserId();
  if (!userId) return false;
  if (!input.workspaceId) return false;
  const db = getDbPg();
  return withTrustedDbWrites(async () => {
    return withExistingOrNewTransaction(db, async (tx) => {
      const rows = await tx<
        Array<{
          id: string;
          workspace_id: string;
          secret_ref: string | null;
        }>
      >`
        select c.id, c.workspace_id, c.secret_ref
        from public.connectors c
        join public.workspace_members wm
          on wm.workspace_id = c.workspace_id
         and wm.user_id = ${userId}::uuid
        where c.workspace_id = ${input.workspaceId}::uuid
          and c.service in ${tx(GOOGLE_TOOL_CONNECTOR_SERVICES)}
          and c.config_json->>'compatSurface' = ${GOOGLE_TOOLS_COMPAT_SURFACE}
          and c.config_json->>'authorizedByUserId' = ${userId}
        for update
      `;
      if (rows.length === 0) return false;
      await tx`
        delete from public.connectors c
        using public.workspace_members wm
        where wm.workspace_id = c.workspace_id
          and wm.user_id = ${userId}::uuid
          and c.workspace_id = ${input.workspaceId}::uuid
          and c.service in ${tx(GOOGLE_TOOL_CONNECTOR_SERVICES)}
          and c.config_json->>'compatSurface' = ${GOOGLE_TOOLS_COMPAT_SURFACE}
          and c.config_json->>'authorizedByUserId' = ${userId}
      `;
      const secretRefs = new Map<string, Set<string>>();
      for (const row of rows) {
        if (!row.secret_ref) continue;
        const ids = secretRefs.get(row.workspace_id) ?? new Set<string>();
        ids.add(row.secret_ref);
        secretRefs.set(row.workspace_id, ids);
      }
      for (const [workspaceId, ids] of secretRefs) {
        await tx`
          delete from public.connector_secrets
          where workspace_id = ${workspaceId}::uuid
            and id in ${tx(Array.from(ids))}
        `;
      }
      return true;
    });
  });
}

// ---------------------------------------------------------------------------
// Talk active-tool families
//
// Compatibility callers still read/write a Record keyed by family/tool slug.
// Greenfield storage is one row per enabled/disabled tool in `talk_tools`.
// ---------------------------------------------------------------------------

export type TalkActiveToolFamilies = Record<string, boolean>;

interface ActiveToolRow {
  tool_id: string;
  enabled: boolean;
}

function canEditTalk(role: string, createdBy: string, userId: string): boolean {
  return (
    role !== 'guest' &&
    (role === 'owner' || role === 'admin' || createdBy === userId)
  );
}

function canonicalToolIdsForCompatKey(family: string): string[] {
  const normalized = (
    LEGACY_ACTIVE_TOOL_FAMILY_ALIASES[family] ?? family
  ).trim();
  const familyToolIds = TALK_TOOL_IDS_BY_FAMILY[normalized];
  if (familyToolIds) return familyToolIds;
  const knownToolIds = new Set(Object.values(TALK_TOOL_IDS_BY_FAMILY).flat());
  if (knownToolIds.has(normalized)) return [normalized];
  throw new Error(`unknown active tool family: ${family}`);
}

export async function getTalkActiveTools(
  talkId: string,
): Promise<TalkActiveToolFamilies> {
  const db = getDbPg();
  const rows = await db<ActiveToolRow[]>`
    select tool_id, enabled
    from public.talk_tools
    where talk_id = ${talkId}::uuid
    order by tool_id asc
  `;
  return normalizeTalkToolFamiliesFromRows(rows);
}

export async function setTalkActiveTool(
  talkId: string,
  family: string,
  enabled: boolean,
): Promise<TalkActiveToolFamilies> {
  const db = getDbPg();
  const userId = getCurrentUserId();
  if (!userId) {
    throw new Error(`setTalkActiveTool: talk ${talkId} not found`);
  }
  const accessRows = await db<
    Array<{
      workspace_id: string;
      created_by: string;
      role: 'owner' | 'admin' | 'member' | 'guest';
    }>
  >`
    select t.workspace_id, t.created_by, wm.role
    from public.talks t
    join public.workspace_members wm
      on wm.workspace_id = t.workspace_id
     and wm.user_id = ${userId}::uuid
    where t.id = ${talkId}::uuid
    limit 1
  `;
  const access = accessRows[0];
  if (!access) {
    throw new Error(`setTalkActiveTool: talk ${talkId} not found`);
  }
  if (!canEditTalk(access.role, access.created_by, userId)) {
    throw new Error(`setTalkActiveTool: user cannot edit talk ${talkId}`);
  }

  const toolIds = canonicalToolIdsForCompatKey(family);
  await withTrustedDbWrites(async () => {
    await withExistingOrNewTransaction(db, async (tx) => {
      for (const toolId of toolIds) {
        await tx`
          insert into public.talk_tools (workspace_id, talk_id, tool_id, enabled)
          values (
            ${access.workspace_id}::uuid,
            ${talkId}::uuid,
            ${toolId},
            ${enabled}
          )
          on conflict (talk_id, tool_id) do update set
            enabled = excluded.enabled
        `;
      }
    });
  });
  return getTalkActiveTools(talkId);
}
