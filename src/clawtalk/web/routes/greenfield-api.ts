import type { Context, Hono } from 'hono';

import { withUserContext } from '../../../db.js';
import { getUserById, updateUserDisplayName } from '../../db/index.js';
import {
  dispatchRunInProcess,
  type DispatchRunInProcessEnv,
} from '../../talks/dispatch-in-process.js';
import { dispatchRun } from '../../talks/queue-producer.js';
import { validateCsrfTokenPg } from '../middleware/csrf.js';
import {
  checkRateLimit,
  type RateLimitResult,
} from '../middleware/rate-limit.js';
import type { AuthContext } from '../types.js';
import {
  cancelGreenfieldChatRoute,
  enqueueGreenfieldChatRoute,
} from './greenfield-chat.js';
import {
  acceptGreenfieldContentEditRoute,
  acceptGreenfieldContentEditRunRoute,
  createGreenfieldTalkContentRoute,
  createGreenfieldThreadContentRoute,
  createGreenfieldThreadRoute,
  deleteGreenfieldMessagesRoute,
  deleteGreenfieldThreadRoute,
  getGreenfieldSnapshotRoute,
  getGreenfieldTalkContentRoute,
  getGreenfieldThreadContentRoute,
  listGreenfieldMessagesRoute,
  listGreenfieldRunsRoute,
  listGreenfieldThreadsRoute,
  patchGreenfieldContentRoute,
  patchGreenfieldThreadRoute,
  rejectGreenfieldContentEditRoute,
  rejectGreenfieldContentEditRunRoute,
  searchGreenfieldMessagesRoute,
} from './greenfield-detail.js';
import {
  archiveGreenfieldTalkRoute,
  createGreenfieldFolderRoute,
  createGreenfieldTalkRoute,
  deleteGreenfieldFolderRoute,
  getGreenfieldTalkPolicyRoute,
  getGreenfieldMeRoute,
  getGreenfieldTalkRoute,
  getGreenfieldTalkToolsRoute,
  listGreenfieldAgentsRoute,
  listGreenfieldFoldersRoute,
  listGreenfieldTalkAgentsRoute,
  listGreenfieldTalksRoute,
  listGreenfieldTalkSidebarRoute,
  listGreenfieldWorkspacesRoute,
  patchGreenfieldFolderRoute,
  patchGreenfieldTalkRoute,
  switchGreenfieldWorkspaceRoute,
  updateGreenfieldTalkAgentsRoute,
  updateGreenfieldTalkPolicyRoute,
  updateGreenfieldTalkToolRoute,
} from './greenfield-core.js';

type Variables = {
  auth: AuthContext;
};

type GreenfieldApp = Hono<{ Variables: Variables }>;

