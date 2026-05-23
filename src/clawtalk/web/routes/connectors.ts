// Connectors refactor PR 1 — workspace channel + data-connector
// route handlers + per-Talk link toggles.
//
// Workspace CRUD is admin-only (isAdminLike from ai-agents.ts). The
// underlying RLS policy (current_user_is_workspace_admin) is the
// belt + suspenders — both layers must agree.
//
// Talk-link toggles are talk-owner-gated via `canEditTalk` (mirrors
// `talk-resources.ts:C3`). RLS on the link tables only enforces
// `owner_id = auth.uid()`, not talk ownership — without this gate any
// authenticated user could spoof links onto someone else's talk.
//
// No /verify endpoints in PR 1. Verification logic is PR 4 work.

import { withUserContext } from '../../../db.js';
import { getTalkForUser } from '../../db/index.js';
import {
  CHANNEL_KINDS,
  ConnectorConfigInvalidError,
  DATA_CONNECTOR_KINDS,
  type ChannelKind,
  type DataConnectorKind,
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
  type WorkspaceChannelRecord,
  type WorkspaceDataConnectorRecord,
} from '../../db/connectors-accessors.js';
import { canEditTalk } from '../middleware/acl.js';
import { ApiEnvelope, AuthContext } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAdminLike(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

function forbiddenAdminResponse(): {
  statusCode: number;
  body: ApiEnvelope<never>;
} {
  return {
    statusCode: 403,
    body: {
      ok: false,
      error: {
        code: 'forbidden',
        message: 'Only workspace admins can manage connectors.',
      },
    },
  };
}

function forbiddenTalkResponse(): {
  statusCode: number;
  body: ApiEnvelope<never>;
} {
  return {
    statusCode: 403,
    body: {
      ok: false,
      error: {
        code: 'forbidden',
        message: 'You do not have permission to edit this talk.',
      },
    },
  };
}

function notFoundResponse(message: string): {
  statusCode: number;
  body: ApiEnvelope<never>;
} {
  return {
    statusCode: 404,
    body: { ok: false, error: { code: 'not_found', message } },
  };
}

function badRequest(
  code: string,
  message: string,
  details?: unknown,
): {
  statusCode: number;
  body: ApiEnvelope<never>;
} {
  return {
    statusCode: 400,
    body: {
      ok: false,
      error: {
        code,
        message,
        ...(details !== undefined ? { details } : {}),
      },
    },
  };
}

function configErrorResponse(err: ConnectorConfigInvalidError): {
  statusCode: number;
  body: ApiEnvelope<never>;
} {
  return badRequest('invalid_config', err.message, { issues: err.issues });
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

function toApiChannel(row: WorkspaceChannelRecord): ApiWorkspaceChannel {
  return {
    id: row.id,
    kind: row.kind,
    displayName: row.display_name,
    config: row.config_json,
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
    config: row.config_json,
    hasCredential: row.has_credential,
    enabled: row.enabled,
    boundTalkCount: row.bound_talk_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
  };
}

// ---------------------------------------------------------------------------
// Workspace channels CRUD
// ---------------------------------------------------------------------------

export async function listWorkspaceChannelsRoute(auth: AuthContext): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ channels: ApiWorkspaceChannel[] }>;
}> {
  return withUserContext(auth.userId, async () => {
    const rows = await listWorkspaceChannels();
    return {
      statusCode: 200,
      body: { ok: true, data: { channels: rows.map(toApiChannel) } },
    };
  });
}

export async function createWorkspaceChannelRoute(input: {
  auth: AuthContext;
  body: {
    kind?: unknown;
    displayName?: unknown;
    config?: unknown;
    enabled?: unknown;
  };
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ channel: ApiWorkspaceChannel }>;
}> {
  if (!isAdminLike(input.auth.role)) return forbiddenAdminResponse();

  const kindRaw =
    typeof input.body.kind === 'string' ? input.body.kind.trim() : '';
  if (!CHANNEL_KINDS.includes(kindRaw as ChannelKind)) {
    return badRequest(
      'invalid_kind',
      `kind must be one of: ${CHANNEL_KINDS.join(', ')}`,
    );
  }
  const displayName =
    typeof input.body.displayName === 'string'
      ? input.body.displayName.trim()
      : '';
  if (!displayName) {
    return badRequest('display_name_required', 'displayName is required.');
  }
  if (displayName.length > 200) {
    return badRequest(
      'display_name_too_long',
      'displayName must be 200 characters or fewer.',
    );
  }
  const enabled =
    typeof input.body.enabled === 'boolean' ? input.body.enabled : undefined;

  try {
    return await withUserContext(input.auth.userId, async () => {
      const row = await createWorkspaceChannel({
        kind: kindRaw as ChannelKind,
        displayName,
        config: input.body.config,
        ...(enabled !== undefined ? { enabled } : {}),
        createdBy: input.auth.userId,
      });
      return {
        statusCode: 201,
        body: { ok: true, data: { channel: toApiChannel(row) } },
      };
    });
  } catch (err) {
    if (err instanceof ConnectorConfigInvalidError) {
      return configErrorResponse(err);
    }
    throw err;
  }
}

