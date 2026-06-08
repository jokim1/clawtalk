// clawtalk Phase 5 PR 2 — Workers Hono app factory.
//
// `getWorkerApp(env)` returns a Hono instance wired with the cloud
// auth surface plus every route handler that has been caller-swapped
// to the postgres + RLS path (Waves 2-3 of the PR 2 cutover).
//
// Public surfaces (no JWT):
//   GET  /api/v1/health             — postgres-backed health probe
//   POST /api/v1/auth/callback      — webapp hands over Supabase
//                                     access+refresh tokens, we set
//                                     eb_at/eb_rt/eb_csrf
//   POST /api/v1/auth/refresh       — eb_rt cookie → fresh trio via
//                                     Supabase /auth/v1/token
//   POST /api/v1/auth/logout        — best-effort Supabase logout +
//                                     always clear cookies
//   GET  /api/v1/content-images/:key — rich-text inline image bytes
//                                     (content-addressed key gates
//                                     access; <img src> needs to load
//                                     without cookies for CDN cache)
//
// Authed surfaces (requireAuthMiddleware verifies eb_at via JWKS in
// Worker mode, or honors CLAWTALK_DEV_STUB_ENABLED in Node mode):
//   /api/v1/_protected/whoami       — JWT sanity probe
//   /api/v1/agents[/...]            — ai-agents.ts (page composite
//                                     + provider credential CRUD)
//   /api/v1/registered-agents[/...] — agent-management.ts (CRUD,
//                                     fallback config, main agent,
//                                     effective tools)
//   /api/v1/talks[/...]             — greenfield-api.ts for the
//                                     greenfield shell/detail/chat/policy/tools
//                                     surface; legacy route modules only for
//                                     not-yet-cut-over collisions
//   /api/v1/talk-folders[/...]      — greenfield-api.ts (folder CRUD)
//   /api/v1/user/tool-permissions   — user-settings.ts
//   /api/v1/talks/:talkId/context[/...] — greenfield-api.ts compatibility
//                                         routes over context_sources
//   /api/v1/talks/:talkId/jobs[/...]    — greenfield-api.ts compatibility
//                                         routes over jobs/runs
//   /api/v1/talks/:talkId/attachments[/...] — unavailable until greenfield
//                                         attachment storage lands
//   /api/v1/talks/:talkId/threads[/...]     — greenfield-api.ts (list +
//                                         create + PATCH + DELETE)
//   /api/v1/documents[/...]                 — native document tabs, blocks,
//                                         and document_edits routes
//   /api/v1/events                  — events-upgrade.ts (user-scope
//                                         WebSocket forwarded to the
//                                         UserEventHub DO)
//   /api/v1/talks/:talkId/events    — events-upgrade.ts (talk-scope WS)
//   /api/v1/talks/:talkId/chat      — greenfield-chat.ts;
//                                         dispatches one queue
//                                         message per run (U2).
//   /api/v1/talks/:talkId/chat/cancel — greenfield-chat.ts;
//                                         cooperative cancel via DB
//                                         status flip — U3 consumer
//                                         polls and bails.
//   /api/v1/home[/...]             — home.ts (read-only Home summary,
//                                     Inbox, recommendations, News)
//
// NOT mounted (chassis-removed; will not return):
//   legacy main/browser route families and legacy connector route families.
//
// The 501 catch-all at the bottom of buildApp() now only fires for
// routes in the not-yet-mounted bucket (above) plus genuinely
// unknown paths.
//
// Connectors refactor PR 1: /api/v1/workspace/channels +
// /api/v1/workspace/data-connectors + /api/v1/talks/:talkId/connectors
// land here on the new workspace-global schema.

import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';

