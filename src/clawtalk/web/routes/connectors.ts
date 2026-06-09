// Greenfield-backed connector handlers. Responses keep server-owned connector
// metadata out of public config payloads.

import { getDbPg, withUserContext } from '../../../db.js';
import {
  CHANNEL_KINDS,
  ConnectorConfigInvalidError,
  ConnectorConflictError,
  DATA_CONNECTOR_KINDS,
  createWorkspaceChannel,
  createWorkspaceDataConnector,
  deleteWorkspaceChannel,
  deleteWorkspaceDataConnector,
  getTalkConnectorsView,
  getWorkspaceChannel,
  getWorkspaceDataConnector,
  linkTalkChannel,
  linkTalkDataConnector,
  listWorkspaceChannels,
  listWorkspaceDataConnectors,
  setWorkspaceChannelCredential,
  setWorkspaceDataConnectorCredential,
  unlinkTalkChannel,
  unlinkTalkDataConnector,
  updateWorkspaceChannel,
  updateWorkspaceDataConnector,
  type ChannelKind,
  type DataConnectorKind,
  type WorkspaceChannelRecord,
  type WorkspaceDataConnectorRecord,
} from '../../db/connectors-accessors.js';
import {
  resolveWorkspaceForUser,
  type WorkspaceSummaryRecord,
} from '../../workspaces/accessors.js';
import { ensureWorkspaceBootstrapForUser } from '../../workspaces/bootstrap.js';
import { ApiEnvelope, AuthContext } from '../types.js';

type RouteResult<T> = { statusCode: number; body: ApiEnvelope<T> };

