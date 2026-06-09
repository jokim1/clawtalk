import type { Context, Hono, MiddlewareHandler } from 'hono';

import { withUserContext } from '../../../db.js';
import {
  addHomeNewsToContext,
  dismissHomeInboxItem,
  dismissHomeRecommendation,
  getHomeSummary,
  listHomeInboxItems,
  listHomeNews,
  listHomeRecommendations,
  markHomeInboxItemRead,
  markHomeNewsNotRelevant,
  resolveHomeInboxItem,
  snoozeHomeInboxItem,
  type HomeInboxMutationResult,
  type HomeInboxPayload,
  type HomeNewsMutationResult,
  type HomeNewsPayload,
  type HomeRecommendationMutationResult,
  type HomeRecommendationsPayload,
  type HomeSummaryPayload,
} from '../../db/home-accessors.js';
import {
  resolveWorkspaceForUser,
  type WorkspaceSummaryRecord,
} from '../../workspaces/accessors.js';
import { validateCsrfTokenPg } from '../middleware/csrf.js';
import {
  checkRateLimit,
  type RateLimitResult,
} from '../middleware/rate-limit.js';
import type { ApiEnvelope, AuthContext } from '../types.js';

/** Upper bound on how far ahead an Inbox item may be snoozed (one year). */
const MAX_SNOOZE_MS = 365 * 24 * 60 * 60 * 1000;

type RouteResult<T> = {
  statusCode: number;
  body: ApiEnvelope<T>;
};

type HomeApp = Hono<{ Variables: { auth: AuthContext } }>;
type HomeAuthMiddleware = MiddlewareHandler<{
  Variables: { auth: AuthContext };
}>;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ok<T>(data: T): RouteResult<T> {
  return { statusCode: 200, body: { ok: true, data } };
}

function error(
  statusCode: number,
  code: string,
  message: string,
): RouteResult<never> {
  return { statusCode, body: { ok: false, error: { code, message } } };
}

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function requireHomeWriter(
  workspace: WorkspaceSummaryRecord,
): RouteResult<never> | null {
  if (workspace.role !== 'guest') return null;
  return error(
    403,
    'workspace_writer_required',
    'Workspace write access is required.',
  );
}

function parseLimit(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCursor(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Validate a snooze `until` payload: an ISO-8601 timestamp strictly in the
 * future and within one year. Returns the normalized ISO string or a reason.
 */
function parseSnoozeUntil(
  value: unknown,
): { ok: true; iso: string } | { ok: false; message: string } {
  if (typeof value !== 'string' || value.trim() === '') {
    return { ok: false, message: 'A snooze "until" timestamp is required.' };
  }
  // Require a real ISO-8601 datetime (date + time), not any loose string that
  // `Date.parse` happens to accept (date-only, locale formats, etc.).
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value.trim())) {
    return {
      ok: false,
      message: 'Snooze "until" must be an ISO-8601 timestamp.',
    };
  }
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) {
    return {
      ok: false,
      message: 'Snooze "until" must be an ISO-8601 timestamp.',
    };
  }
  const now = Date.now();
  if (ts <= now) {
    return { ok: false, message: 'Snooze "until" must be in the future.' };
  }
  if (ts > now + MAX_SNOOZE_MS) {
    return { ok: false, message: 'Snooze "until" must be within one year.' };
  }
  return { ok: true, iso: new Date(ts).toISOString() };
}

async function withHomeWorkspace<T>(
  input: {
    auth: AuthContext;
    workspaceId?: string | null;
  },
  fn: (ctx: { workspace: WorkspaceSummaryRecord }) => Promise<RouteResult<T>>,
): Promise<RouteResult<T>> {
  if (input.workspaceId && !isUuid(input.workspaceId)) {
    return error(400, 'invalid_workspace_id', 'Workspace id must be a UUID.');
  }

  return withUserContext(input.auth.userId, async () => {
    const workspace = await resolveWorkspaceForUser({
      userId: input.auth.userId,
      requestedWorkspaceId: input.workspaceId,
    });
    if (!workspace) {
      return error(
        input.workspaceId ? 403 : 404,
        input.workspaceId ? 'workspace_forbidden' : 'workspace_not_found',
        input.workspaceId
          ? 'Workspace is not available to this user.'
          : 'No workspace exists for this user.',
      );
    }
    return fn({ workspace });
  });
}

export async function getHomeSummaryRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
}): Promise<RouteResult<HomeSummaryPayload>> {
  return withHomeWorkspace(input, async ({ workspace }) =>
    ok(await getHomeSummary({ workspaceId: workspace.id })),
  );
}

