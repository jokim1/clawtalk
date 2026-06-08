import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let cookieValue = '';

describe('api auth retry behavior', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get() {
        return cookieValue;
      },
      set(value: string) {
        cookieValue = value;
      },
    });
    cookieValue = 'cr_csrf_token=test-csrf-token';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('refreshes once and retries the original request after a 401', async () => {
    const queue: Response[] = [
      jsonResponse(401, {
        ok: false,
        error: { code: 'unauthorized', message: 'Authentication is required' },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          user: {
            id: 'u1',
            email: 'owner@example.com',
            displayName: 'Owner',
            role: 'owner',
          },
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          talks: [],
          page: { limit: 50, offset: 0, count: 0 },
        },
      }),
    ];
    const paths: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      paths.push(normalizePath(input));
      const next = queue.shift();
      if (!next) throw new Error('No mocked response left for fetch()');
      return next;
    });

    const api = await loadApiModule();
    const talks = await api.listTalks();

    expect(talks).toEqual([]);
    expect(paths).toEqual([
      '/api/v1/talks',
      '/api/v1/auth/refresh',
      '/api/v1/talks',
    ]);
  });

  it('throws UnauthorizedError when refresh fails', async () => {
    const queue: Response[] = [
      jsonResponse(401, {
        ok: false,
        error: { code: 'unauthorized', message: 'Authentication is required' },
      }),
      jsonResponse(401, {
        ok: false,
        error: { code: 'invalid_refresh_token', message: 'Invalid token' },
      }),
    ];
    vi.stubGlobal('fetch', async () => {
      const next = queue.shift();
      if (!next) throw new Error('No mocked response left for fetch()');
      return next;
    });

    const api = await loadApiModule();

    await expect(api.listTalks()).rejects.toBeInstanceOf(api.UnauthorizedError);
  });

  it('throws UnauthorizedError when refresh succeeds but retried request is still 401', async () => {
    const queue: Response[] = [
      jsonResponse(401, {
        ok: false,
        error: { code: 'unauthorized', message: 'Authentication is required' },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          user: {
            id: 'u1',
            email: 'owner@example.com',
            displayName: 'Owner',
            role: 'owner',
          },
        },
      }),
      jsonResponse(401, {
        ok: false,
        error: { code: 'unauthorized', message: 'Authentication is required' },
      }),
    ];
    const paths: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      paths.push(normalizePath(input));
      const next = queue.shift();
      if (!next) throw new Error('No mocked response left for fetch()');
      return next;
    });

    const api = await loadApiModule();

    await expect(api.listTalks()).rejects.toBeInstanceOf(api.UnauthorizedError);
    expect(paths).toEqual([
      '/api/v1/talks',
      '/api/v1/auth/refresh',
      '/api/v1/talks',
    ]);
  });

  it('coalesces concurrent refresh attempts into a single refresh call', async () => {
    const callCounts = new Map<string, number>();
    let refreshCalls = 0;

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const path = normalizePath(input);
      const count = callCounts.get(path) || 0;
      callCounts.set(path, count + 1);

      if (path === '/api/v1/auth/refresh') {
        refreshCalls += 1;
        return jsonResponse(200, {
          ok: true,
          data: {
            user: {
              id: 'u1',
              email: 'owner@example.com',
              displayName: 'Owner',
              role: 'owner',
            },
          },
        });
      }

      if (path === '/api/v1/talks') {
        if (count === 0) {
          return jsonResponse(401, {
            ok: false,
            error: {
              code: 'unauthorized',
              message: 'Authentication is required',
            },
          });
        }
        return jsonResponse(200, {
          ok: true,
          data: {
            talks: [],
            page: { limit: 50, offset: 0, count: 0 },
          },
        });
      }

      if (path === '/api/v1/session/me') {
        if (count === 0) {
          return jsonResponse(401, {
            ok: false,
            error: {
              code: 'unauthorized',
              message: 'Authentication is required',
            },
          });
        }
        return jsonResponse(200, {
          ok: true,
          data: {
            user: {
              id: 'u1',
              email: 'owner@example.com',
              displayName: 'Owner',
              role: 'owner',
            },
          },
        });
      }

      throw new Error(`Unexpected fetch path: ${path}`);
    });

    const api = await loadApiModule();
    const [talks, user] = await Promise.all([
      api.listTalks(),
      api.getSessionMe(),
    ]);

    expect(talks).toEqual([]);
    expect(user.email).toBe('owner@example.com');
    expect(refreshCalls).toBe(1);
  });

  it('does not attempt refresh for logout requests', async () => {
    const paths: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const path = normalizePath(input);
      paths.push(path);
      return jsonResponse(401, {
        ok: false,
        error: { code: 'unauthorized', message: 'Authentication is required' },
      });
    });

    const api = await loadApiModule();

    await expect(api.logout()).rejects.toBeInstanceOf(api.UnauthorizedError);
    expect(paths).toEqual(['/api/v1/auth/logout']);
  });

  it('rebuilds mutation headers after a 401 refresh retry and reuses the idempotency key', async () => {
    const mutationHeaders: Array<Record<string, string>> = [];

    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = normalizePath(input);
        if (path === '/api/v1/talks') {
          mutationHeaders.push(readHeaders(init));
          if (mutationHeaders.length === 1) {
            return jsonResponse(401, {
              ok: false,
              error: {
                code: 'unauthorized',
                message: 'Authentication is required',
              },
            });
          }

          return jsonResponse(200, {
            ok: true,
            data: {
              talk: {
                id: 'talk-1',
                ownerId: 'u1',
                title: 'New Talk',
                agents: [],
                status: 'active',
                folderId: null,
                sortOrder: 0,
                version: 1,
                createdAt: '2026-03-08T00:00:00.000Z',
                updatedAt: '2026-03-08T00:00:00.000Z',
                accessRole: 'owner',
              },
            },
          });
        }

        if (path === '/api/v1/auth/refresh') {
          cookieValue = 'cr_csrf_token=fresh-csrf-token';
          return jsonResponse(200, {
            ok: true,
            data: {
              user: {
                id: 'u1',
                email: 'owner@example.com',
                displayName: 'Owner',
                role: 'owner',
              },
            },
          });
        }

        throw new Error(`Unexpected fetch path: ${path}`);
      },
    );

    const api = await loadApiModule();
    const talk = await api.createTalk('New Talk');

    expect(talk.id).toBe('talk-1');
    expect(mutationHeaders).toHaveLength(2);
    expect(mutationHeaders[0]['x-csrf-token']).toBe('test-csrf-token');
    expect(mutationHeaders[1]['x-csrf-token']).toBe('fresh-csrf-token');
    expect(mutationHeaders[0]['idempotency-key']).toBeTruthy();
    expect(mutationHeaders[0]['idempotency-key']).toBe(
      mutationHeaders[1]['idempotency-key'],
    );
  });

  it('retries csrf_failed mutations once after refreshing session with fresh headers', async () => {
    const mutationHeaders: Array<Record<string, string>> = [];

    cookieValue = '';
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = normalizePath(input);
        if (path === '/api/v1/talks') {
          mutationHeaders.push(readHeaders(init));
          if (mutationHeaders.length === 1) {
            return jsonResponse(403, {
              ok: false,
              error: {
                code: 'csrf_failed',
                message: 'Missing X-CSRF-Token header',
              },
            });
          }
          return jsonResponse(200, {
            ok: true,
            data: {
              talk: {
                id: 'talk-2',
                ownerId: 'u1',
                title: 'Recovered Talk',
                agents: [],
                status: 'active',
                folderId: null,
                sortOrder: 0,
                version: 1,
                createdAt: '2026-03-08T00:00:00.000Z',
                updatedAt: '2026-03-08T00:00:00.000Z',
                accessRole: 'owner',
              },
            },
          });
        }

        if (path === '/api/v1/auth/refresh') {
          cookieValue = 'cr_csrf_token=recovered-csrf-token';
          return jsonResponse(200, {
            ok: true,
            data: {
              user: {
                id: 'u1',
                email: 'owner@example.com',
                displayName: 'Owner',
                role: 'owner',
              },
            },
          });
        }

        throw new Error(`Unexpected fetch path: ${path}`);
      },
    );

    const api = await loadApiModule();
    const talk = await api.createTalk('Recovered Talk');

    expect(talk.id).toBe('talk-2');
    expect(mutationHeaders).toHaveLength(2);
    expect(mutationHeaders[0]['x-csrf-token']).toBeUndefined();
    expect(mutationHeaders[1]['x-csrf-token']).toBe('recovered-csrf-token');
    expect(mutationHeaders[0]['idempotency-key']).toBe(
      mutationHeaders[1]['idempotency-key'],
    );
  });

  it('keeps message attachment helpers quarantined while greenfield storage is unavailable', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const api = await loadApiModule();
    await expect(
      api.uploadTalkAttachment(
        'talk-1',
        new File(['hello'], 'notes.txt', { type: 'text/plain' }),
      ),
    ).rejects.toMatchObject({
      status: 501,
      code: 'attachments_not_available',
    });
    await expect(
      api.deleteTalkAttachment('talk-1', 'attachment-1'),
    ).rejects.toMatchObject({
      status: 501,
      code: 'attachments_not_available',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('coalesces concurrent mutation refreshes and rebuilds fresh headers for both retries', async () => {
    const counts = new Map<string, number>();
    const createTalkHeaders: Array<Record<string, string>> = [];
    const metadataHeaders: Array<Record<string, string>> = [];
    let refreshCalls = 0;

    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = normalizePath(input);
        const count = counts.get(path) || 0;
        counts.set(path, count + 1);

        if (path === '/api/v1/auth/refresh') {
          refreshCalls += 1;
          cookieValue = 'cr_csrf_token=shared-fresh-token';
          return jsonResponse(200, {
            ok: true,
            data: {
              user: {
                id: 'u1',
                email: 'owner@example.com',
                displayName: 'Owner',
                role: 'owner',
              },
            },
          });
        }

        if (path === '/api/v1/talks') {
          createTalkHeaders.push(readHeaders(init));
          if (createTalkHeaders.length === 1) {
            return jsonResponse(401, {
              ok: false,
              error: {
                code: 'unauthorized',
                message: 'Authentication is required',
              },
            });
          }
          return jsonResponse(200, {
            ok: true,
            data: {
              talk: {
                id: 'talk-3',
                ownerId: 'u1',
                title: 'Concurrent Create',
                agents: [],
                status: 'active',
                folderId: null,
                sortOrder: 0,
                version: 1,
                createdAt: '2026-03-08T00:00:00.000Z',
                updatedAt: '2026-03-08T00:00:00.000Z',
                accessRole: 'owner',
              },
            },
          });
        }

        if (path === '/api/v1/talks/talk-99') {
          metadataHeaders.push(readHeaders(init));
          if (metadataHeaders.length === 1) {
            return jsonResponse(401, {
              ok: false,
              error: {
                code: 'unauthorized',
                message: 'Authentication is required',
              },
            });
          }
          return jsonResponse(200, {
            ok: true,
            data: {
              talk: {
                id: 'talk-99',
                ownerId: 'u1',
                title: 'Updated Talk',
                agents: [],
                status: 'active',
                folderId: null,
                sortOrder: 0,
                version: 2,
                createdAt: '2026-03-08T00:00:00.000Z',
                updatedAt: '2026-03-08T00:01:00.000Z',
                accessRole: 'owner',
              },
            },
          });
        }

        throw new Error(`Unexpected fetch path: ${path}`);
      },
    );

    const api = await loadApiModule();
    const [createdTalk, patchedTalk] = await Promise.all([
      api.createTalk('Concurrent Create'),
      api.patchTalkMetadata({ talkId: 'talk-99', title: 'Updated Talk' }),
    ]);

    expect(createdTalk.id).toBe('talk-3');
    expect(patchedTalk.id).toBe('talk-99');
    expect(refreshCalls).toBe(1);
    expect(createTalkHeaders).toHaveLength(2);
    expect(metadataHeaders).toHaveLength(2);
    expect(createTalkHeaders[1]['x-csrf-token']).toBe('shared-fresh-token');
    expect(metadataHeaders[1]['x-csrf-token']).toBe('shared-fresh-token');
    expect(createTalkHeaders[0]['idempotency-key']).toBe(
      createTalkHeaders[1]['idempotency-key'],
    );
    expect(metadataHeaders[0]['idempotency-key']).toBe(
      metadataHeaders[1]['idempotency-key'],
    );
  });

  it('does not retry non-csrf 403 responses for mutations', async () => {
    const paths: string[] = [];
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        paths.push(normalizePath(input));
        if (normalizePath(input) === '/api/v1/talks') {
          expect(readHeaders(init)['x-csrf-token']).toBe('test-csrf-token');
        }
        return jsonResponse(403, {
          ok: false,
          error: {
            code: 'forbidden',
            message: 'Forbidden',
          },
        });
      },
    );

    const api = await loadApiModule();

    await expect(api.createTalk('Forbidden')).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    });
    expect(paths).toEqual(['/api/v1/talks']);
  });

  it('preserves workspace session fields after updating profile', async () => {
    const paths: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      paths.push(String(input));
      return jsonResponse(200, {
        ok: true,
        data: {
          user: {
            id: 'u1',
            email: 'owner@example.com',
            displayName: 'Owner Renamed',
            role: 'owner',
            createdAt: '2026-03-08T00:00:00.000Z',
          },
          workspaces: [
            {
              id: 'workspace-a',
              name: 'Workspace A',
              role: 'owner',
              initials: 'WA',
            },
            {
              id: 'workspace-b',
              name: 'Workspace B',
              role: 'admin',
              initials: 'WB',
            },
          ],
          currentWorkspaceId: 'workspace-b',
        },
      });
    });

    const api = await loadApiModule();
    const user = await api.updateSessionMe({
      workspaceId: 'workspace-b',
      displayName: 'Owner Renamed',
    });

    expect(user.displayName).toBe('Owner Renamed');
    expect(user.currentWorkspaceId).toBe('workspace-b');
    expect(user.workspaces?.map((workspace) => workspace.id)).toEqual([
      'workspace-a',
      'workspace-b',
    ]);
    expect(paths).toEqual(['/api/v1/session/me?workspaceId=workspace-b']);
  });

  it('passes workspaceId through chat send and cancel requests', async () => {
    const paths: string[] = [];
    const bodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        paths.push(String(input));
        if (typeof init?.body === 'string' && init.body.trim()) {
          bodies.push(JSON.parse(init.body));
        }
        return jsonResponse(200, {
          ok: true,
          data: String(input).includes('/chat/cancel')
            ? { talkId: 'talk-1', cancelledRuns: 2 }
            : { talkId: 'talk-1', message: { id: 'message-1' }, runs: [] },
        });
      },
    );

    const api = await loadApiModule();
    await api.sendTalkMessage({
      workspaceId: 'workspace-b',
      talkId: 'talk-1',
      content: 'Hello',
      targetAgentIds: ['agent-1'],
    });
    await api.cancelTalkRuns('talk-1', { workspaceId: 'workspace-b' });

    expect(paths).toEqual([
      '/api/v1/talks/talk-1/chat?workspaceId=workspace-b',
      '/api/v1/talks/talk-1/chat/cancel?workspaceId=workspace-b',
    ]);
    expect(bodies).toEqual([
      {
        content: 'Hello',
        targetAgentIds: ['agent-1'],
        attachmentIds: [],
      },
      {},
    ]);
  });

  it('passes workspaceId through registered-agent API calls without putting it in mutation bodies', async () => {
    const paths: string[] = [];
    const bodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = normalizePath(input);
        paths.push(String(input));
        if (typeof init?.body === 'string' && init.body.trim()) {
          bodies.push(JSON.parse(init.body));
        }
        return jsonResponse(200, {
          ok: true,
          data:
            path.startsWith('/api/v1/registered-agents?') &&
            init?.method !== 'POST'
              ? []
              : {
                  id: 'agent-1',
                  name: 'Agent One',
                },
        });
      },
    );

    const api = await loadApiModule();

    await api.listRegisteredAgents({ workspaceId: 'workspace-b' });
    await api.getMainRegisteredAgent({ workspaceId: 'workspace-b' });
    await api.updateMainRegisteredAgent('agent-1', {
      workspaceId: 'workspace-b',
    });
    await api.createRegisteredAgent({
      workspaceId: 'workspace-b',
      name: 'Agent One',
      providerId: 'provider.test',
      modelId: 'model.test',
    });
    await api.updateRegisteredAgent({
      workspaceId: 'workspace-b',
      agentId: 'agent-1',
      name: 'Agent Renamed',
    });
    await api.deleteRegisteredAgent('agent-1', { workspaceId: 'workspace-b' });
    await api.dismissAgentModelUpgrade('agent-1', {
      workspaceId: 'workspace-b',
    });

    expect(paths).toEqual([
      '/api/v1/registered-agents?workspaceId=workspace-b',
      '/api/v1/registered-agents/main?workspaceId=workspace-b',
      '/api/v1/registered-agents/main?workspaceId=workspace-b',
      '/api/v1/registered-agents?workspaceId=workspace-b',
      '/api/v1/registered-agents/agent-1?workspaceId=workspace-b',
      '/api/v1/registered-agents/agent-1?workspaceId=workspace-b',
      '/api/v1/registered-agents/agent-1/dismiss-model-upgrade?workspaceId=workspace-b',
    ]);
    expect(bodies).toEqual([
      { agentId: 'agent-1' },
      { name: 'Agent One', providerId: 'provider.test', modelId: 'model.test' },
      { name: 'Agent Renamed' },
    ]);
  });

  it('stops retrying after one auth refresh and one csrf refresh', async () => {
    const mutationHeaders: Array<Record<string, string>> = [];
    let refreshCalls = 0;

    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = normalizePath(input);
        if (path === '/api/v1/talks') {
          mutationHeaders.push(readHeaders(init));
          if (mutationHeaders.length === 1) {
            return jsonResponse(401, {
              ok: false,
              error: {
                code: 'unauthorized',
                message: 'Authentication is required',
              },
            });
          }
          return jsonResponse(403, {
            ok: false,
            error: {
              code: 'csrf_failed',
              message: 'CSRF token mismatch',
            },
          });
        }

        if (path === '/api/v1/auth/refresh') {
          refreshCalls += 1;
          cookieValue = `cr_csrf_token=retry-token-${refreshCalls}`;
          return jsonResponse(200, {
            ok: true,
            data: {
              user: {
                id: 'u1',
                email: 'owner@example.com',
                displayName: 'Owner',
                role: 'owner',
              },
            },
          });
        }

        throw new Error(`Unexpected fetch path: ${path}`);
      },
    );

    const api = await loadApiModule();

    await expect(api.createTalk('Still Failing')).rejects.toMatchObject({
      status: 403,
      code: 'csrf_failed',
    });
    expect(refreshCalls).toBe(2);
    expect(mutationHeaders).toHaveLength(3);
    expect(mutationHeaders[0]['x-csrf-token']).toBe('test-csrf-token');
    expect(mutationHeaders[1]['x-csrf-token']).toBe('retry-token-1');
    expect(mutationHeaders[2]['x-csrf-token']).toBe('retry-token-2');
    expect(mutationHeaders[0]['idempotency-key']).toBe(
      mutationHeaders[1]['idempotency-key'],
    );
    expect(mutationHeaders[1]['idempotency-key']).toBe(
      mutationHeaders[2]['idempotency-key'],
    );
  });
});