export function mountGreenfieldApiRoutes(app: GreenfieldApp): void {
  // ── session/me: current user info + display-name patch ───────
  app.get('/api/v1/session/me', async (c) => {
    const auth = c.get('auth');
    const result = await getGreenfieldMeRoute({
      auth,
      requestedWorkspaceId: requestedWorkspaceId(c),
    });
    return jsonResponse(result);
  });

  app.get('/api/v1/me', async (c) => {
    const auth = c.get('auth');
    const result = await getGreenfieldMeRoute({
      auth,
      requestedWorkspaceId: requestedWorkspaceId(c),
    });
    return jsonResponse(result);
  });

  app.patch('/api/v1/session/me', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readJsonBody<{ displayName?: unknown }>(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);

    let displayName: string | null = null;
    if (typeof payload.data.displayName === 'string') {
      displayName = payload.data.displayName.trim();
      if (displayName.length === 0 || displayName.length > 200) {
        return c.json(
          {
            ok: false,
            error: {
              code: 'invalid_display_name',
              message: 'Display name must be between 1 and 200 characters.',
            },
          },
          400,
        );
      }
    }

    const updated = await withUserContext(auth.userId, async () => {
      if (displayName !== null) {
        await updateUserDisplayName({
          userId: auth.userId,
          displayName,
        });
      }
      return getUserById(auth.userId);
    });
    if (!updated || !updated.is_active) {
      return c.json(
        {
          ok: false,
          error: { code: 'unauthorized', message: 'Session is not active' },
        },
        401,
      );
    }
    return c.json({ ok: true, data: { user: normalizeUser(updated) } });
  });

  // ── Greenfield workspace shell ───────────────────────────────
  app.get('/api/v1/workspaces', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await listGreenfieldWorkspacesRoute({ auth });
    return jsonResponse(result);
  });

  app.post('/api/v1/workspaces/switch', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readJsonBody<{ workspaceId?: string }>(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await switchGreenfieldWorkspaceRoute({
      auth,
      workspaceId: payload.data.workspaceId,
    });
    return jsonResponse(result);
  });

  app.get('/api/v1/folders', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await listGreenfieldFoldersRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
    });
    return jsonResponse(result);
  });

  app.post('/api/v1/folders', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readJsonBody<{ title?: string }>(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await createGreenfieldFolderRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      title: payload.data.title,
    });
    return jsonResponse(result);
  });

  app.patch('/api/v1/folders/:id', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const folderId = decodeIdParam(c, 'id');
    if (!folderId.ok) return folderId.response;
    const payload = await readJsonBody<{
      title?: string;
      sortOrder?: number;
    }>(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await patchGreenfieldFolderRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      folderId: folderId.value,
      title: payload.data.title,
      sortOrder:
        typeof payload.data.sortOrder === 'number'
          ? payload.data.sortOrder
          : undefined,
    });
    return jsonResponse(result);
  });

  app.delete('/api/v1/folders/:id', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const folderId = decodeIdParam(c, 'id');
    if (!folderId.ok) return folderId.response;
    const result = await deleteGreenfieldFolderRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      folderId: folderId.value,
    });
    return jsonResponse(result);
  });

  app.get('/api/v1/workspace/agents', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await listGreenfieldAgentsRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
    });
    return jsonResponse(result);
  });

  app.get('/api/v1/teams', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await listGreenfieldAgentsRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
    });
    if (!result.body.ok) return jsonResponse(result);
    return jsonResponse({
      statusCode: result.statusCode,
      body: { ok: true, data: { teams: result.body.data.teams } },
    });
  });

  // ── Greenfield Talk shell ────────────────────────────────────
  app.get('/api/v1/talks', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ userId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await listGreenfieldTalksRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      folderId: c.req.query('folder') ?? c.req.query('folderId') ?? 'all',
      includeArchived: c.req.query('include_archived') === 'true',
    });
    return jsonResponse(result);
  });

  app.get('/api/v1/talks/sidebar', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ userId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await listGreenfieldTalkSidebarRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
    });
    return jsonResponse(result);
  });

  app.post('/api/v1/talks', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ userId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readJsonBody<Record<string, unknown>>(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await createGreenfieldTalkRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      body: payload.data,
    });
    return jsonResponse(result);
  });

  app.post('/api/v1/talk-folders', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ userId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readJsonBody<{ title?: string }>(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await createGreenfieldFolderRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      title: payload.data.title,
    });
    return jsonResponse(result);
  });

  app.get('/api/v1/talks/:talkId', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ userId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const talkId = decodeIdParam(c, 'talkId');
    if (!talkId.ok) return talkId.response;
    const result = await getGreenfieldTalkRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      talkId: talkId.value,
    });
    return jsonResponse(result);
  });

  app.patch('/api/v1/talks/:id', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ userId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const talkId = decodeIdParam(c, 'id');
    if (!talkId.ok) return talkId.response;
    const payload = await readJsonBody<{
      title?: string;
      folderId?: string | null;
      orchestrationMode?: 'ordered' | 'panel';
      mode?: string;
      rounds?: number;
      roundsLimit?: number;
      sortOrder?: number;
    }>(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await patchGreenfieldTalkRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      talkId: talkId.value,
      body: payload.data,
    });
    return jsonResponse(result);
  });

  app.delete('/api/v1/talks/:id', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ userId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const talkId = decodeIdParam(c, 'id');
    if (!talkId.ok) return talkId.response;
    const result = await archiveGreenfieldTalkRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      talkId: talkId.value,
    });
    return jsonResponse(result);
  });

  app.patch('/api/v1/talk-folders/:id', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ userId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const folderId = decodeIdParam(c, 'id');
    if (!folderId.ok) return folderId.response;
    const payload = await readJsonBody<{ title?: string; sortOrder?: number }>(
      c,
    );
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await patchGreenfieldFolderRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      folderId: folderId.value,
      title:
        typeof payload.data.title === 'string' ? payload.data.title : undefined,
      sortOrder:
        typeof payload.data.sortOrder === 'number'
          ? payload.data.sortOrder
          : undefined,
    });
    return jsonResponse(result);
  });

  app.delete('/api/v1/talk-folders/:id', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ userId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const folderId = decodeIdParam(c, 'id');
    if (!folderId.ok) return folderId.response;
    const result = await deleteGreenfieldFolderRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      folderId: folderId.value,
    });
    return jsonResponse(result);
  });

  app.get('/api/v1/talks/:talkId/messages', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ userId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const talkId = decodeIdParam(c, 'talkId');
    if (!talkId.ok) return talkId.response;
    const limit = parsePositiveInt(c.req.query('limit'));
    const beforeCreatedAt = c.req.query('before') || undefined;
    const threadId = (c.req.query('threadId') || '').trim() || undefined;
    const result = await listGreenfieldMessagesRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      talkId: talkId.value,
      threadId,
      limit: limit ?? undefined,
      beforeCreatedAt,
    });
    return jsonResponse(result);
  });

  app.get('/api/v1/talks/:talkId/snapshot', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const talkId = decodeIdParam(c, 'talkId');
    if (!talkId.ok) return talkId.response;
    const threadId = (c.req.query('threadId') || '').trim() || undefined;
    const result = await getGreenfieldSnapshotRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      talkId: talkId.value,
      threadId,
    });
    return jsonResponse(result);
  });

  app.post('/api/v1/talks/:talkId/messages/delete', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ userId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const talkId = decodeIdParam(c, 'talkId');
    if (!talkId.ok) return talkId.response;
    const payload = await readJsonBody<{
      messageIds?: unknown;
      threadId?: unknown;
    }>(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const messageIds = Array.isArray(payload.data.messageIds)
      ? payload.data.messageIds.filter(
          (value): value is string => typeof value === 'string',
        )
      : [];
    const result = await deleteGreenfieldMessagesRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      talkId: talkId.value,
      messageIds,
    });
    return jsonResponse(result);
  });

  app.get('/api/v1/talks/:talkId/messages/search', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ userId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const talkId = decodeIdParam(c, 'talkId');
    if (!talkId.ok) return talkId.response;
    const query = c.req.query('q') || '';
    const limit = parsePositiveInt(c.req.query('limit'));
    const result = await searchGreenfieldMessagesRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      talkId: talkId.value,
      query,
      limit: limit ?? undefined,
    });
    return jsonResponse(result);
  });

  app.get('/api/v1/talks/:talkId/agents', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ userId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const talkId = decodeIdParam(c, 'talkId');
    if (!talkId.ok) return talkId.response;
    const result = await listGreenfieldTalkAgentsRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      talkId: talkId.value,
    });
    return jsonResponse(result);
  });

  app.put('/api/v1/talks/:talkId/agents', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ userId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const talkId = decodeIdParam(c, 'talkId');
    if (!talkId.ok) return talkId.response;
    const payload = await readJsonBody<{ agents?: unknown }>(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await updateGreenfieldTalkAgentsRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      talkId: talkId.value,
      agents: payload.data.agents,
    });
    return jsonResponse(result);
  });

  app.get('/api/v1/talks/:talkId/tools', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ userId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const talkId = decodeIdParam(c, 'talkId');
    if (!talkId.ok) return talkId.response;
    const result = await getGreenfieldTalkToolsRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      talkId: talkId.value,
    });
    return jsonResponse(result);
  });

  app.patch('/api/v1/talks/:talkId/tools', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ userId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const talkId = decodeIdParam(c, 'talkId');
    if (!talkId.ok) return talkId.response;
    const payload = await readJsonBody(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await updateGreenfieldTalkToolRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      talkId: talkId.value,
      body: payload.data,
    });
    return jsonResponse(result);
  });

  app.get('/api/v1/talks/:talkId/policy', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ userId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const talkId = decodeIdParam(c, 'talkId');
    if (!talkId.ok) return talkId.response;
    const result = await getGreenfieldTalkPolicyRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      talkId: talkId.value,
    });
    return jsonResponse(result);
  });

  app.put('/api/v1/talks/:talkId/policy', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ userId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const talkId = decodeIdParam(c, 'talkId');
    if (!talkId.ok) return talkId.response;
    const payload = await readJsonBody<{ agents?: unknown }>(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await updateGreenfieldTalkPolicyRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      talkId: talkId.value,
      agents: payload.data.agents,
    });
    return jsonResponse(result);
  });

  app.get('/api/v1/talks/:talkId/runs', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ userId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const talkId = decodeIdParam(c, 'talkId');
    if (!talkId.ok) return talkId.response;
    const result = await listGreenfieldRunsRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      talkId: talkId.value,
    });
    return jsonResponse(result);
  });

  // ── Greenfield document compatibility routes ─────────────────
  app.get('/api/v1/talks/:talkId/content', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await getGreenfieldTalkContentRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      talkId: c.req.param('talkId'),
    });
    return jsonResponse(result);
  });

  app.post('/api/v1/talks/:talkId/content', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readJsonBody<{ title?: unknown; format?: unknown }>(
      c,
    );
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await createGreenfieldTalkContentRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      talkId: c.req.param('talkId'),
      title: payload.data.title,
      format: payload.data.format,
    });
    return jsonResponse(result);
  });

  app.get('/api/v1/threads/:threadId/content', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await getGreenfieldThreadContentRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      threadId: c.req.param('threadId'),
    });
    return jsonResponse(result);
  });

  app.post('/api/v1/threads/:threadId/content', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readJsonBody<{ title?: unknown; format?: unknown }>(
      c,
    );
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await createGreenfieldThreadContentRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      threadId: c.req.param('threadId'),
      title: payload.data.title,
      format: payload.data.format,
    });
    return jsonResponse(result);
  });

  app.patch('/api/v1/contents/:contentId', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readJsonBody<{
      expectedVersion?: unknown;
      bodyMarkdown?: unknown;
      bodyHtml?: unknown;
      title?: unknown;
      acceptPendingEditIds?: unknown;
    }>(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await patchGreenfieldContentRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      contentId: c.req.param('contentId'),
      expectedVersion: payload.data.expectedVersion,
      bodyMarkdown: payload.data.bodyMarkdown,
      bodyHtml: payload.data.bodyHtml,
      title: payload.data.title,
      acceptPendingEditIds: payload.data.acceptPendingEditIds,
    });
    return jsonResponse(result);
  });

  app.post('/api/v1/contents/:contentId/edits/:editId/accept', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readJsonBody<{ expectedContentVersion?: unknown }>(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await acceptGreenfieldContentEditRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      contentId: c.req.param('contentId'),
      editId: c.req.param('editId'),
      expectedContentVersion: payload.data.expectedContentVersion,
    });
    return jsonResponse(result);
  });

  app.post('/api/v1/contents/:contentId/edits/:editId/reject', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const result = await rejectGreenfieldContentEditRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      contentId: c.req.param('contentId'),
      editId: c.req.param('editId'),
    });
    return jsonResponse(result);
  });

  app.post('/api/v1/contents/:contentId/runs/:runId/accept', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readJsonBody<{ expectedContentVersion?: unknown }>(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await acceptGreenfieldContentEditRunRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      contentId: c.req.param('contentId'),
      runId: c.req.param('runId'),
      expectedContentVersion: payload.data.expectedContentVersion,
    });
    return jsonResponse(result);
  });

  app.post('/api/v1/contents/:contentId/runs/:runId/reject', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const result = await rejectGreenfieldContentEditRunRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      contentId: c.req.param('contentId'),
      runId: c.req.param('runId'),
    });
    return jsonResponse(result);
  });

  app.get('/api/v1/talks/:talkId/threads', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await listGreenfieldThreadsRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      talkId: c.req.param('talkId'),
    });
    return jsonResponse(result);
  });

  app.post('/api/v1/talks/:talkId/threads', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readJsonBody<{ title?: unknown }>(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await createGreenfieldThreadRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      talkId: c.req.param('talkId'),
    });
    return jsonResponse(result);
  });

  app.patch('/api/v1/talks/:talkId/threads/:threadId', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readJsonBody<{ title?: unknown; pinned?: unknown }>(
      c,
    );
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await patchGreenfieldThreadRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      talkId: c.req.param('talkId'),
      threadId: c.req.param('threadId'),
    });
    return jsonResponse(result);
  });

  app.delete('/api/v1/talks/:talkId/threads/:threadId', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const result = await deleteGreenfieldThreadRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      talkId: c.req.param('talkId'),
      threadId: c.req.param('threadId'),
    });
    return jsonResponse(result);
  });

  // ── Greenfield chat enqueue + cancel (Queues port U2) ─────────
  app.post('/api/v1/talks/:talkId/chat', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const parsed = await readJsonBody<{
      content?: unknown;
      threadId?: unknown;
      targetAgentIds?: unknown;
      attachmentIds?: unknown;
    }>(c);
    if (!parsed.ok) {
      return c.json(
        { ok: false, error: { code: 'invalid_json', message: parsed.error } },
        400,
      );
    }
    const result = await enqueueGreenfieldChatRoute({
      talkId: c.req.param('talkId'),
      workspaceId: requestedWorkspaceId(c),
      threadId:
        typeof parsed.data.threadId === 'string'
          ? parsed.data.threadId.trim() || null
          : null,
      auth,
      content:
        typeof parsed.data.content === 'string' ? parsed.data.content : '',
      targetAgentIds: Array.isArray(parsed.data.targetAgentIds)
        ? parsed.data.targetAgentIds.filter(
            (entry): entry is string => typeof entry === 'string',
          )
        : null,
      attachmentIds: Array.isArray(parsed.data.attachmentIds)
        ? parsed.data.attachmentIds.filter(
            (entry): entry is string => typeof entry === 'string',
          )
        : null,
    });
    if (result.statusCode === 202 && result.body.ok) {
      const runs = result.body.data.runs;
      if (runs.length === 1) {
        // T7: bypass queue for single-run. See dispatchRunInProcess.
        c.executionCtx.waitUntil(
          dispatchRunInProcess({
            env: c.env as DispatchRunInProcessEnv,
            ctx: c.executionCtx,
            runId: runs[0].id,
          }),
        );
      } else {
        for (const run of runs) {
          await dispatchRun({ runId: run.id });
        }
      }
    }
    return jsonResponse(result);
  });

  app.post('/api/v1/talks/:talkId/chat/cancel', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const parsed = await readJsonBody<{ threadId?: unknown }>(c);
    if (!parsed.ok) {
      return c.json(
        { ok: false, error: { code: 'invalid_json', message: parsed.error } },
        400,
      );
    }
    // Cooperative cancellation: the route just flips the DB status.
    // The queue consumer polls run.status during execution and bails
    // when it sees 'cancelled'. No in-process AbortController wake
    // needed — the cancelledRunning flag is discarded.
    const result = await cancelGreenfieldChatRoute({
      talkId: c.req.param('talkId'),
      workspaceId: requestedWorkspaceId(c),
      threadId:
        typeof parsed.data.threadId === 'string'
          ? parsed.data.threadId.trim() || null
          : null,
      auth,
    });
    return jsonResponse(result);
  });
}