import { isPgDatabaseHealthy } from '../../db.js';
import { authenticateRequestPg } from './middleware/auth.js';
import { authChallengeHeader, extractJwksEnv } from './middleware/auth.js';
import { validateCsrfTokenPg } from './middleware/csrf.js';
import {
  checkRateLimit,
  type RateLimitResult,
} from './middleware/rate-limit.js';
import { handleAuthCallback } from './routes/auth-callback.js';
import { handleAuthLogout } from './routes/auth-logout.js';
import { handleAuthRefresh } from './routes/auth-refresh.js';
import {
  getContentImageHandler,
  postContentImageHandler,
} from './routes/content-images.js';
import {
  talkEventsUpgradeRoute,
  userEventsUpgradeRoute,
} from './routes/events-upgrade.js';
import {
  createAgentRoute,
  deleteAgentRoute,
  dismissAgentModelUpgradeRoute,
  getAgentFallbackRoute,
  getAgentRoute,
  getMainAgentRoute,
  listAgentsRoute as listRegisteredAgentsRoute,
  setAgentFallbackRoute,
  updateAgentRoute,
  updateMainAgentRoute,
} from './routes/agent-management.js';
import {
  getAiAgentsRoute,
  putAiProviderCredentialRoute,
  updateDefaultClaudeModelRoute,
  verifyAiProviderCredentialRoute,
} from './routes/ai-agents.js';
import {
  createWorkspaceChannelRoute,
  createWorkspaceDataConnectorRoute,
  deleteTalkChannelLinkRoute,
  deleteTalkDataConnectorLinkRoute,
  deleteWorkspaceChannelRoute,
  deleteWorkspaceDataConnectorRoute,
  getTalkConnectorsRoute,
  listWorkspaceChannelsRoute,
  listWorkspaceDataConnectorsRoute,
  setTalkChannelLinkRoute,
  setTalkDataConnectorLinkRoute,
  setWorkspaceChannelCredentialRoute,
  setWorkspaceDataConnectorCredentialRoute,
  updateWorkspaceChannelRoute,
  updateWorkspaceDataConnectorRoute,
} from './routes/connectors.js';
import {
  completeAnthropicOauthRoute,
  initiateAnthropicOauthRoute,
  initiateOpenAiCodexOauthRoute,
  pollOpenAiCodexOauthRoute,
} from './routes/agent-oauth.js';
import { mountGreenfieldApiRoutes } from './routes/greenfield-api.js';
import { mountHomeRoutes } from './routes/home.js';
import { mountDocumentRoutes } from './routes/documents.js';
import {
  deleteWebSearchCredentialRoute,
  listWebSearchProvidersRoute,
  putWebSearchActiveProviderRoute,
  putWebSearchCredentialRoute,
} from './routes/web-search.js';
import {
  disconnectGoogleAccountRoute,
  expandScopesRoute,
  getGooglePickerTokenRoute,
  getUserGoogleAccountRoute,
  handleGoogleCallback,
  startConnectRoute,
} from './routes/google-account.js';
import {
  deleteWorkspaceSlackInstallRoute,
  handleSlackCallback,
  listWorkspaceSlackInstallsRoute,
  startSlackInstallRoute,
} from './routes/slack-installs.js';
import {
  bulkAddSlackChannelsRoute,
  listSlackInstallChannelsRoute,
} from './routes/slack-channels.js';
import {
  createTalkGoogleDriveResourceRoute,
  deleteTalkResourceRoute,
  listTalkResourcesRoute,
} from './routes/talk-resources.js';
import {
  getEffectiveToolsRoute,
  listUserToolPermissionsRoute,
  updateUserToolPermissionRoute,
} from './routes/user-settings.js';
import { AuthContext } from './types.js';

export interface WorkerAppEnv {
  SUPABASE_PROJECT_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  JWKS_CACHE?: unknown;
}

// Hono variables we carry on Context. The auth middleware writes
// `auth` after a successful JWT verification; downstream handlers
// read it via `c.get('auth')`.
type Variables = {
  auth: AuthContext;
};

let cachedApp: Hono<{ Variables: Variables }> | null = null;

/**
 * Lazy-init the Hono app once per isolate. Workers cold-boot for
 * each isolate, but reused across requests, so amortizing the
 * Hono router construction across the isolate's lifetime is the
 * right shape — matches editorialroom's `getWorkerApp()`.
 */
export function getWorkerApp(): Hono<{ Variables: Variables }> {
  if (cachedApp) return cachedApp;
  cachedApp = buildApp();
  return cachedApp;
}

/** Test-only: drop the cached app so a fresh build can pick up
 * test-time module changes. */
export function _resetWorkerAppForTests(): void {
  cachedApp = null;
}

