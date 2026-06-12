// Regression suite for the P1-0 web_search transaction split (Talk
// Runtime v2, locked decision 7): credential resolution runs in a short
// committed `withUserContext` tx; the provider fetch runs OUTSIDE any
// transaction. The load-bearing test here proves a hung provider fetch
// can no longer hold the request scope's max:1 connection — the
// 2026-06-12 wedge class.

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

vi.mock('./tavily.js', () => ({
  tavilySearch: vi.fn(),
}));

import {
  closePgDatabase,
  getDbPg,
  initPgDatabase,
  withRequestScopedDb,
} from '../../db.js';
import type { AuthContext } from '../web/types.js';
import { putWebSearchCredentialRoute } from '../web/routes/web-search.js';
import { runWebSearchForUser } from './registry.js';
import { tavilySearch } from './tavily.js';
import { WebSearchError, type WebSearchResult } from './types.js';

const ADMIN_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54432/postgres';
const USER_ID = '0c767676-cccc-cccc-cccc-cccccccccccc';

function auth(): AuthContext {
  return {
    sessionId: 'web-search-registry-session',
    userId: USER_ID,
    role: 'owner',
    authType: 'bearer',
  };
}

async function seedAuthUser(): Promise<void> {
  // Inserting auth.users fires the on_auth_user_created trigger, which
  // materializes the public.users row the registry's RLS read targets.
  const db = getDbPg();
  await db`
    insert into auth.users (id, email, raw_user_meta_data)
    values (
      ${USER_ID}::uuid,
      ${'web-search-registry@clawtalk.local'},
      jsonb_build_object('full_name', 'Registry Test User')
    )
    on conflict (id) do update set email = excluded.email
  `;
}

async function resetUserState(): Promise<void> {
  const db = getDbPg();
  await db`delete from public.web_search_provider_secrets where owner_id = ${USER_ID}::uuid`;
  await db`
    update public.users
    set preferred_web_search_provider_id = null
    where id = ${USER_ID}::uuid
  `;
}

async function seedActiveTavilyKey(apiKey: string): Promise<void> {
  const res = await putWebSearchCredentialRoute(auth(), 'web_search.tavily', {
    apiKey,
  });
  if (res.statusCode !== 200) {
    throw new Error(`Failed to seed tavily key: ${JSON.stringify(res.body)}`);
  }
}

beforeAll(async () => {
  await initPgDatabase({ url: ADMIN_DB_URL });
  await seedAuthUser();
});

afterAll(async () => {
  const db = getDbPg();
  await resetUserState();
  await db`delete from auth.users where id = ${USER_ID}::uuid`;
  await closePgDatabase();
});

beforeEach(async () => {
  vi.mocked(tavilySearch).mockReset();
  await resetUserState();
});

afterEach(resetUserState);

describe('runWebSearchForUser transaction split', () => {
  it('a hung provider fetch does not hold the request-scoped connection (run persistence stays unblocked)', async () => {
    await seedActiveTavilyKey('tvly-hung-fetch-key');

    let adapterInvoked!: () => void;
    const adapterStarted = new Promise<void>((resolve) => {
      adapterInvoked = resolve;
    });
    vi.mocked(tavilySearch).mockImplementation(() => {
      adapterInvoked();
      // Never settles — simulates a wedged provider.
      return new Promise<WebSearchResult[]>(() => {});
    });

    await withRequestScopedDb(ADMIN_DB_URL, null, null, async (sql) => {
      const pending = runWebSearchForUser(USER_ID, 'hang forever');
      pending.catch(() => {});

      // The adapter only runs after resolveWebSearchExecution returned,
      // i.e. after the credential tx COMMITTED.
      await adapterStarted;

      // With the fetch hung, the max:1 request connection must be free.
      // Pre-split, the open credential tx held it and this probe queued
      // behind the wedge until the 1h sweep.
      const probe = await Promise.race([
        sql`select 1 as ok`.then(() => 'completed' as const),
        new Promise<'blocked'>((resolve) =>
          setTimeout(() => resolve('blocked'), 3_000),
        ),
      ]);
      expect(probe).toBe('completed');
    });

    expect(tavilySearch).toHaveBeenCalledWith(
      'tvly-hung-fetch-key',
      'hang forever',
      undefined,
    );
  });

  it('a provider failure after the credential tx keeps its identity (late 401 says fix-your-key)', async () => {
    await seedActiveTavilyKey('tvly-revoked-key');
    vi.mocked(tavilySearch).mockRejectedValue(
      new WebSearchError(
        'tavily rejected the API key (HTTP 401)',
        'web_search.tavily',
        401,
      ),
    );

    const rejection = runWebSearchForUser(USER_ID, 'post-commit failure');
    await expect(rejection).rejects.toBeInstanceOf(WebSearchError);
    await expect(rejection).rejects.toMatchObject({
      statusCode: 401,
      message: expect.stringContaining('401'),
    });
  });

  it('still resolves provider + decrypted key and returns results on the happy path', async () => {
    await seedActiveTavilyKey('tvly-happy-key');
    vi.mocked(tavilySearch).mockResolvedValue([
      { title: 'Result', url: 'https://example.com', snippet: 'snippet' },
    ] as WebSearchResult[]);

    const response = await runWebSearchForUser(USER_ID, '  padded query  ');
    expect(response.providerId).toBe('web_search.tavily');
    expect(response.query).toBe('padded query');
    expect(response.results).toHaveLength(1);
    expect(tavilySearch).toHaveBeenCalledWith(
      'tvly-happy-key',
      'padded query',
      undefined,
    );
  });

  it('throws the configure-first WebSearchError when no provider is active', async () => {
    const rejection = runWebSearchForUser(USER_ID, 'unconfigured');
    await expect(rejection).rejects.toBeInstanceOf(WebSearchError);
    await expect(rejection).rejects.toMatchObject({
      statusCode: 0,
      message: expect.stringContaining('No web search provider'),
    });
    expect(tavilySearch).not.toHaveBeenCalled();
  });

  it('rejects an empty query before touching the database', async () => {
    const rejection = runWebSearchForUser(USER_ID, '   ');
    await expect(rejection).rejects.toMatchObject({
      statusCode: 0,
      message: expect.stringContaining('query is empty'),
    });
    expect(tavilySearch).not.toHaveBeenCalled();
  });
});