export async function updateWorkspaceChannelRoute(input: {
  auth: AuthContext;
  channelId: string;
  body: {
    displayName?: unknown;
    config?: unknown;
    enabled?: unknown;
  };
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ channel: ApiWorkspaceChannel }>;
}> {
  if (!isAdminLike(input.auth.role)) return forbiddenAdminResponse();

  const patch: {
    displayName?: string;
    config?: unknown;
    enabled?: boolean;
    updatedBy: string;
  } = { updatedBy: input.auth.userId };
  if (input.body.displayName !== undefined) {
    if (typeof input.body.displayName !== 'string') {
      return badRequest(
        'invalid_display_name',
        'displayName must be a string.',
      );
    }
    const trimmed = input.body.displayName.trim();
    if (!trimmed) {
      return badRequest('display_name_required', 'displayName is required.');
    }
    if (trimmed.length > 200) {
      return badRequest(
        'display_name_too_long',
        'displayName must be 200 characters or fewer.',
      );
    }
    patch.displayName = trimmed;
  }
  if (input.body.config !== undefined) {
    patch.config = input.body.config;
  }
  if (input.body.enabled !== undefined) {
    if (typeof input.body.enabled !== 'boolean') {
      return badRequest('invalid_enabled', 'enabled must be boolean.');
    }
    patch.enabled = input.body.enabled;
  }

  try {
    return await withUserContext(input.auth.userId, async () => {
      const row = await updateWorkspaceChannel(input.channelId, patch);
      if (!row) return notFoundResponse('Channel not found.');
      return {
        statusCode: 200,
        body: { ok: true, data: { channel: toApiChannel(row) } },
      };
    });
  } catch (err) {
    if (err instanceof ConnectorConfigInvalidError) {
      return configErrorResponse(err);
    }
    throw err;
  }
}

export async function deleteWorkspaceChannelRoute(input: {
  auth: AuthContext;
  channelId: string;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ deleted: true }>;
}> {
  if (!isAdminLike(input.auth.role)) return forbiddenAdminResponse();
  return withUserContext(input.auth.userId, async () => {
    const deleted = await deleteWorkspaceChannel(input.channelId);
    if (!deleted) return notFoundResponse('Channel not found.');
    return {
      statusCode: 200,
      body: { ok: true, data: { deleted: true } },
    };
  });
}

export async function setWorkspaceChannelCredentialRoute(input: {
  auth: AuthContext;
  channelId: string;
  body: { apiKey?: unknown; organizationId?: unknown };
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ channel: ApiWorkspaceChannel }>;
}> {
  if (!isAdminLike(input.auth.role)) return forbiddenAdminResponse();

  return withUserContext(input.auth.userId, async () => {
    const existing = await getWorkspaceChannel(input.channelId);
    if (!existing) return notFoundResponse('Channel not found.');

    const apiKey =
      typeof input.body.apiKey === 'string' ? input.body.apiKey.trim() : null;
    const organizationId =
      typeof input.body.organizationId === 'string'
        ? input.body.organizationId.trim() || undefined
        : undefined;

    const row = !apiKey
      ? await setWorkspaceChannelCredential(
          input.channelId,
          null,
          input.auth.userId,
        )
      : await setWorkspaceChannelCredential(
          input.channelId,
          {
            apiKey,
            ...(organizationId ? { organizationId } : {}),
          },
          input.auth.userId,
        );
    if (!row) return notFoundResponse('Channel not found.');
    return {
      statusCode: 200,
      body: { ok: true, data: { channel: toApiChannel(row) } },
    };
  });
}

// ---------------------------------------------------------------------------
// Workspace data connectors CRUD
// ---------------------------------------------------------------------------

export async function listWorkspaceDataConnectorsRoute(
  auth: AuthContext,
): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ dataConnectors: ApiWorkspaceDataConnector[] }>;
}> {
  return withUserContext(auth.userId, async () => {
    const rows = await listWorkspaceDataConnectors();
    return {
      statusCode: 200,
      body: {
        ok: true,
        data: { dataConnectors: rows.map(toApiDataConnector) },
      },
    };
  });
}