describe('uploadContentImage', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get() {
        return cookieValue;
      },
      set(value: string) {
        cookieValue = value;
      },
    });
    cookieValue = 'cr_csrf_token=test-csrf-token';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns { url, key } on 200 envelope', async () => {
    const captured: { path: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        captured.push({ path: normalizePath(input), init });
        return jsonResponse(200, {
          ok: true,
          data: {
            url: '/api/v1/content-images/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
            key: 'ci/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
          },
        });
      },
    );

    const api = await loadApiModule();
    const result = await api.uploadContentImage({
      dataUrl: 'data:image/png;base64,AAAA',
    });

    expect(result).toEqual({
      url: '/api/v1/content-images/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
      key: 'ci/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].path).toBe('/api/v1/content-images');
    expect(captured[0].init?.method).toBe('POST');
    const headers = readHeaders(captured[0].init);
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-csrf-token']).toBe('test-csrf-token');
    expect(captured[0].init?.body).toBe(
      JSON.stringify({ dataUrl: 'data:image/png;base64,AAAA' }),
    );
  });

  it('forwards an AbortSignal to fetch', async () => {
    let received: AbortSignal | null | undefined;
    vi.stubGlobal(
      'fetch',
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        received = init?.signal;
        return jsonResponse(200, {
          ok: true,
          data: { url: '/x.png', key: 'ci/x.png' },
        });
      },
    );

    const controller = new AbortController();
    const api = await loadApiModule();
    await api.uploadContentImage(
      { dataUrl: 'data:image/png;base64,AAAA' },
      { signal: controller.signal },
    );

    expect(received).toBe(controller.signal);
  });

  it('throws ApiError with the upstream error code on 400', async () => {
    vi.stubGlobal('fetch', async () =>
      jsonResponse(400, {
        ok: false,
        error: {
          code: 'unsupported_mime',
          message: 'Image MIME could not be detected from bytes',
        },
      }),
    );

    const api = await loadApiModule();
    await expect(
      api.uploadContentImage({ dataUrl: 'data:image/png;base64,AAAA' }),
    ).rejects.toMatchObject({
      name: 'ApiError',
      status: 400,
      code: 'unsupported_mime',
    });
  });

  it('accepts a sourceUrl payload variant', async () => {
    const captured: { body?: BodyInit | null }[] = [];
    vi.stubGlobal(
      'fetch',
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        captured.push({ body: init?.body });
        return jsonResponse(200, {
          ok: true,
          data: { url: '/y.png', key: 'ci/y.png' },
        });
      },
    );

    const api = await loadApiModule();
    await api.uploadContentImage({
      sourceUrl: 'https://lh3.googleusercontent.com/x',
    });
    expect(captured[0].body).toBe(
      JSON.stringify({ sourceUrl: 'https://lh3.googleusercontent.com/x' }),
    );
  });
});