function buildApp(): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();

  // ── Debug: surface the actual error before Hono converts to 500
  app.onError((err, c) => {
    const description: Record<string, unknown> = {
      path: c.req.path,
      method: c.req.method,
    };
    if (err && typeof err === 'object') {
      for (const key of Object.getOwnPropertyNames(err)) {
        const v = (err as unknown as Record<string, unknown>)[key];
        description[key] =
          typeof v === 'string' || typeof v === 'number' ? v : String(v);
      }
      if (err instanceof Error) {
        description.name = err.name;
        description.message = err.message;
        description.stack = err.stack?.split('\n').slice(0, 8).join(' | ');
      }
    } else {
      description.value = String(err);
    }
    console.error('[hono.onError]', JSON.stringify(description));
    return c.json(
      {
        ok: false,
        error: {
          code: 'internal_error',
          message: err instanceof Error ? err.message : 'Request failed',
        },
      },
      500,
    );
  });

  // ── Public surfaces ──────────────────────────────────────────
  app.get('/api/v1/health', handleHealth);
  app.post('/api/v1/auth/callback', handleAuthCallback);
  app.post('/api/v1/auth/refresh', handleAuthRefresh);
  app.post('/api/v1/auth/logout', handleAuthLogout);
  // /auth/config is a feature-flag probe the webapp reads on boot to
  // decide whether to show the device-code path alongside Google
  // OAuth. Returns the same shape the Node entry returned.
  app.get('/api/v1/auth/config', (c) =>
    c.json({ ok: true, data: { devMode: false } }),
  );
  // Content-images GET is public — the 128-bit content-addressed key
  // gates access; browsers need to load <img src> without cookies for
  // the CDN cache to work. POST is auth-gated per-route below.
  app.get('/api/v1/content-images/:key', getContentImageHandler);
  app.post(
    '/api/v1/content-images',
    requireAuthMiddleware,
    postContentImageHandler,
  );

  // ── Auth gate for every cloud-ready surface ──────────────────
  // Hono's `app.use(path, mw)` only matches the literal `path`
  // when path is a glob — `/api/v1/agents/*` matches sub-paths
  // but NOT bare `/api/v1/agents`. Register both shapes per
  // namespace so the bare collection endpoints (e.g. GET
  // /api/v1/agents → ai-agents page composite) are gated too.
  app.use('/api/v1/_protected/*', requireAuthMiddleware);
  app.use('/api/v1/agents', requireAuthMiddleware);
  app.use('/api/v1/agents/*', requireAuthMiddleware);
  app.use('/api/v1/registered-agents', requireAuthMiddleware);
  app.use('/api/v1/registered-agents/*', requireAuthMiddleware);
  app.use('/api/v1/web-search', requireAuthMiddleware);
  app.use('/api/v1/web-search/*', requireAuthMiddleware);
  app.use('/api/v1/workspaces', requireAuthMiddleware);
  app.use('/api/v1/workspaces/*', requireAuthMiddleware);
  app.use('/api/v1/folders', requireAuthMiddleware);
  app.use('/api/v1/folders/*', requireAuthMiddleware);
  app.use('/api/v1/workspace/*', requireAuthMiddleware);
  app.use('/api/v1/teams', requireAuthMiddleware);
  app.use('/api/v1/talks', requireAuthMiddleware);
  app.use('/api/v1/talks/*', requireAuthMiddleware);
  app.use('/api/v1/threads/*', requireAuthMiddleware);
  app.use('/api/v1/talk-folders', requireAuthMiddleware);
  app.use('/api/v1/talk-folders/*', requireAuthMiddleware);
  app.use('/api/v1/user/*', requireAuthMiddleware);
  app.use('/api/v1/session/*', requireAuthMiddleware);
  // C1: gate /api/v1/me/* (Google account routes). The callback at
  // /api/v1/auth/google/callback stays public — Google redirects there
  // directly with no auth cookies of its own.
  app.use('/api/v1/me', requireAuthMiddleware);
  app.use('/api/v1/me/*', requireAuthMiddleware);
  app.use('/api/v1/events', requireAuthMiddleware);

  // ── Sanity probe for the auth middleware ─────────────────────
  app.get('/api/v1/_protected/whoami', (c) => {
    const auth = c.get('auth');
    return c.json({
      ok: true,
      data: {
        userId: auth.userId,
        sessionId: auth.sessionId,
        role: auth.role,
        authType: auth.authType,
      },
    });
  });

  mountGreenfieldApiRoutes(app);
  mountHomeRoutes(app, requireAuthMiddleware);
  mountDocumentRoutes(app, requireAuthMiddleware);

  // ── ai-agents.ts: page composite + provider credentials ──────
  app.get('/api/v1/agents', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await getAiAgentsRoute(auth, requestedWorkspaceId(c));
    return jsonResponse(result);
  });

  app.put('/api/v1/agents/default-claude', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const body = await c.req.json().catch(() => ({}));
    const result = await updateDefaultClaudeModelRoute(
      auth,
      body,
      requestedWorkspaceId(c),
    );
    return jsonResponse(result);
  });

  app.put('/api/v1/agents/providers/:providerId', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const body = await c.req.json().catch(() => ({}));
    const result = await putAiProviderCredentialRoute(
      auth,
      c.req.param('providerId'),
      body,
      requestedWorkspaceId(c),
    );
    return jsonResponse(result);
  });

  app.post('/api/v1/agents/providers/:providerId/verify', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const scope = c.req.query('scope') === 'workspace' ? 'workspace' : 'user';
    const result = await verifyAiProviderCredentialRoute(
      auth,
      c.req.param('providerId'),
      scope,
      requestedWorkspaceId(c),
    );
    return jsonResponse(result);
  });

  // ── Workspace channels (admin-managed pool, talk picker reads) ──
  app.get('/api/v1/workspace/channels', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await listWorkspaceChannelsRoute(
      auth,
      requestedWorkspaceId(c),
    );
    return jsonResponse(result);
  });

  app.post('/api/v1/workspace/channels', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readJsonBody(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await createWorkspaceChannelRoute({
      auth,
      requestedWorkspaceId: requestedWorkspaceId(c),
      body: payload.data as any,
    });
    return jsonResponse(result);
  });

  app.patch('/api/v1/workspace/channels/:channelId', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readJsonBody(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await updateWorkspaceChannelRoute({
      auth,
      requestedWorkspaceId: requestedWorkspaceId(c),
      channelId: c.req.param('channelId'),
      body: payload.data as any,
    });
    return jsonResponse(result);
  });

  app.delete('/api/v1/workspace/channels/:channelId', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const result = await deleteWorkspaceChannelRoute({
      auth,
      requestedWorkspaceId: requestedWorkspaceId(c),
      channelId: c.req.param('channelId'),
    });
    return jsonResponse(result);
  });

  app.put('/api/v1/workspace/channels/:channelId/credential', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readJsonBody(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await setWorkspaceChannelCredentialRoute({
      auth,
      requestedWorkspaceId: requestedWorkspaceId(c),
      channelId: c.req.param('channelId'),
      body: payload.data as any,
    });
    return jsonResponse(result);
  });

  // ── Workspace data connectors ───────────────────────────────────
  app.get('/api/v1/workspace/data-connectors', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await listWorkspaceDataConnectorsRoute(
      auth,
      requestedWorkspaceId(c),
    );
    return jsonResponse(result);
  });

  app.post('/api/v1/workspace/data-connectors', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readJsonBody(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await createWorkspaceDataConnectorRoute({
      auth,
      requestedWorkspaceId: requestedWorkspaceId(c),
      body: payload.data as any,
    });
    return jsonResponse(result);
  });

  app.patch('/api/v1/workspace/data-connectors/:connectorId', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readJsonBody(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await updateWorkspaceDataConnectorRoute({
      auth,
      requestedWorkspaceId: requestedWorkspaceId(c),
      connectorId: c.req.param('connectorId'),
      body: payload.data as any,
    });
    return jsonResponse(result);
  });

  app.delete('/api/v1/workspace/data-connectors/:connectorId', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const result = await deleteWorkspaceDataConnectorRoute({
      auth,
      requestedWorkspaceId: requestedWorkspaceId(c),
      connectorId: c.req.param('connectorId'),
    });
    return jsonResponse(result);
  });

  app.put(
    '/api/v1/workspace/data-connectors/:connectorId/credential',
    async (c) => {
      const auth = c.get('auth');
      const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
      if (!rl.allowed) return rateLimitedResponse(c, rl);
      const csrfFail = checkCsrf(c, auth);
      if (csrfFail) return csrfFail;
      const payload = await readJsonBody(c);
      if (!payload.ok) return invalidJsonResponse(c, payload.error);
      const result = await setWorkspaceDataConnectorCredentialRoute({
        auth,
        requestedWorkspaceId: requestedWorkspaceId(c),
        connectorId: c.req.param('connectorId'),
        body: payload.data as any,
      });
      return jsonResponse(result);
    },
  );

  // ── Per-Talk connector picker + toggles ─────────────────────────
  app.get('/api/v1/talks/:talkId/connectors', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await getTalkConnectorsRoute({
      auth,
      talkId: c.req.param('talkId'),
    });
    return jsonResponse(result);
  });

  app.put('/api/v1/talks/:talkId/connectors/channels/:channelId', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const result = await setTalkChannelLinkRoute({
      auth,
      talkId: c.req.param('talkId'),
      channelId: c.req.param('channelId'),
    });
    return jsonResponse(result);
  });

  app.delete(
    '/api/v1/talks/:talkId/connectors/channels/:channelId',
    async (c) => {
      const auth = c.get('auth');
      const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
      if (!rl.allowed) return rateLimitedResponse(c, rl);
      const csrfFail = checkCsrf(c, auth);
      if (csrfFail) return csrfFail;
      const result = await deleteTalkChannelLinkRoute({
        auth,
        talkId: c.req.param('talkId'),
        channelId: c.req.param('channelId'),
      });
      return jsonResponse(result);
    },
  );

  app.put(
    '/api/v1/talks/:talkId/connectors/data-connectors/:connectorId',
    async (c) => {
      const auth = c.get('auth');
      const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
      if (!rl.allowed) return rateLimitedResponse(c, rl);
      const csrfFail = checkCsrf(c, auth);
      if (csrfFail) return csrfFail;
      const result = await setTalkDataConnectorLinkRoute({
        auth,
        talkId: c.req.param('talkId'),
        connectorId: c.req.param('connectorId'),
      });
      return jsonResponse(result);
    },
  );

  app.delete(
    '/api/v1/talks/:talkId/connectors/data-connectors/:connectorId',
    async (c) => {
      const auth = c.get('auth');
      const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
      if (!rl.allowed) return rateLimitedResponse(c, rl);
      const csrfFail = checkCsrf(c, auth);
      if (csrfFail) return csrfFail;
      const result = await deleteTalkDataConnectorLinkRoute({
        auth,
        talkId: c.req.param('talkId'),
        connectorId: c.req.param('connectorId'),
      });
      return jsonResponse(result);
    },
  );

  // ── Web search providers (per-user keys + active picker) ─────
  app.get('/api/v1/web-search/providers', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await listWebSearchProvidersRoute(auth);
    return jsonResponse(result);
  });

  app.put('/api/v1/web-search/providers/:providerId', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const body = await c.req.json().catch(() => ({}));
    const result = await putWebSearchCredentialRoute(
      auth,
      c.req.param('providerId'),
      body,
    );
    return jsonResponse(result);
  });

  app.delete('/api/v1/web-search/providers/:providerId', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const result = await deleteWebSearchCredentialRoute(
      auth,
      c.req.param('providerId'),
    );
    return jsonResponse(result);
  });

  app.put('/api/v1/web-search/active', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const body = await c.req.json().catch(() => ({}));
    const result = await putWebSearchActiveProviderRoute(auth, body);
    return jsonResponse(result);
  });

  // ── Google account OAuth (PR1: tool-scope OAuth flow) ────────
  app.get('/api/v1/me/google-account', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await getUserGoogleAccountRoute(
      auth,
      requestedWorkspaceId(c),
    );
    return jsonResponse(result);
  });

  app.post('/api/v1/me/google-account/connect', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({
      principalId: auth.userId,
      bucket: 'auth_start',
    });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const body = await c.req.json().catch(() => ({}));
    const result = await startConnectRoute(auth, body, requestedWorkspaceId(c));
    return jsonResponse(result);
  });

  app.post('/api/v1/me/google-account/expand-scopes', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({
      principalId: auth.userId,
      bucket: 'auth_start',
    });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const body = await c.req.json().catch(() => ({}));
    const result = await expandScopesRoute(auth, body, requestedWorkspaceId(c));
    return jsonResponse(result);
  });

  app.post('/api/v1/me/google-account/disconnect', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const result = await disconnectGoogleAccountRoute(
      auth,
      requestedWorkspaceId(c),
    );
    return jsonResponse(result);
  });

  // PR2 Lane C: picker token mint. Drives the Google Picker SDK launch in
  // the Talk Tools sub-tab. Read-limited because every picker open hits
  // this endpoint; the underlying refresh dedup (D1) absorbs bursts.
  app.get('/api/v1/me/google-account/picker-token', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await getGooglePickerTokenRoute(
      auth,
      requestedWorkspaceId(c),
      c.req.query('talkId') ?? null,
    );
    return jsonResponse(result);
  });

  // ── Slack workspace installs (admin-managed OAuth) ───────────
  app.get('/api/v1/workspace/connectors/slack/installs', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await listWorkspaceSlackInstallsRoute(
      auth,
      requestedWorkspaceId(c),
    );
    return jsonResponse(result);
  });

  app.post('/api/v1/workspace/connectors/slack/installs/connect', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({
      principalId: auth.userId,
      bucket: 'auth_start',
    });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const body = await c.req.json().catch(() => ({}));
    const result = await startSlackInstallRoute(
      auth,
      body,
      requestedWorkspaceId(c),
    );
    return jsonResponse(result);
  });

  app.delete(
    '/api/v1/workspace/connectors/slack/installs/:teamId',
    async (c) => {
      const auth = c.get('auth');
      const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
      if (!rl.allowed) return rateLimitedResponse(c, rl);
      const csrfFail = checkCsrf(c, auth);
      if (csrfFail) return csrfFail;
      const result = await deleteWorkspaceSlackInstallRoute({
        auth,
        teamId: c.req.param('teamId'),
        requestedWorkspaceId: requestedWorkspaceId(c),
      });
      return jsonResponse(result);
    },
  );

  // ── Slack channel picker (PR 2) ─────────────────────────────────
  app.get(
    '/api/v1/workspace/connectors/slack/installs/:teamId/channels',
    async (c) => {
      const auth = c.get('auth');
      const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
      if (!rl.allowed) return rateLimitedResponse(c, rl);
      const result = await listSlackInstallChannelsRoute({
        auth,
        teamId: c.req.param('teamId'),
        requestedWorkspaceId: requestedWorkspaceId(c),
      });
      return jsonResponse(result);
    },
  );

  app.post(
    '/api/v1/workspace/connectors/slack/installs/:teamId/channels',
    async (c) => {
      const auth = c.get('auth');
      const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
      if (!rl.allowed) return rateLimitedResponse(c, rl);
      const csrfFail = checkCsrf(c, auth);
      if (csrfFail) return csrfFail;
      const body = await c.req.json().catch(() => ({}));
      const result = await bulkAddSlackChannelsRoute({
        auth,
        teamId: c.req.param('teamId'),
        body,
        requestedWorkspaceId: requestedWorkspaceId(c),
      });
      return jsonResponse(result);
    },
  );

  // Public callback — no auth middleware. IP-keyed rate limit.
  app.get('/api/v1/auth/slack/callback', async (c) => {
    const ip =
      c.req.header('cf-connecting-ip') ||
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
      'anonymous';
    const rl = checkRateLimit({
      principalId: `ip:${ip}`,
      bucket: 'auth_callback',
    });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const url = new URL(c.req.url);
    const result = await handleSlackCallback({
      state: url.searchParams.get('state'),
      code: url.searchParams.get('code'),
      error: url.searchParams.get('error'),
    });
    return new Response(result.html, {
      status: result.statusCode,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  });

  // Public callback — no auth middleware. C9: IP-keyed rate limit.
  app.get('/api/v1/auth/google/callback', async (c) => {
    const ip =
      c.req.header('cf-connecting-ip') ||
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
      'anonymous';
    const rl = checkRateLimit({
      principalId: `ip:${ip}`,
      bucket: 'auth_callback',
    });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const url = new URL(c.req.url);
    const result = await handleGoogleCallback({
      state: url.searchParams.get('state'),
      code: url.searchParams.get('code'),
      error: url.searchParams.get('error'),
    });
    return new Response(result.html, {
      status: result.statusCode,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        // popup origin must match opener to allow postMessage
      },
    });
  });

  // ── OAuth subscription flows ─────────────────────────────────
  app.post(
    '/api/v1/agents/providers/provider.anthropic/oauth/initiate',
    async (c) => {
      const auth = c.get('auth');
      const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
      if (!rl.allowed) return rateLimitedResponse(c, rl);
      const csrfFail = checkCsrf(c, auth);
      if (csrfFail) return csrfFail;
      const body = await c.req.json().catch(() => ({}));
      const result = await initiateAnthropicOauthRoute(auth, body);
      return jsonResponse(result);
    },
  );

  app.post(
    '/api/v1/agents/providers/provider.anthropic/oauth/complete',
    async (c) => {
      const auth = c.get('auth');
      const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
      if (!rl.allowed) return rateLimitedResponse(c, rl);
      const csrfFail = checkCsrf(c, auth);
      if (csrfFail) return csrfFail;
      const body = await c.req.json().catch(() => ({}));
      const result = await completeAnthropicOauthRoute(auth, body);
      return jsonResponse(result);
    },
  );

  app.post(
    '/api/v1/agents/providers/provider.openai_codex/oauth/initiate',
    async (c) => {
      const auth = c.get('auth');
      const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
      if (!rl.allowed) return rateLimitedResponse(c, rl);
      const csrfFail = checkCsrf(c, auth);
      if (csrfFail) return csrfFail;
      const body = await c.req.json().catch(() => ({}));
      const result = await initiateOpenAiCodexOauthRoute(auth, body);
      return jsonResponse(result);
    },
  );

  app.post(
    '/api/v1/agents/providers/provider.openai_codex/oauth/poll',
    async (c) => {
      const auth = c.get('auth');
      const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
      if (!rl.allowed) return rateLimitedResponse(c, rl);
      const csrfFail = checkCsrf(c, auth);
      if (csrfFail) return csrfFail;
      const body = await c.req.json().catch(() => ({}));
      const result = await pollOpenAiCodexOauthRoute(auth, body);
      return jsonResponse(result);
    },
  );

  // ── agent-management.ts: registered-agents CRUD ──────────────
  app.get('/api/v1/registered-agents', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await listRegisteredAgentsRoute(
      auth,
      requestedWorkspaceId(c),
    );
    return jsonResponse(result);
  });

  app.get('/api/v1/registered-agents/main', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await getMainAgentRoute(auth, requestedWorkspaceId(c));
    return jsonResponse(result);
  });

  app.put('/api/v1/registered-agents/main', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const body = await c.req.json().catch(() => null);
    const result = await updateMainAgentRoute(
      auth,
      body,
      requestedWorkspaceId(c),
    );
    return jsonResponse(result);
  });

  app.get('/api/v1/registered-agents/:agentId', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await getAgentRoute(
      auth,
      c.req.param('agentId'),
      requestedWorkspaceId(c),
    );
    return jsonResponse(result);
  });

  app.post('/api/v1/registered-agents', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readJsonBody(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await createAgentRoute(
      auth,
      payload.data as any,
      requestedWorkspaceId(c),
    );
    return jsonResponse(result);
  });

  app.put('/api/v1/registered-agents/:agentId', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readJsonBody(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await updateAgentRoute(
      auth,
      c.req.param('agentId'),
      payload.data as any,
      requestedWorkspaceId(c),
    );
    return jsonResponse(result);
  });

  app.delete('/api/v1/registered-agents/:agentId', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const result = await deleteAgentRoute(
      auth,
      c.req.param('agentId'),
      requestedWorkspaceId(c),
    );
    return jsonResponse(result);
  });

  app.post(
    '/api/v1/registered-agents/:agentId/dismiss-model-upgrade',
    async (c) => {
      const auth = c.get('auth');
      const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
      if (!rl.allowed) return rateLimitedResponse(c, rl);
      const csrfFail = checkCsrf(c, auth);
      if (csrfFail) return csrfFail;
      const result = await dismissAgentModelUpgradeRoute(
        auth,
        c.req.param('agentId'),
        requestedWorkspaceId(c),
      );
      return jsonResponse(result);
    },
  );

  app.get('/api/v1/registered-agents/:agentId/fallback', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await getAgentFallbackRoute(
      auth,
      c.req.param('agentId'),
      requestedWorkspaceId(c),
    );
    return jsonResponse(result);
  });

  app.put('/api/v1/registered-agents/:agentId/fallback', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readJsonBody(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await setAgentFallbackRoute(
      auth,
      c.req.param('agentId'),
      payload.data as any,
      requestedWorkspaceId(c),
    );
    return jsonResponse(result);
  });

  // ── user-settings.ts: tool permissions + effective-tools ─────
  app.get('/api/v1/registered-agents/:agentId/effective-tools', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await getEffectiveToolsRoute(auth, c.req.param('agentId'));
    return jsonResponse(result);
  });

  app.get('/api/v1/user/tool-permissions', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await listUserToolPermissionsRoute(auth);
    return jsonResponse(result);
  });

  app.put('/api/v1/user/tool-permissions', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readJsonBody(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await updateUserToolPermissionRoute(
      auth,
      payload.data as any,
    );
    return jsonResponse(result);
  });

  // ── talk-resources.ts: bound Drive/Doc resources for a Talk (PR2 Lane C)
  // C3 — edit-permission gate lives inside the route handlers; the auth
  // + rate-limit + CSRF wiring here is structurally identical to the
  // context/sources block above.
  app.get('/api/v1/talks/:talkId/resources', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await listTalkResourcesRoute({
      auth,
      talkId: c.req.param('talkId'),
    });
    return jsonResponse(result);
  });

  app.post('/api/v1/talks/:talkId/resources', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readJsonBody<{
      kind?: unknown;
      externalId?: unknown;
      displayName?: unknown;
      metadata?: unknown;
    }>(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await createTalkGoogleDriveResourceRoute({
      auth,
      talkId: c.req.param('talkId'),
      body: payload.data,
    });
    return jsonResponse(result);
  });

  app.delete('/api/v1/talks/:talkId/resources/:resourceId', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const result = await deleteTalkResourceRoute({
      auth,
      talkId: c.req.param('talkId'),
      resourceId: c.req.param('resourceId'),
    });
    return jsonResponse(result);
  });

  // ── events-upgrade.ts: WebSocket Hibernation routes forwarded
  // to the UserEventHub Durable Object. G9 clone-and-mutate from
  // c.req.raw preserves Sec-WebSocket-* handshake headers.
  app.get('/api/v1/events', userEventsUpgradeRoute);
  app.get('/api/v1/talks/:talkId/events', talkEventsUpgradeRoute);

  // ── greenfield attachment compatibility guard ────────────────
  app.post('/api/v1/talks/:talkId/attachments', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    return attachmentsUnavailableResponse(c);
  });

  app.get('/api/v1/talks/:talkId/attachments', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    return attachmentsUnavailableResponse(c);
  });

  app.get(
    '/api/v1/talks/:talkId/attachments/:attachmentId/content',
    async (c) => {
      const auth = c.get('auth');
      const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
      if (!rl.allowed) return rateLimitedResponse(c, rl);
      return attachmentsUnavailableResponse(c);
    },
  );

  app.delete('/api/v1/talks/:talkId/attachments/:attachmentId', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    return attachmentsUnavailableResponse(c);
  });

  // 501 fallback for any /api/v1/* path that hasn't been mounted.
  // Routes still on sqlite, chassis-removed, or pending Queues
  // wiring (chat enqueue / SSE) all land here.
  app.all('/api/v1/*', (c) =>
    c.json(
      {
        ok: false,
        error: {
          code: 'not_implemented_in_worker',
          message:
            'This route is not yet wired through the Worker entry. PR 2 caller-swap is in progress.',
        },
      },
      501,
    ),
  );

  return app;
}

