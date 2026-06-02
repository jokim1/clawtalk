import type { Context, Hono } from 'hono';

import {
  withRequestScopedDb,
  withUserContext,
  type DbScopeEnvBindings,
  type RequestExecutionContext,
} from '../../../db.js';
import { logger } from '../../../logger.js';
import { updateUserDisplayName } from '../../db/index.js';
import {
  dispatchRunInProcess,
  type DispatchRunInProcessEnv,
} from '../../talks/dispatch-in-process.js';
import { updateGreenfieldContextSourceExtraction } from '../../talks/greenfield-context-accessors.js';
import { dispatchRun } from '../../talks/queue-producer.js';
import { ingestUrlSource } from '../../talks/source-ingestion.js';
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
  createGreenfieldTalkContextRuleRoute,
  createGreenfieldTalkContextSourceRoute,
  deleteGreenfieldTalkContextRuleRoute,
  deleteGreenfieldTalkContextSourceRoute,
  deleteGreenfieldTalkStateEntryRoute,
  getGreenfieldTalkContextRoute,
  getGreenfieldTalkContextSourceContentRoute,
  getGreenfieldTalkStateRoute,
  listGreenfieldTalkContextRulesRoute,
  patchGreenfieldTalkContextRuleRoute,
  patchGreenfieldTalkContextSourceRoute,
  retryGreenfieldTalkContextSourceRoute,
  setGreenfieldTalkGoalRoute,
  uploadGreenfieldTalkContextSourcePageImageRoute,
  uploadGreenfieldTalkContextSourceRoute,
} from './greenfield-context.js';
import {
  createGreenfieldTalkJobRoute,
  deleteGreenfieldTalkJobRoute,
  getGreenfieldTalkJobRoute,
  listGreenfieldTalkJobRunsRoute,
  listGreenfieldTalkJobsRoute,
  patchGreenfieldTalkJobRoute,
  pauseGreenfieldTalkJobRoute,
  resumeGreenfieldTalkJobRoute,
  runGreenfieldTalkJobNowRoute,
} from './greenfield-jobs.js';
import {
  acceptGreenfieldContentEditRoute,
  acceptGreenfieldContentEditRunRoute,
  createGreenfieldTalkContentRoute,
  createGreenfieldThreadContentRoute,
  createGreenfieldThreadRoute,
  deleteGreenfieldMessagesRoute,
  deleteGreenfieldThreadRoute,
  getGreenfieldRunContextRoute,
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
  reorderGreenfieldTalkSidebarRoute,
  switchGreenfieldWorkspaceRoute,
  updateGreenfieldTalkAgentsRoute,
  updateGreenfieldTalkPolicyRoute,
  updateGreenfieldTalkToolRoute,
} from './greenfield-core.js';

type Variables = {
  auth: AuthContext;
};

type GreenfieldApp = Hono<{ Variables: Variables }>;
type GreenfieldContextIngestionEnv = DbScopeEnvBindings & {
  DB?: { connectionString?: string };
};
type ContextSourceRouteResult = {
  body: {
    ok: boolean;
    data?: {
      source?: {
        id: string;
        sourceType: string;
        sourceUrl?: string | null;
      };
    };
  };
  scope?: {
    workspaceId: string;
    talkId: string;
  };
};

function scheduleGreenfieldUrlSourceIngestion(
  c: Context,
  auth: AuthContext,
  result: ContextSourceRouteResult,
): void {
  const source = result.body.ok ? result.body.data?.source : undefined;
  if (!source || source.sourceType !== 'url' || !source.sourceUrl) return;
  if (!result.scope) {
    logger.warn(
      { sourceId: source.id },
      'greenfield context URL ingestion skipped: route scope missing',
    );
    return;
  }

  const env = c.env as GreenfieldContextIngestionEnv;
  const connectionString = env.DB?.connectionString;
  if (!connectionString) {
    logger.warn(
      { sourceId: source.id },
      'greenfield context URL ingestion skipped: DB binding missing',
    );
    return;
  }

  const sourceUrl = source.sourceUrl;
  c.executionCtx.waitUntil(
    runGreenfieldUrlSourceIngestion({
      auth,
      connectionString,
      ctx: c.executionCtx,
      env,
      source: { id: source.id, sourceUrl, ...result.scope },
    }),
  );
}