type TalkAuthContext = {
  workspaceId: string;
  role: 'owner' | 'admin' | 'member' | 'guest';
  createdBy: string;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isAdminLike(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function ok<T>(data: T, statusCode = 200): RouteResult<T> {
  return { statusCode, body: { ok: true, data } };
}

function error(
  statusCode: number,
  code: string,
  message: string,
  details?: unknown,
): RouteResult<never> {
  return {
    statusCode,
    body: {
      ok: false,
      error: { code, message, ...(details !== undefined ? { details } : {}) },
    },
  };
}

function configErrorResponse(err: ConnectorConfigInvalidError) {
  return error(400, 'invalid_config', err.message, { issues: err.issues });
}

async function withResolvedWorkspace<T>(
  auth: AuthContext,
  requestedWorkspaceId: string | null | undefined,
  fn: (workspace: WorkspaceSummaryRecord) => Promise<RouteResult<T>>,
): Promise<RouteResult<T>> {
  if (requestedWorkspaceId && !isUuid(requestedWorkspaceId)) {
    return error(
      400,
      'invalid_workspace_id',
      'workspaceId must be a valid UUID.',
    );
  }
  await ensureWorkspaceBootstrapForUser(auth.userId);
  return withUserContext(auth.userId, async () => {
    const workspace = await resolveWorkspaceForUser({
      userId: auth.userId,
      requestedWorkspaceId,
    });
    if (!workspace) {
      return error(404, 'workspace_not_found', 'Workspace not found.');
    }
    return fn(workspace);
  });
}

async function withAdminWorkspace<T>(
  auth: AuthContext,
  requestedWorkspaceId: string | null | undefined,
  fn: (workspace: WorkspaceSummaryRecord) => Promise<RouteResult<T>>,
): Promise<RouteResult<T>> {
  return withResolvedWorkspace(
    auth,
    requestedWorkspaceId,
    async (workspace) => {
      if (!isAdminLike(workspace.role)) {
        return error(
          403,
          'forbidden',
          'Only workspace admins can manage connectors.',
        );
      }
      return fn(workspace);
    },
  );
}

async function withVisibleTalk<T>(
  auth: AuthContext,
  talkId: string,
  fn: (ctx: TalkAuthContext) => Promise<RouteResult<T>>,
): Promise<RouteResult<T>> {
  if (!isUuid(talkId)) {
    return error(400, 'invalid_talk_id', 'talkId must be a valid UUID.');
  }
  await ensureWorkspaceBootstrapForUser(auth.userId);
  return withUserContext(auth.userId, async () => {
    const db = getDbPg();
    const rows = await db<TalkAuthContext[]>`
      select t.workspace_id as "workspaceId",
             wm.role,
             t.created_by as "createdBy"
      from public.talks t
      join public.workspace_members wm
        on wm.workspace_id = t.workspace_id
       and wm.user_id = ${auth.userId}::uuid
      where t.id = ${talkId}::uuid
      limit 1
    `;
    const ctx = rows[0];
    if (!ctx) return error(404, 'not_found', 'Talk not found.');
    return fn(ctx);
  });
}

function canEditTalk(ctx: TalkAuthContext, userId: string): boolean {
  return (
    ctx.role !== 'guest' && (isAdminLike(ctx.role) || ctx.createdBy === userId)
  );
}

interface ApiWorkspaceChannel {
  id: string;
  kind: ChannelKind;
  displayName: string;
  config: Record<string, unknown>;
  hasCredential: boolean;
  enabled: boolean;
  boundTalkCount: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
}

interface ApiWorkspaceDataConnector {
  id: string;
  kind: DataConnectorKind;
  displayName: string;
  config: Record<string, unknown>;
  hasCredential: boolean;
  enabled: boolean;
  boundTalkCount: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
}

const PUBLIC_CHANNEL_CONFIG_KEYS: Record<string, ReadonlySet<string>> = {
  slack: new Set([
    'workspace_id',
    'teamId',
    'channel_id',
    'channel_name',
    'is_private',
  ]),
};

const PUBLIC_DATA_CONNECTOR_CONFIG_KEYS: Record<string, ReadonlySet<string>> = {
  google_docs: new Set(['folder_id']),
  google_sheets: new Set(['folder_id']),
};

function publicConnectorConfig(
  config: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
): Record<string, unknown> {
  const publicConfig: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (allowedKeys.has(key)) publicConfig[key] = value;
  }
  return publicConfig;
}

function toApiChannel(row: WorkspaceChannelRecord): ApiWorkspaceChannel {
  return {
    id: row.id,
    kind: row.kind,
    displayName: row.display_name,
    config: publicConnectorConfig(
      row.config_json,
      PUBLIC_CHANNEL_CONFIG_KEYS[row.kind] ?? new Set(),
    ),
    hasCredential: row.has_credential,
    enabled: row.enabled,
    boundTalkCount: row.bound_talk_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
  };
}

function toApiDataConnector(
  row: WorkspaceDataConnectorRecord,
): ApiWorkspaceDataConnector {
  return {
    id: row.id,
    kind: row.kind,
    displayName: row.display_name,
    config: publicConnectorConfig(
      row.config_json,
      PUBLIC_DATA_CONNECTOR_CONFIG_KEYS[row.kind] ?? new Set(),
    ),
    hasCredential: row.has_credential,
    enabled: row.enabled,
    boundTalkCount: row.bound_talk_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
  };
}

function readDisplayName(value: unknown): string | RouteResult<never> {
  if (typeof value !== 'string') {
    return error(400, 'display_name_required', 'displayName is required.');
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return error(400, 'display_name_required', 'displayName is required.');
  }
  if (trimmed.length > 200) {
    return error(
      400,
      'display_name_too_long',
      'displayName must be 200 characters or fewer.',
    );
  }
  return trimmed;
}

export async function listWorkspaceChannelsRoute(
  auth: AuthContext,
  requestedWorkspaceId?: string | null,
): Promise<RouteResult<{ channels: ApiWorkspaceChannel[] }>> {
  return withResolvedWorkspace(auth, requestedWorkspaceId, async (workspace) =>
    ok({
      channels: (
        await listWorkspaceChannels({ workspaceId: workspace.id })
      ).map(toApiChannel),
    }),
  );
}

export async function createWorkspaceChannelRoute(input: {
  auth: AuthContext;
  requestedWorkspaceId?: string | null;
  body: {
    kind?: unknown;
    displayName?: unknown;
    config?: unknown;
    enabled?: unknown;
  };
}): Promise<RouteResult<{ channel: ApiWorkspaceChannel }>> {
  try {
    return await withAdminWorkspace(
      input.auth,
      input.requestedWorkspaceId,
      async (workspace) => {
        const kindRaw =
          typeof input.body.kind === 'string' ? input.body.kind.trim() : '';
        if (!(CHANNEL_KINDS as readonly string[]).includes(kindRaw)) {
          return error(
            400,
            'invalid_kind',
            `kind must be one of: ${CHANNEL_KINDS.join(', ')}`,
          );
        }
        const displayName = readDisplayName(input.body.displayName);
        if (typeof displayName !== 'string') return displayName;
        const enabled =
          typeof input.body.enabled === 'boolean'
            ? input.body.enabled
            : undefined;
        return ok(
          {
            channel: toApiChannel(
              await createWorkspaceChannel({
                workspaceId: workspace.id,
                kind: kindRaw as ChannelKind,
                displayName,
                config: input.body.config,
                ...(enabled !== undefined ? { enabled } : {}),
                createdBy: input.auth.userId,
              }),
            ),
          },
          201,
        );
      },
    );
  } catch (err) {
    if (err instanceof ConnectorConflictError) {
      return error(409, 'connector_conflict', err.message);
    }
    if (err instanceof ConnectorConfigInvalidError)
      return configErrorResponse(err);
    throw err;
  }
}

export async function updateWorkspaceChannelRoute(input: {
  auth: AuthContext;
  requestedWorkspaceId?: string | null;
  channelId: string;
  body: { displayName?: unknown; config?: unknown; enabled?: unknown };
}): Promise<RouteResult<{ channel: ApiWorkspaceChannel }>> {
  if (!isUuid(input.channelId)) {
    return error(400, 'invalid_channel_id', 'channelId must be a valid UUID.');
  }
  try {
    return await withAdminWorkspace(
      input.auth,
      input.requestedWorkspaceId,
      async (workspace) => {
        const patch: {
          displayName?: string;
          config?: unknown;
          enabled?: boolean;
          updatedBy: string;
        } = { updatedBy: input.auth.userId };
        if (input.body.displayName !== undefined) {
          const displayName = readDisplayName(input.body.displayName);
          if (typeof displayName !== 'string') return displayName;
          patch.displayName = displayName;
        }
        if (input.body.config !== undefined) patch.config = input.body.config;
        if (input.body.enabled !== undefined) {
          if (typeof input.body.enabled !== 'boolean') {
            return error(400, 'invalid_enabled', 'enabled must be boolean.');
          }
          patch.enabled = input.body.enabled;
        }
        const row = await updateWorkspaceChannel(input.channelId, patch, {
          workspaceId: workspace.id,
        });
        if (!row) return error(404, 'not_found', 'Channel not found.');
        return ok({ channel: toApiChannel(row) });
      },
    );
  } catch (err) {
    if (err instanceof ConnectorConflictError) {
      return error(409, 'connector_conflict', err.message);
    }
    if (err instanceof ConnectorConfigInvalidError)
      return configErrorResponse(err);
    throw err;
  }
}

export async function deleteWorkspaceChannelRoute(input: {
  auth: AuthContext;
  requestedWorkspaceId?: string | null;
  channelId: string;
}): Promise<RouteResult<{ deleted: true }>> {
  if (!isUuid(input.channelId)) {
    return error(400, 'invalid_channel_id', 'channelId must be a valid UUID.');
  }
  return withAdminWorkspace(
    input.auth,
    input.requestedWorkspaceId,
    async (workspace) => {
      const deleted = await deleteWorkspaceChannel(input.channelId, {
        workspaceId: workspace.id,
      });
      if (!deleted) return error(404, 'not_found', 'Channel not found.');
      return ok({ deleted: true });
    },
  );
}

export async function setWorkspaceChannelCredentialRoute(input: {
  auth: AuthContext;
  requestedWorkspaceId?: string | null;
  channelId: string;
  body: { apiKey?: unknown; organizationId?: unknown };
}): Promise<RouteResult<{ channel: ApiWorkspaceChannel }>> {
  if (!isUuid(input.channelId)) {
    return error(400, 'invalid_channel_id', 'channelId must be a valid UUID.');
  }
  return withAdminWorkspace(
    input.auth,
    input.requestedWorkspaceId,
    async (workspace) => {
      const apiKey =
        typeof input.body.apiKey === 'string' ? input.body.apiKey.trim() : '';
      const organizationId =
        typeof input.body.organizationId === 'string'
          ? input.body.organizationId.trim() || undefined
          : undefined;
      const row = await setWorkspaceChannelCredential(
        input.channelId,
        apiKey
          ? { apiKey, ...(organizationId ? { organizationId } : {}) }
          : null,
        input.auth.userId,
        { workspaceId: workspace.id },
      );
      if (!row) return error(404, 'not_found', 'Channel not found.');
      return ok({ channel: toApiChannel(row) });
    },
  );
}

export async function listWorkspaceDataConnectorsRoute(
  auth: AuthContext,
  requestedWorkspaceId?: string | null,
): Promise<RouteResult<{ dataConnectors: ApiWorkspaceDataConnector[] }>> {
  return withResolvedWorkspace(auth, requestedWorkspaceId, async (workspace) =>
    ok({
      dataConnectors: (
        await listWorkspaceDataConnectors({ workspaceId: workspace.id })
      ).map(toApiDataConnector),
    }),
  );
}

export async function createWorkspaceDataConnectorRoute(input: {
  auth: AuthContext;
  requestedWorkspaceId?: string | null;
  body: {
    kind?: unknown;
    displayName?: unknown;
    config?: unknown;
    enabled?: unknown;
  };
}): Promise<RouteResult<{ dataConnector: ApiWorkspaceDataConnector }>> {
  try {
    return await withAdminWorkspace(
      input.auth,
      input.requestedWorkspaceId,
      async (workspace) => {
        const kindRaw =
          typeof input.body.kind === 'string' ? input.body.kind.trim() : '';
        if (!(DATA_CONNECTOR_KINDS as readonly string[]).includes(kindRaw)) {
          return error(
            400,
            'invalid_kind',
            `kind must be one of: ${DATA_CONNECTOR_KINDS.join(', ')}`,
          );
        }
        const displayName = readDisplayName(input.body.displayName);
        if (typeof displayName !== 'string') return displayName;
        const enabled =
          typeof input.body.enabled === 'boolean'
            ? input.body.enabled
            : undefined;
        return ok(
          {
            dataConnector: toApiDataConnector(
              await createWorkspaceDataConnector({
                workspaceId: workspace.id,
                kind: kindRaw as DataConnectorKind,
                displayName,
                config: input.body.config,
                ...(enabled !== undefined ? { enabled } : {}),
                createdBy: input.auth.userId,
              }),
            ),
          },
          201,
        );
      },
    );
  } catch (err) {
    if (err instanceof ConnectorConflictError) {
      return error(409, 'connector_conflict', err.message);
    }
    if (err instanceof ConnectorConfigInvalidError)
      return configErrorResponse(err);
    throw err;
  }
}

export async function updateWorkspaceDataConnectorRoute(input: {
  auth: AuthContext;
  requestedWorkspaceId?: string | null;
  connectorId: string;
  body: { displayName?: unknown; config?: unknown; enabled?: unknown };
}): Promise<RouteResult<{ dataConnector: ApiWorkspaceDataConnector }>> {
  if (!isUuid(input.connectorId)) {
    return error(
      400,
      'invalid_connector_id',
      'connectorId must be a valid UUID.',
    );
  }
  try {
    return await withAdminWorkspace(
      input.auth,
      input.requestedWorkspaceId,
      async (workspace) => {
        const patch: {
          displayName?: string;
          config?: unknown;
          enabled?: boolean;
          updatedBy: string;
        } = { updatedBy: input.auth.userId };
        if (input.body.displayName !== undefined) {
          const displayName = readDisplayName(input.body.displayName);
          if (typeof displayName !== 'string') return displayName;
          patch.displayName = displayName;
        }
        if (input.body.config !== undefined) patch.config = input.body.config;
        if (input.body.enabled !== undefined) {
          if (typeof input.body.enabled !== 'boolean') {
            return error(400, 'invalid_enabled', 'enabled must be boolean.');
          }
          patch.enabled = input.body.enabled;
        }
        const row = await updateWorkspaceDataConnector(
          input.connectorId,
          patch,
          {
            workspaceId: workspace.id,
          },
        );
        if (!row) return error(404, 'not_found', 'Data connector not found.');
        return ok({ dataConnector: toApiDataConnector(row) });
      },
    );
  } catch (err) {
    if (err instanceof ConnectorConflictError) {
      return error(409, 'connector_conflict', err.message);
    }
    if (err instanceof ConnectorConfigInvalidError)
      return configErrorResponse(err);
    throw err;
  }
}

export async function deleteWorkspaceDataConnectorRoute(input: {
  auth: AuthContext;
  requestedWorkspaceId?: string | null;
  connectorId: string;
}): Promise<RouteResult<{ deleted: true }>> {
  if (!isUuid(input.connectorId)) {
    return error(
      400,
      'invalid_connector_id',
      'connectorId must be a valid UUID.',
    );
  }
  return withAdminWorkspace(
    input.auth,
    input.requestedWorkspaceId,
    async (workspace) => {
      const deleted = await deleteWorkspaceDataConnector(input.connectorId, {
        workspaceId: workspace.id,
      });
      if (!deleted) return error(404, 'not_found', 'Data connector not found.');
      return ok({ deleted: true });
    },
  );
}

export async function setWorkspaceDataConnectorCredentialRoute(input: {
  auth: AuthContext;
  requestedWorkspaceId?: string | null;
  connectorId: string;
  body: { apiKey?: unknown; organizationId?: unknown };
}): Promise<RouteResult<{ dataConnector: ApiWorkspaceDataConnector }>> {
  if (!isUuid(input.connectorId)) {
    return error(
      400,
      'invalid_connector_id',
      'connectorId must be a valid UUID.',
    );
  }
  return withAdminWorkspace(
    input.auth,
    input.requestedWorkspaceId,
    async (workspace) => {
      const apiKey =
        typeof input.body.apiKey === 'string' ? input.body.apiKey.trim() : '';
      const organizationId =
        typeof input.body.organizationId === 'string'
          ? input.body.organizationId.trim() || undefined
          : undefined;
      const row = await setWorkspaceDataConnectorCredential(
        input.connectorId,
        apiKey
          ? { apiKey, ...(organizationId ? { organizationId } : {}) }
          : null,
        input.auth.userId,
        { workspaceId: workspace.id },
      );
      if (!row) return error(404, 'not_found', 'Data connector not found.');
      return ok({ dataConnector: toApiDataConnector(row) });
    },
  );
}

export async function getTalkConnectorsRoute(input: {
  auth: AuthContext;
  talkId: string;
}): Promise<
  RouteResult<{
    channels: Array<{
      id: string;
      kind: ChannelKind;
      displayName: string;
      enabled: boolean;
      hasCredential: boolean;
      linked: boolean;
    }>;
    dataConnectors: Array<{
      id: string;
      kind: DataConnectorKind;
      displayName: string;
      enabled: boolean;
      hasCredential: boolean;
      linked: boolean;
    }>;
  }>
> {
  return withVisibleTalk(input.auth, input.talkId, async (ctx) => {
    const view = await getTalkConnectorsView({
      workspaceId: ctx.workspaceId,
      talkId: input.talkId,
    });
    return ok({
      channels: view.channels.map((channel) => ({
        id: channel.id,
        kind: channel.kind,
        displayName: channel.displayName,
        enabled: channel.enabled,
        hasCredential: channel.hasCredential,
        linked: channel.linked,
      })),
      dataConnectors: view.dataConnectors.map((connector) => ({
        id: connector.id,
        kind: connector.kind,
        displayName: connector.displayName,
        enabled: connector.enabled,
        hasCredential: connector.hasCredential,
        linked: connector.linked,
      })),
    });
  });
}

export async function setTalkChannelLinkRoute(input: {
  auth: AuthContext;
  talkId: string;
  channelId: string;
}): Promise<RouteResult<{ linked: true }>> {
  if (!isUuid(input.channelId)) {
    return error(400, 'invalid_channel_id', 'channelId must be a valid UUID.');
  }
  return withVisibleTalk(input.auth, input.talkId, async (ctx) => {
    if (!canEditTalk(ctx, input.auth.userId)) {
      return error(
        403,
        'forbidden',
        'You do not have permission to edit this talk.',
      );
    }
    const channel = await getWorkspaceChannel(input.channelId, {
      workspaceId: ctx.workspaceId,
    });
    if (!channel) return error(404, 'not_found', 'Channel not found.');
    if (channel.workspace_id !== ctx.workspaceId) {
      return error(404, 'not_found', 'Channel not found.');
    }
    if (!channel.enabled || !channel.has_credential) {
      return error(
        409,
        'connector_not_authorized',
        'Connector is not authorized.',
      );
    }
    const linked = await linkTalkChannel({
      talkId: input.talkId,
      channelId: input.channelId,
      ownerId: input.auth.userId,
    });
    if (!linked) return error(404, 'not_found', 'Channel not found.');
    return ok({ linked: true });
  });
}

export async function deleteTalkChannelLinkRoute(input: {
  auth: AuthContext;
  talkId: string;
  channelId: string;
}): Promise<RouteResult<{ unlinked: true }>> {
  if (!isUuid(input.channelId)) {
    return error(400, 'invalid_channel_id', 'channelId must be a valid UUID.');
  }
  return withVisibleTalk(input.auth, input.talkId, async (ctx) => {
    if (!canEditTalk(ctx, input.auth.userId)) {
      return error(
        403,
        'forbidden',
        'You do not have permission to edit this talk.',
      );
    }
    await unlinkTalkChannel({
      talkId: input.talkId,
      channelId: input.channelId,
    });
    return ok({ unlinked: true });
  });
}

export async function setTalkDataConnectorLinkRoute(input: {
  auth: AuthContext;
  talkId: string;
  connectorId: string;
}): Promise<RouteResult<{ linked: true }>> {
  if (!isUuid(input.connectorId)) {
    return error(
      400,
      'invalid_connector_id',
      'connectorId must be a valid UUID.',
    );
  }
  return withVisibleTalk(input.auth, input.talkId, async (ctx) => {
    if (!canEditTalk(ctx, input.auth.userId)) {
      return error(
        403,
        'forbidden',
        'You do not have permission to edit this talk.',
      );
    }
    const connector = await getWorkspaceDataConnector(input.connectorId, {
      workspaceId: ctx.workspaceId,
    });
    if (!connector) return error(404, 'not_found', 'Data connector not found.');
    if (connector.workspace_id !== ctx.workspaceId) {
      return error(404, 'not_found', 'Data connector not found.');
    }
    if (!connector.enabled || !connector.has_credential) {
      return error(
        409,
        'connector_not_authorized',
        'Connector is not authorized.',
      );
    }
    const linked = await linkTalkDataConnector({
      talkId: input.talkId,
      dataConnectorId: input.connectorId,
      ownerId: input.auth.userId,
    });
    if (!linked) return error(404, 'not_found', 'Data connector not found.');
    return ok({ linked: true });
  });
}

export async function deleteTalkDataConnectorLinkRoute(input: {
  auth: AuthContext;
  talkId: string;
  connectorId: string;
}): Promise<RouteResult<{ unlinked: true }>> {
  if (!isUuid(input.connectorId)) {
    return error(
      400,
      'invalid_connector_id',
      'connectorId must be a valid UUID.',
    );
  }
  return withVisibleTalk(input.auth, input.talkId, async (ctx) => {
    if (!canEditTalk(ctx, input.auth.userId)) {
      return error(
        403,
        'forbidden',
        'You do not have permission to edit this talk.',
      );
    }
    await unlinkTalkDataConnector({
      talkId: input.talkId,
      dataConnectorId: input.connectorId,
    });
    return ok({ unlinked: true });
  });
}
