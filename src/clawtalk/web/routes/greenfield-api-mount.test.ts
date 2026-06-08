import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import type { AuthContext } from '../types.js';
import { mountGreenfieldApiRoutes } from './greenfield-api.js';

const auth: AuthContext = {
  sessionId: 'mount-test-session',
  userId: '00000000-0000-0000-0000-000000000001',
  role: 'owner',
  authType: 'bearer',
};

function mountedGreenfieldApiApp(): Hono<{ Variables: { auth: AuthContext } }> {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.use('/api/v1/*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  mountGreenfieldApiRoutes(app);
  app.all('/api/v1/*', (c) =>
    c.json(
      {
        ok: false,
        error: { code: 'not_implemented_in_mount_test' },
      },
      501,
    ),
  );
  return app;
}

describe('mountGreenfieldApiRoutes', () => {
  it('mounts sidebar reorder before fallback', async () => {
    const app = mountedGreenfieldApiApp();
    const res = await app.request('/api/v1/talks/sidebar/reorder', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        itemType: 'workspace',
        itemId: '10000000-0000-4000-8000-000000000aaa',
        destinationFolderId: null,
        destinationIndex: 0,
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('invalid_sidebar_reorder');
  });

  it('mounts run context before fallback', async () => {
    const app = mountedGreenfieldApiApp();
    const res = await app.request(
      '/api/v1/talks/%E0%A4%A/runs/10000000-0000-4000-8000-000000000bbb/context',
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('invalid_talk_id');
  });
});
