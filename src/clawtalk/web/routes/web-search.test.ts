import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

import { closePgDatabase, getDbPg, initPgDatabase } from '../../../db.js';
import type { AuthContext } from '../types.js';
import {
  listWebSearchProvidersRoute,
  putWebSearchActiveProviderRoute,
  putWebSearchCredentialRoute,
} from './web-search.js';

const ADMIN_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54432/postgres';
const USER_ID = '0c767676-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function auth(userId = USER_ID): AuthContext {
  return {
    sessionId: 'web-search-session',
    userId,
    role: 'owner',
    authType: 'bearer',
  };
}

async function seedAuthUser(): Promise<void> {
  // Inserting auth.users fires the on_auth_user_created trigger, which
  // materializes the public.users row the active-provider update targets.
  const db = getDbPg();
  await db`
    insert into auth.users (id, email, raw_user_meta_data)
    values (
      ${USER_ID}::uuid,
      ${'web-search@clawtalk.local'},
      jsonb_build_object('full_name', 'Web Search User')
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

beforeEach(resetUserState);
afterEach(resetUserState);

describe('putWebSearchCredentialRoute auto-activation', () => {
  it('activates the first saved provider so web_search works without a separate step', async () => {
    const res = await putWebSearchCredentialRoute(auth(), 'web_search.tavily', {
      apiKey: 'tvly-first-key',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      data: { saved: true, activeProviderId: 'web_search.tavily' },
    });

    const list = await listWebSearchProvidersRoute(auth());
    expect(list.body.ok).toBe(true);
    if (!list.body.ok) throw new Error('list failed');
    expect(list.body.data.activeProviderId).toBe('web_search.tavily');
    expect(
      list.body.data.providers.find((p) => p.id === 'web_search.tavily'),
    ).toMatchObject({ hasCredential: true, isActive: true });
  });

  it('does not hijack an already-active provider when a second key is added', async () => {
    await putWebSearchCredentialRoute(auth(), 'web_search.tavily', {
      apiKey: 'tvly-first-key',
    });
    const res = await putWebSearchCredentialRoute(auth(), 'web_search.brave', {
      apiKey: 'BSA-second-key',
    });
    expect(res.body).toMatchObject({
      ok: true,
      data: { saved: true, activeProviderId: 'web_search.tavily' },
    });

    const list = await listWebSearchProvidersRoute(auth());
    if (!list.body.ok) throw new Error('list failed');
    expect(list.body.data.activeProviderId).toBe('web_search.tavily');
  });

  it('respects an intentionally cleared active provider when another key is saved', async () => {
    // First key auto-activates...
    await putWebSearchCredentialRoute(auth(), 'web_search.tavily', {
      apiKey: 'tvly-first-key',
    });
    // ...the user then deliberately disables web search by clearing active...
    await putWebSearchActiveProviderRoute(auth(), { providerId: null });
    // ...and saving another key must NOT silently re-enable it.
    const res = await putWebSearchCredentialRoute(auth(), 'web_search.brave', {
      apiKey: 'BSA-second-key',
    });
    expect(res.body).toMatchObject({
      ok: true,
      data: { saved: true, activeProviderId: null },
    });

    const list = await listWebSearchProvidersRoute(auth());
    if (!list.body.ok) throw new Error('list failed');
    expect(list.body.data.activeProviderId).toBe(null);
  });

  it('lets the user switch the active provider explicitly afterward', async () => {
    await putWebSearchCredentialRoute(auth(), 'web_search.tavily', {
      apiKey: 'tvly-first-key',
    });
    await putWebSearchCredentialRoute(auth(), 'web_search.brave', {
      apiKey: 'BSA-second-key',
    });
    const switched = await putWebSearchActiveProviderRoute(auth(), {
      providerId: 'web_search.brave',
    });
    expect(switched.body).toMatchObject({
      ok: true,
      data: { activeProviderId: 'web_search.brave' },
    });
  });

  it('rejects activating a provider that has no stored key', async () => {
    const res = await putWebSearchActiveProviderRoute(auth(), {
      providerId: 'web_search.exa',
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unknown provider on save', async () => {
    const res = await putWebSearchCredentialRoute(
      auth(),
      'web_search.nonesuch',
      { apiKey: 'x' },
    );
    expect(res.statusCode).toBe(404);
  });
});
