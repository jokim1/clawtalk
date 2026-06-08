import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import type { AuthContext } from '../types.js';
import { mountGreenfieldApiRoutes } from './greenfield-api.js';

type Variables = {
  auth: AuthContext;
};

const TEST_AUTH: AuthContext = {
  sessionId: 'greenfield-api-test-session',
  userId: '10000000-0000-4000-8000-000000000001',
  role: 'member',
  authType: 'bearer',
};

function buildMountedGreenfieldApp(): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('auth', TEST_AUTH);
    await next();
  });
  mountGreenfieldApiRoutes(app);
  return app;
}

describe('mountGreenfieldApiRoutes', () => {
  it('mounts POST /api/v1/talks/sidebar/reorder', async () => {
    const app = buildMountedGreenfieldApp();
    const res = await app.request(
      new Request('https://app.test/api/v1/talks/sidebar/reorder', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          itemType: 'workspace',
          itemId: '10000000-0000-4000-8000-000000000aaa',
          destinationFolderId: null,
          destinationIndex: 0,
        }),
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('invalid_sidebar_reorder');
  });

  it('mounts GET /api/v1/talks/:talkId/runs/:runId/context', async () => {
    const app = buildMountedGreenfieldApp();
    const res = await app.request(
      new Request(
        'https://app.test/api/v1/talks/%E0%A4%A/runs/10000000-0000-4000-8000-000000000bbb/context',
      ),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('invalid_talk_id');
  });
});