async function runGreenfieldUrlSourceIngestion(input: {
  auth: AuthContext;
  connectionString: string;
  ctx: RequestExecutionContext;
  env: GreenfieldContextIngestionEnv;
  source: {
    id: string;
    sourceUrl: string;
    workspaceId: string;
    talkId: string;
  };
}): Promise<void> {
  try {
    await withRequestScopedDb(
      input.connectionString,
      input.ctx,
      input.env,
      async () => {
        await ingestUrlSource(input.source.id, input.source.sourceUrl, {
          updateExtraction: (updateInput) =>
            withUserContext(input.auth.userId, () =>
              updateGreenfieldContextSourceExtraction({
                ...updateInput,
                workspaceId: input.source.workspaceId,
                talkId: input.source.talkId,
              }),
            ),
        });
      },
    );
  } catch (err) {
    logger.warn(
      { err, sourceId: input.source.id },
      'greenfield context URL ingestion failed',
    );
  }
}

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

    const requestedWorkspace = requestedWorkspaceId(c);
    const currentSession = await getGreenfieldMeRoute({
      auth,
      requestedWorkspaceId: requestedWorkspace,
    });
    if (!currentSession.body.ok) return jsonResponse(currentSession);

    if (displayName !== null) {
      await withUserContext(auth.userId, async () => {
        await updateUserDisplayName({
          userId: auth.userId,
          displayName,
        });
      });
      const updatedSession = await getGreenfieldMeRoute({
        auth,
        requestedWorkspaceId: requestedWorkspace,
      });
      return jsonResponse(updatedSession);
    }

    return jsonResponse(currentSession);
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

  app.post('/api/v1/talks/sidebar/reorder', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ userId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readJsonBody<{
      itemType?: unknown;
      itemId?: unknown;
      destinationFolderId?: unknown;
      destinationIndex?: unknown;
    }>(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await reorderGreenfieldTalkSidebarRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      itemType: payload.data.itemType,
      itemId: payload.data.itemId,
      destinationFolderId: payload.data.destinationFolderId,
      destinationIndex: payload.data.destinationIndex,
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
    const result = await deleteGreenfieldMessagesRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      talkId: talkId.value,
      messageIds: payload.data.messageIds,
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

  app.get('/api/v1/talks/:talkId/runs/:runId/context', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ userId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const talkId = decodeIdParam(c, 'talkId');
    if (!talkId.ok) return talkId.response;
    const runId = decodeIdParam(c, 'runId');
    if (!runId.ok) return runId.response;
    const result = await getGreenfieldRunContextRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      talkId: talkId.value,
      runId: runId.value,
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

  // ── Greenfield context compatibility routes ─────────────────
  app.get('/api/v1/talks/:talkId/context', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await getGreenfieldTalkContextRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      talkId: c.req.param('talkId'),
    });
    return jsonResponse(result);
  });

  app.put('/api/v1/talks/:talkId/context/goal', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readJsonBody<{ goalText?: string }>(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await setGreenfieldTalkGoalRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      talkId: c.req.param('talkId'),
      goalText:
        typeof payload.data.goalText === 'string' ? payload.data.goalText : '',
    });
    return jsonResponse(result);
  });

  app.get('/api/v1/talks/:talkId/context/rules', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await listGreenfieldTalkContextRulesRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      talkId: c.req.param('talkId'),
    });
    return jsonResponse(result);
  });

  app.post('/api/v1/talks/:talkId/context/rules', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readJsonBody<{ ruleText?: string }>(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await createGreenfieldTalkContextRuleRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      talkId: c.req.param('talkId'),
      ruleText:
        typeof payload.data.ruleText === 'string' ? payload.data.ruleText : '',
    });
    return jsonResponse(result);
  });

  app.patch('/api/v1/talks/:talkId/context/rules/:ruleId', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readJsonBody<{
      ruleText?: string;
      isActive?: boolean;
      sortOrder?: number;
    }>(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await patchGreenfieldTalkContextRuleRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      talkId: c.req.param('talkId'),
      ruleId: c.req.param('ruleId'),
      ruleText:
        typeof payload.data.ruleText === 'string'
          ? payload.data.ruleText
          : undefined,
      isActive:
        typeof payload.data.isActive === 'boolean'
          ? payload.data.isActive
          : undefined,
      sortOrder:
        typeof payload.data.sortOrder === 'number'
          ? payload.data.sortOrder
          : undefined,
    });
    return jsonResponse(result);
  });

  app.delete('/api/v1/talks/:talkId/context/rules/:ruleId', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const result = await deleteGreenfieldTalkContextRuleRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      talkId: c.req.param('talkId'),
      ruleId: c.req.param('ruleId'),
    });
    return jsonResponse(result);
  });

  app.get('/api/v1/talks/:talkId/state', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await getGreenfieldTalkStateRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      talkId: c.req.param('talkId'),
    });
    return jsonResponse(result);
  });

  app.delete('/api/v1/talks/:talkId/state/:key', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const result = await deleteGreenfieldTalkStateEntryRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      talkId: c.req.param('talkId'),
      key: c.req.param('key'),
    });
    return jsonResponse(result);
  });

  app.post('/api/v1/talks/:talkId/context/sources', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readJsonBody<{
      sourceType?: string;
      title?: string;
      note?: string | null;
      sourceUrl?: string | null;
      extractedText?: string | null;
    }>(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await createGreenfieldTalkContextSourceRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      talkId: c.req.param('talkId'),
      sourceType:
        typeof payload.data.sourceType === 'string'
          ? payload.data.sourceType
          : '',
      title: typeof payload.data.title === 'string' ? payload.data.title : '',
      note: typeof payload.data.note === 'string' ? payload.data.note : null,
      sourceUrl:
        typeof payload.data.sourceUrl === 'string'
          ? payload.data.sourceUrl
          : null,
      extractedText:
        typeof payload.data.extractedText === 'string'
          ? payload.data.extractedText
          : null,
    });
    scheduleGreenfieldUrlSourceIngestion(c, auth, result);
    return jsonResponse(result);
  });

  app.post('/api/v1/talks/:talkId/context/sources/upload', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const body = await c.req.parseBody();
    const file = body['file'];
    if (!file || !(file instanceof File)) {
      return c.json(
        {
          ok: false,
          error: { code: 'file_required', message: 'A file field is required' },
        },
        400,
      );
    }
    const arrayBuffer = await file.arrayBuffer();
    const title = typeof body['title'] === 'string' ? body['title'] : undefined;
    const result = await uploadGreenfieldTalkContextSourceRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      talkId: c.req.param('talkId'),
      file: {
        name: file.name || 'unnamed',
        data: Buffer.from(arrayBuffer),
        type: file.type || 'application/octet-stream',
      },
      title,
    });
    return jsonResponse(result);
  });

  app.post(
    '/api/v1/talks/:talkId/context/sources/:sourceId/page-images/:index',
    async (c) => {
      const auth = c.get('auth');
      const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
      if (!rl.allowed) return rateLimitedResponse(c, rl);
      const csrfFail = checkCsrf(c, auth);
      if (csrfFail) return csrfFail;
      const arrayBuffer = await c.req.arrayBuffer();
      const result = await uploadGreenfieldTalkContextSourcePageImageRoute({
        auth,
        workspaceId: requestedWorkspaceId(c),
        talkId: c.req.param('talkId'),
        sourceId: c.req.param('sourceId'),
        index: c.req.param('index'),
        total: c.req.query('total'),
        data: Buffer.from(arrayBuffer),
      });
      return jsonResponse(result);
    },
  );

  app.get(
    '/api/v1/talks/:talkId/context/sources/:sourceId/content',
    async (c) => {
      const auth = c.get('auth');
      const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
      if (!rl.allowed) return rateLimitedResponse(c, rl);
      const result = await getGreenfieldTalkContextSourceContentRoute({
        auth,
        workspaceId: requestedWorkspaceId(c),
        talkId: c.req.param('talkId'),
        sourceId: c.req.param('sourceId'),
      });
      if ('headers' in result && result.headers) {
        return new Response(result.body, {
          status: result.statusCode,
          headers: result.headers,
        });
      }
      return jsonResponse(result);
    },
  );

  app.patch('/api/v1/talks/:talkId/context/sources/:sourceId', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readJsonBody<{
      title?: string;
      note?: string | null;
      sortOrder?: number;
      extractedText?: string | null;
    }>(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await patchGreenfieldTalkContextSourceRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      talkId: c.req.param('talkId'),
      sourceId: c.req.param('sourceId'),
      title:
        typeof payload.data.title === 'string' ? payload.data.title : undefined,
      note:
        payload.data.note !== undefined
          ? typeof payload.data.note === 'string'
            ? payload.data.note
            : null
          : undefined,
      sortOrder:
        typeof payload.data.sortOrder === 'number'
          ? payload.data.sortOrder
          : undefined,
      extractedText:
        typeof payload.data.extractedText === 'string'
          ? payload.data.extractedText
          : undefined,
    });
    return jsonResponse(result);
  });

  app.delete('/api/v1/talks/:talkId/context/sources/:sourceId', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const result = await deleteGreenfieldTalkContextSourceRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      talkId: c.req.param('talkId'),
      sourceId: c.req.param('sourceId'),
    });
    return jsonResponse(result);
  });

  app.post(
    '/api/v1/talks/:talkId/context/sources/:sourceId/retry',
    async (c) => {
      const auth = c.get('auth');
      const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
      if (!rl.allowed) return rateLimitedResponse(c, rl);
      const csrfFail = checkCsrf(c, auth);
      if (csrfFail) return csrfFail;
      const result = await retryGreenfieldTalkContextSourceRoute({
        auth,
        workspaceId: requestedWorkspaceId(c),
        talkId: c.req.param('talkId'),
        sourceId: c.req.param('sourceId'),
      });
      scheduleGreenfieldUrlSourceIngestion(c, auth, result);
      return jsonResponse(result);
    },
  );

  // ── Greenfield jobs compatibility routes ─────────────────────
  app.get('/api/v1/talks/:talkId/jobs', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await listGreenfieldTalkJobsRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      talkId: c.req.param('talkId'),
    });
    return jsonResponse(result);
  });

  app.get('/api/v1/talks/:talkId/jobs/:jobId', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await getGreenfieldTalkJobRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      talkId: c.req.param('talkId'),
      jobId: c.req.param('jobId'),
    });
    return jsonResponse(result);
  });

  app.get('/api/v1/talks/:talkId/jobs/:jobId/runs', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const limit = parsePositiveInt(c.req.query('limit'));
    const result = await listGreenfieldTalkJobRunsRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      talkId: c.req.param('talkId'),
      jobId: c.req.param('jobId'),
      limit: limit ?? undefined,
    });
    return jsonResponse(result);
  });

  app.post('/api/v1/talks/:talkId/jobs', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readJsonBody<{
      title?: unknown;
      prompt?: unknown;
      agentId?: unknown;
      targetAgentId?: unknown;
      schedule?: unknown;
      scheduleJson?: unknown;
      timezone?: unknown;
      sourceScope?: unknown;
      sourceScopeJson?: unknown;
      emitTalkMessage?: unknown;
      emitDocumentAppend?: unknown;
      catchUp?: unknown;
    }>(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await createGreenfieldTalkJobRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      talkId: c.req.param('talkId'),
      title: typeof payload.data.title === 'string' ? payload.data.title : '',
      prompt:
        typeof payload.data.prompt === 'string' ? payload.data.prompt : '',
      agentId:
        typeof payload.data.agentId === 'string'
          ? payload.data.agentId
          : undefined,
      targetAgentId:
        typeof payload.data.targetAgentId === 'string'
          ? payload.data.targetAgentId
          : undefined,
      schedule: payload.data.schedule,
      scheduleJson: payload.data.scheduleJson,
      timezone:
        typeof payload.data.timezone === 'string' ? payload.data.timezone : '',
      sourceScope: payload.data.sourceScope,
      sourceScopeJson: payload.data.sourceScopeJson,
      emitTalkMessage:
        typeof payload.data.emitTalkMessage === 'boolean'
          ? payload.data.emitTalkMessage
          : undefined,
      emitDocumentAppend:
        typeof payload.data.emitDocumentAppend === 'boolean'
          ? payload.data.emitDocumentAppend
          : undefined,
      catchUp: payload.data.catchUp,
    });
    return jsonResponse(result);
  });

  app.patch('/api/v1/talks/:talkId/jobs/:jobId', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readJsonBody<{
      title?: unknown;
      prompt?: unknown;
      agentId?: unknown;
      targetAgentId?: unknown;
      schedule?: unknown;
      scheduleJson?: unknown;
      timezone?: unknown;
      sourceScope?: unknown;
      sourceScopeJson?: unknown;
      emitTalkMessage?: unknown;
      emitDocumentAppend?: unknown;
      catchUp?: unknown;
    }>(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await patchGreenfieldTalkJobRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      talkId: c.req.param('talkId'),
      jobId: c.req.param('jobId'),
      title:
        typeof payload.data.title === 'string' ? payload.data.title : undefined,
      prompt:
        typeof payload.data.prompt === 'string'
          ? payload.data.prompt
          : undefined,
      agentId:
        typeof payload.data.agentId === 'string'
          ? payload.data.agentId
          : undefined,
      targetAgentId:
        typeof payload.data.targetAgentId === 'string'
          ? payload.data.targetAgentId
          : undefined,
      schedule: payload.data.schedule,
      scheduleJson: payload.data.scheduleJson,
      timezone:
        typeof payload.data.timezone === 'string'
          ? payload.data.timezone
          : undefined,
      sourceScope: payload.data.sourceScope,
      sourceScopeJson: payload.data.sourceScopeJson,
      emitTalkMessage:
        typeof payload.data.emitTalkMessage === 'boolean'
          ? payload.data.emitTalkMessage
          : undefined,
      emitDocumentAppend:
        typeof payload.data.emitDocumentAppend === 'boolean'
          ? payload.data.emitDocumentAppend
          : undefined,
      catchUp: payload.data.catchUp,
    });
    return jsonResponse(result);
  });

  app.delete('/api/v1/talks/:talkId/jobs/:jobId', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const result = await deleteGreenfieldTalkJobRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      talkId: c.req.param('talkId'),
      jobId: c.req.param('jobId'),
    });
    return jsonResponse(result);
  });

  app.post('/api/v1/talks/:talkId/jobs/:jobId/pause', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const result = await pauseGreenfieldTalkJobRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      talkId: c.req.param('talkId'),
      jobId: c.req.param('jobId'),
    });
    return jsonResponse(result);
  });

  app.post('/api/v1/talks/:talkId/jobs/:jobId/resume', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const result = await resumeGreenfieldTalkJobRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      talkId: c.req.param('talkId'),
      jobId: c.req.param('jobId'),
    });
    return jsonResponse(result);
  });

  app.post('/api/v1/talks/:talkId/jobs/:jobId/run-now', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const result = await runGreenfieldTalkJobNowRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      talkId: c.req.param('talkId'),
      jobId: c.req.param('jobId'),
    });
    if (
      result.statusCode === 202 &&
      result.body.ok &&
      'runId' in result.body.data
    ) {
      await dispatchRun({ runId: result.body.data.runId });
    }
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
      content: parsed.data.content,
      targetAgentIds: parsed.data.targetAgentIds,
      attachmentIds: parsed.data.attachmentIds,
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