describe('switchWorkspace', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get() {
        return cookieValue;
      },
      set(value: string) {
        cookieValue = value;
      },
    });
    cookieValue = 'cr_csrf_token=test-csrf-token';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('POSTs the workspace id with the CSRF header and returns the new id', async () => {
    const captured: { path: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        captured.push({ path: normalizePath(input), init });
        return jsonResponse(200, {
          ok: true,
          data: { currentWorkspaceId: 'ws-2' },
        });
      },
    );

    const api = await loadApiModule();
    const result = await api.switchWorkspace('ws-2');

    expect(result).toEqual({ currentWorkspaceId: 'ws-2' });
    expect(captured).toHaveLength(1);
    expect(captured[0].path).toBe('/api/v1/workspaces/switch');
    expect(captured[0].init?.method).toBe('POST');
    expect(captured[0].init?.body).toBe(JSON.stringify({ workspaceId: 'ws-2' }));
    const headers = readHeaders(captured[0].init);
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-csrf-token']).toBe('test-csrf-token');
  });

  it('throws ApiError with the upstream code when the workspace is forbidden', async () => {
    vi.stubGlobal('fetch', async () =>
      jsonResponse(403, {
        ok: false,
        error: {
          code: 'workspace_forbidden',
          message: 'Workspace is not available to this user.',
        },
      }),
    );

    const api = await loadApiModule();
    await expect(api.switchWorkspace('ws-x')).rejects.toMatchObject({
      name: 'ApiError',
      status: 403,
      code: 'workspace_forbidden',
    });
  });
});