type NormalizedUser = {
  id: string;
  email: string;
  displayName: string;
  role: 'owner' | 'admin' | 'member';
  createdAt: string;
};

function normalizeUser(user: {
  id: string;
  email: string;
  display_name: string;
  role: 'owner' | 'admin' | 'member';
  created_at: string;
}): NormalizedUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    role: user.role,
    createdAt: user.created_at,
  };
}

function requestedWorkspaceId(c: Context): string | null {
  return (
    c.req.header('x-workspace-id') ??
    c.req.header('x-clawtalk-workspace-id') ??
    c.req.query('workspaceId') ??
    null
  );
}

function jsonResponse(result: { statusCode: number; body: unknown }): Response {
  return new Response(JSON.stringify(result.body), {
    status: result.statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function rateLimitedResponse(
  c: Context,
  rateResult: RateLimitResult,
): Response {
  return c.json(
    {
      ok: false,
      error: {
        code: 'rate_limited',
        message: 'Rate limit exceeded',
        details: {
          limit: rateResult.limit,
          retryAfterSec: rateResult.retryAfterSec,
        },
      },
    },
    429,
    {
      'retry-after': String(rateResult.retryAfterSec),
    },
  );
}

function checkCsrf(c: Context, auth: AuthContext): Response | null {
  const csrf = validateCsrfTokenPg({
    method: c.req.method,
    authType: auth.authType,
    cookieHeader: c.req.header('cookie'),
    csrfHeader: c.req.header('x-csrf-token'),
  });
  if (csrf.ok) return null;
  return c.json(
    {
      ok: false,
      error: { code: 'csrf_failed', message: csrf.reason },
    },
    403,
  );
}

async function readJsonBody<T = Record<string, unknown>>(
  c: Context,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const bodyText = await c.req.text();
  if (!bodyText.trim()) return { ok: true, data: {} as T };
  try {
    return { ok: true, data: JSON.parse(bodyText) as T };
  } catch {
    return { ok: false, error: 'Request body is not valid JSON' };
  }
}

function invalidJsonResponse(c: Context, message: string): Response {
  return c.json({ ok: false, error: { code: 'invalid_json', message } }, 400);
}

type DecodedIdParam =
  | { ok: true; value: string }
  | { ok: false; response: Response };

function decodeIdParam(c: Context, paramName: string): DecodedIdParam {
  const raw = c.req.param(paramName);
  if (raw) {
    try {
      return { ok: true, value: decodeURIComponent(raw) };
    } catch {
      // fall through to error response
    }
  }
  return {
    ok: false,
    response: c.json(
      {
        ok: false,
        error: {
          code: paramName === 'talkId' ? 'invalid_talk_id' : 'bad_request',
          message: `${paramName} path segment is not valid URL encoding`,
        },
      },
      400,
    ),
  };
}

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}