export async function createWorkspaceDataConnectorRoute(input: {
  auth: AuthContext;
  body: {
    kind?: unknown;
    displayName?: unknown;
    config?: unknown;
    enabled?: unknown;
  };
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ dataConnector: ApiWorkspaceDataConnector }>;
}> {
  if (!isAdminLike(input.auth.role)) return forbiddenAdminResponse();

  const kindRaw =
    typeof input.body.kind === 'string' ? input.body.kind.trim() : '';
  if (!DATA_CONNECTOR_KINDS.includes(kindRaw as DataConnectorKind)) {
    return badRequest(
      'invalid_kind',
      `kind must be one of: ${DATA_CONNECTOR_KINDS.join(', ')}`,
    );
  }
  const displayName =
    typeof input.body.displayName === 'string'
      ? input.body.displayName.trim()
      : '';
  if (!displayName) {
    return badRequest('display_name_required', 'displayName is required.');
  }
  if (displayName.length > 200) {
    return badRequest(
      'display_name_too_long',
      'displayName must be 200 characters or fewer.',
    );
  }
  const enabled =
    typeof input.body.enabled === 'boolean' ? input.body.enabled : undefined;

  try {
    return await withUserContext(input.auth.userId, async () => {
      const row = await createWorkspaceDataConnector({
        kind: kindRaw as DataConnectorKind,
        displayName,
        config: input.body.config,
        ...(enabled !== undefined ? { enabled } : {}),
        createdBy: input.auth.userId,
      });
      return {
        statusCode: 201,
        body: { ok: true, data: { dataConnector: toApiDataConnector(row) } },
      };
    });
  } catch (err) {
    if (err instanceof ConnectorConfigInvalidError) {
      return configErrorResponse(err);
    }
    throw err;
  }
}

export async function updateWorkspaceDataConnectorRoute(input: {
  auth: AuthContext;
  connectorId: string;
  body: {
    displayName?: unknown;
    config?: unknown;
    enabled?: unknown;
  };
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ dataConnector: ApiWorkspaceDataConnector }>;
}> {
  if (!isAdminLike(input.auth.role)) return forbiddenAdminResponse();

  const patch: {
    displayName?: string;
    config?: unknown;
    enabled?: boolean;
    updatedBy: string;
  } = { updatedBy: input.auth.userId };
  if (input.body.displayName !== undefined) {
    if (typeof input.body.displayName !== 'string') {
      return badRequest(
        'invalid_display_name',
        'displayName must be a string.',
      );
    }
    const trimmed = input.body.displayName.trim();
    if (!trimmed) {
      return badRequest('display_name_required', 'displayName is required.');
    }
    if (trimmed.length > 200) {
      return badRequest(
        'display_name_too_long',
        'displayName must be 200 characters or fewer.',
      );
    }
    patch.displayName = trimmed;
  }
  if (input.body.config !== undefined) {
    patch.config = input.body.config;
  }
  if (input.body.enabled !== undefined) {
    if (typeof input.body.enabled !== 'boolean') {
      return badRequest('invalid_enabled', 'enabled must be boolean.');
    }
    patch.enabled = input.body.enabled;
  }

  try {
    return await withUserContext(input.auth.userId, async () => {
      const row = await updateWorkspaceDataConnector(input.connectorId, patch);
      if (!row) return notFoundResponse('Data connector not found.');
      return {
        statusCode: 200,
        body: { ok: true, data: { dataConnector: toApiDataConnector(row) } },
      };
    });
  } catch (err) {
    if (err instanceof ConnectorConfigInvalidError) {
      return configErrorResponse(err);
    }
    throw err;
  }
}

export async function deleteWorkspaceDataConnectorRoute(input: {
  auth: AuthContext;
  connectorId: string;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ deleted: true }>;
}> {
  if (!isAdminLike(input.auth.role)) return forbiddenAdminResponse();
  return withUserContext(input.auth.userId, async () => {
    const deleted = await deleteWorkspaceDataConnector(input.connectorId);
    if (!deleted) return notFoundResponse('Data connector not found.');
    return {
      statusCode: 200,
      body: { ok: true, data: { deleted: true } },
    };
  });
}

export async function setWorkspaceDataConnectorCredentialRoute(input: {
  auth: AuthContext;
  connectorId: string;
  body: { apiKey?: unknown; organizationId?: unknown };
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ dataConnector: ApiWorkspaceDataConnector }>;
}> {
  if (!isAdminLike(input.auth.role)) return forbiddenAdminResponse();

  return withUserContext(input.auth.userId, async () => {
    const existing = await getWorkspaceDataConnector(input.connectorId);
    if (!existing) return notFoundResponse('Data connector not found.');

    const apiKey =
      typeof input.body.apiKey === 'string' ? input.body.apiKey.trim() : null;
    const organizationId =
      typeof input.body.organizationId === 'string'
        ? input.body.organizationId.trim() || undefined
        : undefined;

    const row = !apiKey
      ? await setWorkspaceDataConnectorCredential(
          input.connectorId,
          null,
          input.auth.userId,
        )
      : await setWorkspaceDataConnectorCredential(
          input.connectorId,
          {
            apiKey,
            ...(organizationId ? { organizationId } : {}),
          },
          input.auth.userId,
        );
    if (!row) return notFoundResponse('Data connector not found.');
    return {
      statusCode: 200,
      body: { ok: true, data: { dataConnector: toApiDataConnector(row) } },
    };
  });
}

