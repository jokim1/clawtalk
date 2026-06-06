import type { Context, Hono, MiddlewareHandler } from 'hono';

import { withUserContext } from '../../../db.js';
import {
  getHomeSummary,
  listHomeInboxItems,
  listHomeNews,
  listHomeRecommendations,
  type HomeInboxPayload,
  type HomeNewsPayload,
  type HomeRecommendationsPayload,
  type HomeSummaryPayload,
} from '../../db/home-accessors.js';
import {
  resolveWorkspaceForUser,
  type WorkspaceSummaryRecord,
} from '../../workspaces/accessors.js';
import {
  checkRateLimit,
  type RateLimitResult,
} from '../middleware/rate-limit.js';
import type { ApiEnvelope, AuthContext } from '../types.js';

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