async function handleHealth(c: Context): Promise<Response> {
  const dbHealthy = await isPgDatabaseHealthy().catch(() => false);
  return c.json({
    ok: true,
    data: {
      status: 'ok',
      db: dbHealthy,
      runtime: 'workers',
    },
  });
}

/**
 * Hono middleware that verifies the eb_at cookie via Supabase JWKS
 * and attaches the resolved AuthContext to the request. Worker mode
 * (env has JWKS_CACHE + SUPABASE_PROJECT_URL) verifies cryptograph-
 * ically; Node mode (vitest, tsx local) falls back to the
 * CLAWTALK_DEV_STUB_ENABLED gate.
 */
const requireAuthMiddleware: MiddlewareHandler<{
  Variables: Variables;
}> = async (c, next) => {
  const env = extractJwksEnv(c.env);
  const result = await authenticateRequestPg(
    {
      authorization: c.req.header('authorization'),
      cookie: c.req.header('cookie'),
    },
    env,
  );
  if (result.kind !== 'authenticated') {
    return new Response(
      JSON.stringify({
        ok: false,
        error: {
          code: 'unauthorized',
          message: 'Authentication is required',
        },
      }),
      {
        status: 401,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'www-authenticate': authChallengeHeader(result.reason),
        },
      },
    );
  }
  c.set('auth', result.auth);
  await next();
};

// ── shared helpers ──────────────────────────────────────────────

/** Translate a route handler envelope into an HTTP response. */
function jsonResponse(result: { statusCode: number; body: unknown }): Response {
  return new Response(JSON.stringify(result.body), {
    status: result.statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8' },
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

/** Returns a 403 csrf_failed response if validation fails, else null. */
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

function attachmentsUnavailableResponse(c: Context): Response {
  return c.json(
    {
      ok: false,
      error: {
        code: 'attachments_not_available',
        message:
          'Message attachments are not available on the greenfield chat route yet.',
      },
    },
    501,
  );
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