// ---------------------------------------------------------------------------
// Per-Talk connector picker + toggles
// ---------------------------------------------------------------------------

export async function getTalkConnectorsRoute(input: {
  auth: AuthContext;
  talkId: string;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{
    channels: Array<{
      id: string;
      kind: ChannelKind;
      displayName: string;
      enabled: boolean;
      linked: boolean;
    }>;
    dataConnectors: Array<{
      id: string;
      kind: DataConnectorKind;
      displayName: string;
      enabled: boolean;
      linked: boolean;
    }>;
  }>;
}> {
  return withUserContext(input.auth.userId, async () => {
    const talk = await getTalkForUser(input.talkId);
    if (!talk) return notFoundResponse('Talk not found.');
    const view = await getTalkConnectorsView(input.talkId);
    return {
      statusCode: 200,
      body: {
        ok: true,
        data: {
          channels: view.channels.map((c) => ({
            id: c.id,
            kind: c.kind as ChannelKind,
            displayName: c.displayName,
            enabled: c.enabled,
            linked: c.linked,
          })),
          dataConnectors: view.dataConnectors.map((d) => ({
            id: d.id,
            kind: d.kind as DataConnectorKind,
            displayName: d.displayName,
            enabled: d.enabled,
            linked: d.linked,
          })),
        },
      },
    };
  });
}

export async function setTalkChannelLinkRoute(input: {
  auth: AuthContext;
  talkId: string;
  channelId: string;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ linked: true }>;
}> {
  return withUserContext(input.auth.userId, async () => {
    const talk = await getTalkForUser(input.talkId);
    if (!talk) return notFoundResponse('Talk not found.');
    if (!(await canEditTalk(input.talkId))) {
      return forbiddenTalkResponse();
    }
    const channel = await getWorkspaceChannel(input.channelId);
    if (!channel) return notFoundResponse('Channel not found.');

    await linkTalkChannel({
      talkId: input.talkId,
      channelId: input.channelId,
      ownerId: input.auth.userId,
    });
    return {
      statusCode: 200,
      body: { ok: true, data: { linked: true } },
    };
  });
}

export async function deleteTalkChannelLinkRoute(input: {
  auth: AuthContext;
  talkId: string;
  channelId: string;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ unlinked: true }>;
}> {
  return withUserContext(input.auth.userId, async () => {
    const talk = await getTalkForUser(input.talkId);
    if (!talk) return notFoundResponse('Talk not found.');
    if (!(await canEditTalk(input.talkId))) {
      return forbiddenTalkResponse();
    }
    await unlinkTalkChannel({
      talkId: input.talkId,
      channelId: input.channelId,
    });
    return {
      statusCode: 200,
      body: { ok: true, data: { unlinked: true } },
    };
  });
}

export async function setTalkDataConnectorLinkRoute(input: {
  auth: AuthContext;
  talkId: string;
  connectorId: string;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ linked: true }>;
}> {
  return withUserContext(input.auth.userId, async () => {
    const talk = await getTalkForUser(input.talkId);
    if (!talk) return notFoundResponse('Talk not found.');
    if (!(await canEditTalk(input.talkId))) {
      return forbiddenTalkResponse();
    }
    const dc = await getWorkspaceDataConnector(input.connectorId);
    if (!dc) return notFoundResponse('Data connector not found.');

    await linkTalkDataConnector({
      talkId: input.talkId,
      dataConnectorId: input.connectorId,
      ownerId: input.auth.userId,
    });
    return {
      statusCode: 200,
      body: { ok: true, data: { linked: true } },
    };
  });
}

export async function deleteTalkDataConnectorLinkRoute(input: {
  auth: AuthContext;
  talkId: string;
  connectorId: string;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ unlinked: true }>;
}> {
  return withUserContext(input.auth.userId, async () => {
    const talk = await getTalkForUser(input.talkId);
    if (!talk) return notFoundResponse('Talk not found.');
    if (!(await canEditTalk(input.talkId))) {
      return forbiddenTalkResponse();
    }
    await unlinkTalkDataConnector({
      talkId: input.talkId,
      dataConnectorId: input.connectorId,
    });
    return {
      statusCode: 200,
      body: { ok: true, data: { unlinked: true } },
    };
  });
}