export async function listHomeInboxRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  limit?: unknown;
  cursor?: unknown;
}): Promise<RouteResult<HomeInboxPayload>> {
  return withHomeWorkspace(input, async ({ workspace }) =>
    ok(
      await listHomeInboxItems({
        workspaceId: workspace.id,
        limit: parseLimit(input.limit),
        cursor: parseCursor(input.cursor),
      }),
    ),
  );
}

export async function listHomeRecommendationsRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  limit?: unknown;
}): Promise<RouteResult<HomeRecommendationsPayload>> {
  return withHomeWorkspace(input, async ({ workspace }) =>
    ok(
      await listHomeRecommendations({
        workspaceId: workspace.id,
        limit: parseLimit(input.limit),
      }),
    ),
  );
}

export async function listHomeNewsRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  limit?: unknown;
  cursor?: unknown;
}): Promise<RouteResult<HomeNewsPayload>> {
  return withHomeWorkspace(input, async ({ workspace }) =>
    ok(
      await listHomeNews({
        workspaceId: workspace.id,
        limit: parseLimit(input.limit),
        cursor: parseCursor(input.cursor),
      }),
    ),
  );
}

export async function dismissHomeInboxRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  itemId: string;
}): Promise<RouteResult<HomeInboxMutationResult>> {
  if (!isUuid(input.itemId)) {
    return error(400, 'invalid_item_id', 'Inbox item id must be a UUID.');
  }
  return withHomeWorkspace(input, async ({ workspace }) => {
    const writerError = requireHomeWriter(workspace);
    if (writerError) return writerError;
    const result = await dismissHomeInboxItem({
      workspaceId: workspace.id,
      itemId: input.itemId,
    });
    if (!result) return error(404, 'not_found', 'Inbox item not found.');
    return ok(result);
  });
}

export async function markHomeInboxReadRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  itemId: string;
}): Promise<RouteResult<HomeInboxMutationResult>> {
  if (!isUuid(input.itemId)) {
    return error(400, 'invalid_item_id', 'Inbox item id must be a UUID.');
  }
  return withHomeWorkspace(input, async ({ workspace }) => {
    const writerError = requireHomeWriter(workspace);
    if (writerError) return writerError;
    const result = await markHomeInboxItemRead({
      workspaceId: workspace.id,
      itemId: input.itemId,
    });
    if (!result) return error(404, 'not_found', 'Inbox item not found.');
    return ok(result);
  });
}

export async function resolveHomeInboxRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  itemId: string;
}): Promise<RouteResult<HomeInboxMutationResult>> {
  if (!isUuid(input.itemId)) {
    return error(400, 'invalid_item_id', 'Inbox item id must be a UUID.');
  }
  return withHomeWorkspace(input, async ({ workspace }) => {
    const writerError = requireHomeWriter(workspace);
    if (writerError) return writerError;
    const result = await resolveHomeInboxItem({
      workspaceId: workspace.id,
      itemId: input.itemId,
    });
    if (!result) return error(404, 'not_found', 'Inbox item not found.');
    return ok(result);
  });
}

export async function snoozeHomeInboxRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  itemId: string;
  until: unknown;
}): Promise<RouteResult<HomeInboxMutationResult>> {
  if (!isUuid(input.itemId)) {
    return error(400, 'invalid_item_id', 'Inbox item id must be a UUID.');
  }
  const until = parseSnoozeUntil(input.until);
  if (!until.ok) return error(400, 'invalid_until', until.message);
  return withHomeWorkspace(input, async ({ workspace }) => {
    const writerError = requireHomeWriter(workspace);
    if (writerError) return writerError;
    const result = await snoozeHomeInboxItem({
      workspaceId: workspace.id,
      itemId: input.itemId,
      until: until.iso,
    });
    if (!result) return error(404, 'not_found', 'Inbox item not found.');
    return ok(result);
  });
}

export async function addHomeNewsToContextRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  matchId: string;
}): Promise<RouteResult<HomeNewsMutationResult>> {
  if (!isUuid(input.matchId)) {
    return error(400, 'invalid_match_id', 'News match id must be a UUID.');
  }
  return withHomeWorkspace(input, async ({ workspace }) => {
    const writerError = requireHomeWriter(workspace);
    if (writerError) return writerError;
    try {
      const result = await addHomeNewsToContext({
        workspaceId: workspace.id,
        matchId: input.matchId,
        userId: input.auth.userId,
      });
      if (!result) return error(404, 'not_found', 'News match not found.');
      return ok(result);
    } catch (err) {
      if (err instanceof Error && err.message.includes('Maximum 50')) {
        return error(400, 'source_limit', err.message);
      }
      throw err;
    }
  });
}

export async function markHomeNewsNotRelevantRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  matchId: string;
}): Promise<RouteResult<HomeNewsMutationResult>> {
  if (!isUuid(input.matchId)) {
    return error(400, 'invalid_match_id', 'News match id must be a UUID.');
  }
  return withHomeWorkspace(input, async ({ workspace }) => {
    const writerError = requireHomeWriter(workspace);
    if (writerError) return writerError;
    const result = await markHomeNewsNotRelevant({
      workspaceId: workspace.id,
      matchId: input.matchId,
    });
    if (!result) return error(404, 'not_found', 'News match not found.');
    return ok(result);
  });
}

export async function dismissHomeRecommendationRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  recommendationId: string;
}): Promise<RouteResult<HomeRecommendationMutationResult>> {
  if (!isUuid(input.recommendationId)) {
    return error(
      400,
      'invalid_recommendation_id',
      'Recommendation id must be a UUID.',
    );
  }
  return withHomeWorkspace(input, async ({ workspace }) => {
    const writerError = requireHomeWriter(workspace);
    if (writerError) return writerError;
    const result = await dismissHomeRecommendation({
      workspaceId: workspace.id,
      recommendationId: input.recommendationId,
    });
    if (!result) return error(404, 'not_found', 'Recommendation not found.');
    return ok(result);
  });
}

export function mountHomeRoutes(
  app: HomeApp,
  requireAuthMiddleware: HomeAuthMiddleware,
): void {
  app.use('/api/v1/home', requireAuthMiddleware);
  app.use('/api/v1/home/*', requireAuthMiddleware);

  app.get('/api/v1/home/summary', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await getHomeSummaryRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
    });
    return jsonResponse(result);
  });

  app.get('/api/v1/home/inbox', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await listHomeInboxRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      limit: c.req.query('limit'),
      cursor: c.req.query('cursor'),
    });
    return jsonResponse(result);
  });

  app.get('/api/v1/home/recommendations', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await listHomeRecommendationsRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      limit: c.req.query('limit'),
    });
    return jsonResponse(result);
  });

  app.get('/api/v1/home/news', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await listHomeNewsRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      limit: c.req.query('limit'),
      cursor: c.req.query('cursor'),
    });
    return jsonResponse(result);
  });

  app.post('/api/v1/home/inbox/:id/dismiss', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const result = await dismissHomeInboxRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      itemId: c.req.param('id'),
    });
    return jsonResponse(result);
  });

  app.post('/api/v1/home/inbox/:id/read', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const result = await markHomeInboxReadRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      itemId: c.req.param('id'),
    });
    return jsonResponse(result);
  });

  app.post('/api/v1/home/inbox/:id/resolve', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const result = await resolveHomeInboxRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      itemId: c.req.param('id'),
    });
    return jsonResponse(result);
  });

  app.post('/api/v1/home/inbox/:id/snooze', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const body = await readHomeJsonBody(c);
    if (!body.ok) {
      return jsonResponse(error(400, 'invalid_json', body.error));
    }
    const result = await snoozeHomeInboxRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      itemId: c.req.param('id'),
      until: body.data.until,
    });
    return jsonResponse(result);
  });

  app.post('/api/v1/home/news/:id/add-to-context', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const result = await addHomeNewsToContextRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      matchId: c.req.param('id'),
    });
    return jsonResponse(result);
  });

  app.post('/api/v1/home/news/:id/not-relevant', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const result = await markHomeNewsNotRelevantRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      matchId: c.req.param('id'),
    });
    return jsonResponse(result);
  });

  app.post('/api/v1/home/recommendations/:id/dismiss', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const result = await dismissHomeRecommendationRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      recommendationId: c.req.param('id'),
    });
    return jsonResponse(result);
  });
}

/** Mirror of the worker-app CSRF guard for the Home write routes. */
function checkCsrf(c: Context, auth: AuthContext): Response | null {
  const csrf = validateCsrfTokenPg({
    method: c.req.method,
    authType: auth.authType,
    cookieHeader: c.req.header('cookie'),
    csrfHeader: c.req.header('x-csrf-token'),
  });
  if (csrf.ok) return null;
  return c.json(
    { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
    403,
  );
}

async function readHomeJsonBody(
  c: Context,
): Promise<
  { ok: true; data: Record<string, unknown> } | { ok: false; error: string }
> {
  const bodyText = await c.req.text();
  if (!bodyText.trim()) return { ok: true, data: {} };
  try {
    return { ok: true, data: JSON.parse(bodyText) as Record<string, unknown> };
  } catch {
    return { ok: false, error: 'Request body is not valid JSON' };
  }
}

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
