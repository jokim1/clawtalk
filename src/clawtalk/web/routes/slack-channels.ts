// Slack channel picker routes (PR 2).
//
// PR 1 landed the workspace install flow. This file ships the picker on top
// of it: given an installed workspace, list its Slack channels and bulk-add
// them through the channel compatibility accessor as final `connectors` rows
// so they appear in the existing Talk connector picker. The legacy
// config.workspace_id key is the Slack team id alias normalized by the
// accessor/indexes.

import { withUserContext } from '../../../db.js';
import {
  SlackApiError,
  type SlackChannel,
  listSlackConversations,
} from '../../connectors/slack-client.js';
import {
  createWorkspaceChannel,
  listWorkspaceChannels,
} from '../../db/connectors-accessors.js';
import {
  decryptWorkspaceSlackInstallToken,
  getWorkspaceSlackInstall,
} from '../../db/slack-installs-accessors.js';
import { resolveWorkspaceForUser } from '../../workspaces/accessors.js';
import { ensureWorkspaceBootstrapForUser } from '../../workspaces/bootstrap.js';
import { ApiEnvelope, AuthContext } from '../types.js';

interface JsonRouteResult<T> {
  statusCode: number;
  body: ApiEnvelope<T>;
}

function errorResult(
  statusCode: number,
  code: string,
  message: string,
): JsonRouteResult<never> {
  return { statusCode, body: { ok: false, error: { code, message } } };
}

function isAdminLike(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function forbiddenAdminResponse(): JsonRouteResult<never> {
  return errorResult(
    403,
    'forbidden',
    'Only workspace admins can manage Slack channels.',
  );
}

function mapSlackApiError(err: SlackApiError): JsonRouteResult<never> {
  return errorResult(
    err.slackError === 'token_revoked' || err.slackError === 'invalid_auth'
      ? 401
      : 502,
    `slack_${err.slackError}`,
    err.message,
  );
}

async function loadSlackChannelsForInstall(
  teamId: string,
  workspaceId: string,
): Promise<
  | { ok: true; channels: SlackChannel[] }
  | { ok: false; result: JsonRouteResult<never> }
> {
  const token = await decryptWorkspaceSlackInstallToken(teamId, {
    workspaceId,
  });
  if (!token) {
    return {
      ok: false,
      result: errorResult(
        409,
        'install_credential_missing',
        'Slack workspace credential is missing; reconnect the workspace.',
      ),
    };
  }

  try {
    return { ok: true, channels: await listSlackConversations({ token }) };
  } catch (err) {
    if (err instanceof SlackApiError) {
      return { ok: false, result: mapSlackApiError(err) };
    }
    throw err;
  }
}

async function withSlackAdminWorkspace<T>(
  auth: AuthContext,
  requestedWorkspaceId: string | null | undefined,
  fn: (workspaceId: string) => Promise<JsonRouteResult<T>>,
): Promise<JsonRouteResult<T>> {
  if (requestedWorkspaceId && !UUID_RE.test(requestedWorkspaceId)) {
    return errorResult(
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
      return errorResult(
        requestedWorkspaceId ? 403 : 404,
        requestedWorkspaceId ? 'workspace_forbidden' : 'workspace_not_found',
        requestedWorkspaceId
          ? 'Workspace is not available for this user.'
          : 'No workspace exists.',
      );
    }
    if (!isAdminLike(workspace.role)) return forbiddenAdminResponse();
    return fn(workspace.id);
  });
}

// ---------------------------------------------------------------------------
// GET /api/v1/workspace/connectors/slack/installs/:teamId/channels
// ---------------------------------------------------------------------------

export interface ApiSlackChannelOption {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
  numMembers: number | null;
  topic: string | null;
  alreadyAdded: boolean;
}