describe('active workspace header', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('sends the active workspace as x-workspace-id on workspace-scoped requests', async () => {
    localStorage.setItem('clawtalk.active-workspace', 'ws-7');
    const captured: { path: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        captured.push({ path: normalizePath(input), init });
        return jsonResponse(200, {
          ok: true,
          data: { items: [], mainTalkId: null, contents: [] },
        });
      },
    );

    const api = await loadApiModule();
    await api.getTalkSidebar().catch(() => undefined);

    expect(readHeaders(captured[0].init)['x-workspace-id']).toBe('ws-7');
  });

  it('omits x-workspace-id when no workspace is active', async () => {
    const captured: { path: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        captured.push({ path: normalizePath(input), init });
        return jsonResponse(200, {
          ok: true,
          data: { items: [], mainTalkId: null, contents: [] },
        });
      },
    );

    const api = await loadApiModule();
    await api.getTalkSidebar().catch(() => undefined);

    expect(readHeaders(captured[0].init)['x-workspace-id']).toBeUndefined();
  });

  it('does not override an explicit ?workspaceId= query param', async () => {
    localStorage.setItem('clawtalk.active-workspace', 'ws-7');
    const captured: { path: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        captured.push({ path: String(input), init });
        return jsonResponse(200, { ok: true, data: { pickerToken: 'x' } });
      },
    );

    const api = await loadApiModule();
    await api
      .getGooglePickerSession({ workspaceId: 'ws-explicit' })
      .catch(() => undefined);

    expect(readHeaders(captured[0].init)['x-workspace-id']).toBeUndefined();
    expect(captured[0].path).toContain('workspaceId=ws-explicit');
  });

  it('drops a stale active workspace and retries when /session/me is forbidden', async () => {
    localStorage.setItem('clawtalk.active-workspace', 'ws-stale');
    const captured: { path: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        captured.push({ path: normalizePath(input), init });
        if (captured.length === 1) {
          return jsonResponse(403, {
            ok: false,
            error: { code: 'workspace_forbidden', message: 'no access' },
          });
        }
        return jsonResponse(200, {
          ok: true,
          data: {
            user: {
              id: 'u1',
              email: 'a@b.c',
              name: 'A',
              displayName: 'A',
              avatarColor: null,
              initials: 'A',
              role: 'owner',
              createdAt: '',
            },
            workspaces: [
              { id: 'ws-default', name: 'Default', role: 'owner', initials: 'DE' },
            ],
            currentWorkspaceId: 'ws-default',
          },
        });
      },
    );

    const api = await loadApiModule();
    const me = await api.getSessionMe();

    expect(captured).toHaveLength(2);
    expect(readHeaders(captured[0].init)['x-workspace-id']).toBe('ws-stale');
    expect(readHeaders(captured[1].init)['x-workspace-id']).toBeUndefined();
    expect(me.currentWorkspaceId).toBe('ws-default');
    expect(localStorage.getItem('clawtalk.active-workspace')).toBeNull();
  });
});

async function loadApiModule() {
  vi.resetModules();
  return import('./api');
}

function normalizePath(input: RequestInfo | URL): string {
  const raw = String(input);
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    return new URL(raw).pathname;
  }
  return raw.split('?')[0];
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  });
}

function readHeaders(init?: RequestInit): Record<string, string> {
  const headers = new Headers(init?.headers);
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}