export async function listSlackInstallChannelsRoute(input: {
  auth: AuthContext;
  teamId: string;
  requestedWorkspaceId?: string | null;
}): Promise<JsonRouteResult<{ channels: ApiSlackChannelOption[] }>> {
  return withSlackAdminWorkspace(
    input.auth,
    input.requestedWorkspaceId,
    async (workspaceId) => {
      const install = await getWorkspaceSlackInstall(input.teamId, {
        workspaceId,
      });
      if (!install) {
        return errorResult(
          404,
          'install_not_found',
          'Slack workspace is not connected.',
        );
      }
      const loadedChannels = await loadSlackChannelsForInstall(
        input.teamId,
        workspaceId,
      );
      if (!loadedChannels.ok) return loadedChannels.result;

      // Build the already-added set from connector-backed Slack channel rows.
      const existing = await listWorkspaceChannels({ workspaceId });
      const alreadyAddedChannelIds = new Set<string>();
      for (const row of existing) {
        if (row.kind !== 'slack') continue;
        const cfg = row.config_json as Record<string, unknown>;
        if ((cfg.teamId ?? cfg.workspace_id) !== input.teamId) continue;
        if (typeof cfg.channel_id === 'string') {
          alreadyAddedChannelIds.add(cfg.channel_id);
        }
      }

      const channels: ApiSlackChannelOption[] = loadedChannels.channels
        .map((c) => ({
          id: c.id,
          name: c.name,
          isPrivate: Boolean(c.is_private),
          isMember: Boolean(c.is_member),
          numMembers: typeof c.num_members === 'number' ? c.num_members : null,
          topic: c.topic?.value || null,
          alreadyAdded: alreadyAddedChannelIds.has(c.id),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      return { statusCode: 200, body: { ok: true, data: { channels } } };
    },
  );
}

// ---------------------------------------------------------------------------
// POST /api/v1/workspace/connectors/slack/installs/:teamId/channels
// ---------------------------------------------------------------------------

interface BulkAddChannelInput {
  channelId: string;
  channelName: string;
  isPrivate?: boolean;
  displayName?: string;
}

interface ApiCreatedSlackChannel {
  id: string;
  channelId: string;
  displayName: string;
}

function isBulkAddChannelInput(value: unknown): value is BulkAddChannelInput {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.channelId === 'string' &&
    v.channelId.length > 0 &&
    typeof v.channelName === 'string' &&
    v.channelName.length > 0
  );
}

export async function bulkAddSlackChannelsRoute(input: {
  auth: AuthContext;
  teamId: string;
  body: { channels?: unknown };
  requestedWorkspaceId?: string | null;
}): Promise<JsonRouteResult<{ created: ApiCreatedSlackChannel[] }>> {
  const rawChannels = Array.isArray(input.body.channels)
    ? (input.body.channels as unknown[])
    : null;
  if (!rawChannels || rawChannels.length === 0) {
    return errorResult(
      400,
      'channels_required',
      'channels must be a non-empty array.',
    );
  }
  const cleaned: BulkAddChannelInput[] = [];
  for (const entry of rawChannels) {
    if (!isBulkAddChannelInput(entry)) {
      return errorResult(
        400,
        'invalid_channel_entry',
        'Each channel needs channelId + channelName strings.',
      );
    }
    cleaned.push(entry);
  }

  return withSlackAdminWorkspace(
    input.auth,
    input.requestedWorkspaceId,
    async (workspaceId) => {
      const install = await getWorkspaceSlackInstall(input.teamId, {
        workspaceId,
      });
      if (!install) {
        return errorResult(
          404,
          'install_not_found',
          'Slack workspace is not connected.',
        );
      }
      const loadedChannels = await loadSlackChannelsForInstall(
        input.teamId,
        workspaceId,
      );
      if (!loadedChannels.ok) return loadedChannels.result;
      const visibleChannelsById = new Map(
        loadedChannels.channels.map((channel) => [channel.id, channel]),
      );

      // Deduplicate against existing slack channels for this workspace so
      // the picker's alreadyAdded flag isn't the only line of defense.
      const existing = await listWorkspaceChannels({ workspaceId });
      const alreadyAddedChannelIds = new Set<string>();
      for (const row of existing) {
        if (row.kind !== 'slack') continue;
        const cfg = row.config_json as Record<string, unknown>;
        if ((cfg.teamId ?? cfg.workspace_id) !== input.teamId) continue;
        if (typeof cfg.channel_id === 'string') {
          alreadyAddedChannelIds.add(cfg.channel_id);
        }
      }

      const channelsToCreate: SlackChannel[] = [];
      const requestedChannelIds = new Set<string>();
      for (const entry of cleaned) {
        if (alreadyAddedChannelIds.has(entry.channelId)) continue;
        if (requestedChannelIds.has(entry.channelId)) continue;
        const canonical = visibleChannelsById.get(entry.channelId);
        if (!canonical) {
          return errorResult(
            400,
            'channel_not_available',
            'Slack channel is not visible to this workspace install.',
          );
        }
        if (!canonical.is_member) {
          return errorResult(
            409,
            'channel_not_joined',
            'The Slack bot must be a member of the channel before it can be added.',
          );
        }
        requestedChannelIds.add(entry.channelId);
        channelsToCreate.push(canonical);
      }

      const created: ApiCreatedSlackChannel[] = [];
      for (const channel of channelsToCreate) {
        const row = await createWorkspaceChannel({
          workspaceId,
          kind: 'slack',
          displayName: channel.name,
          authorized: true,
          config: {
            workspace_id: input.teamId,
            channel_id: channel.id,
            channel_name: channel.name,
            is_private: Boolean(channel.is_private),
            credentialSource: 'workspace_slack_install',
          },
          createdBy: input.auth.userId,
          allowSlackChannelImport: true,
        });
        created.push({
          id: row.id,
          channelId: channel.id,
          displayName: row.display_name,
        });
        alreadyAddedChannelIds.add(channel.id);
      }

      return { statusCode: 201, body: { ok: true, data: { created } } };
    },
  );
}
