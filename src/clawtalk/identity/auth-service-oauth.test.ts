import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_FETCH = globalThis.fetch;

describe('auth service google oauth code flow', () => {
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('exchanges authorization code and logs in with verified google id token', async () => {
    vi.resetModules();
    vi.stubEnv('AUTH_DEV_MODE', 'false');
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'test-client-id');
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'test-client-secret');
    vi.stubEnv(
      'GOOGLE_OAUTH_REDIRECT_URI',
      'http://127.0.0.1:3210/api/v1/auth/google/callback',
    );

    const db = await import('../db/index.js');
    const authService = await import('./auth-service.js');
    db._initTestDatabase();

    const oauthStart = authService.startGoogleOAuth();
    const authUrl = new URL(oauthStart.authorizationUrl);
    const nonce = authUrl.searchParams.get('nonce');
    expect(nonce).toBeTruthy();

    globalThis.fetch = vi.fn(async (input, init) => {
      const url = getRequestUrl(input);
      if (url === 'https://oauth2.googleapis.com/token') {
        const params = normalizeFormBody(init?.body);
        expect(params.get('code')).toBe('auth-code-1');
        expect(params.get('grant_type')).toBe('authorization_code');
        expect(params.get('code_verifier')).toBeTruthy();
        return jsonResponse({
          access_token: 'google-access-token',
          id_token: buildTestIdToken({
            iss: 'https://accounts.google.com',
            aud: 'test-client-id',
            exp: Math.floor(Date.now() / 1000) + 3600,
            sub: 'google-subject-owner',
            email: 'owner@example.com',
            email_verified: true,
            name: 'Owner',
            nonce: nonce!,
          }),
        });
      }

      if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) {
        return jsonResponse({
          iss: 'https://accounts.google.com',
          aud: 'test-client-id',
          exp: String(Math.floor(Date.now() / 1000) + 3600),
          email: 'owner@example.com',
          email_verified: 'true',
          name: 'Owner',
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const result = await authService.completeGoogleOAuthCallback({
      state: oauthStart.state,
      code: 'auth-code-1',
    });

    expect(result.user.email).toBe('owner@example.com');
    expect(result.user.role).toBe('owner');
    expect(result.session.accessToken).toBeTruthy();
  });

  it('uses an explicit local redirect override even when hosted oauth config is present', async () => {
    vi.resetModules();
    vi.stubEnv('AUTH_DEV_MODE', 'false');
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'test-client-id');
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'test-client-secret');
    vi.stubEnv('INITIAL_OWNER_EMAIL', 'owner@example.com');
    vi.stubEnv(
      'GOOGLE_OAUTH_REDIRECT_URI',
      'https://clawtalk.app/api/v1/auth/google/callback',
    );

    const db = await import('../db/index.js');
    const authService = await import('./auth-service.js');
    db._initTestDatabase();

    const localRedirectUri =
      'http://127.0.0.1:3210/api/v1/auth/google/callback';
    const oauthStart = authService.startGoogleOAuth({
      redirectUri: localRedirectUri,
    });
    const authUrl = new URL(oauthStart.authorizationUrl);
    const nonce = authUrl.searchParams.get('nonce');
    expect(authUrl.searchParams.get('redirect_uri')).toBe(localRedirectUri);
    expect(nonce).toBeTruthy();

    globalThis.fetch = vi.fn(async (input, init) => {
      const url = getRequestUrl(input);
      if (url === 'https://oauth2.googleapis.com/token') {
        const params = normalizeFormBody(init?.body);
        expect(params.get('redirect_uri')).toBe(localRedirectUri);
        return jsonResponse({
          access_token: 'google-access-token',
          id_token: buildTestIdToken({
            iss: 'https://accounts.google.com',
            aud: 'test-client-id',
            exp: Math.floor(Date.now() / 1000) + 3600,
            sub: 'google-subject-owner',
            email: 'owner@example.com',
            email_verified: true,
            name: 'Owner',
            nonce: nonce!,
          }),
        });
      }

      if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) {
        return jsonResponse({
          iss: 'https://accounts.google.com',
          aud: 'test-client-id',
          exp: String(Math.floor(Date.now() / 1000) + 3600),
          email: 'owner@example.com',
          email_verified: 'true',
          name: 'Owner',
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const result = await authService.completeGoogleOAuthCallback({
      state: oauthStart.state,
      code: 'auth-code-local-override',
    });

    expect(result.user.email).toBe('owner@example.com');
  });

  it('keeps the configured hosted redirect when no override is provided', async () => {
    vi.resetModules();
    vi.stubEnv('AUTH_DEV_MODE', 'false');
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'test-client-id');
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'test-client-secret');
    vi.stubEnv(
      'GOOGLE_OAUTH_REDIRECT_URI',
      'https://clawtalk.app/api/v1/auth/google/callback',
    );

    const db = await import('../db/index.js');
    const authService = await import('./auth-service.js');
    db._initTestDatabase();

    const oauthStart = authService.startGoogleOAuth();
    const authUrl = new URL(oauthStart.authorizationUrl);

    expect(authUrl.searchParams.get('redirect_uri')).toBe(
      'https://clawtalk.app/api/v1/auth/google/callback',
    );
  });

  it('rejects code flow when nonce claim mismatches stored oauth state', async () => {
    vi.resetModules();
    vi.stubEnv('AUTH_DEV_MODE', 'false');
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'test-client-id');
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'test-client-secret');
    vi.stubEnv(
      'GOOGLE_OAUTH_REDIRECT_URI',
      'http://127.0.0.1:3210/api/v1/auth/google/callback',
    );

    const db = await import('../db/index.js');
    const authService = await import('./auth-service.js');
    db._initTestDatabase();

    const oauthStart = authService.startGoogleOAuth();

    globalThis.fetch = vi.fn(async (input) => {
      const url = getRequestUrl(input);
      if (url === 'https://oauth2.googleapis.com/token') {
        return jsonResponse({
          id_token: buildTestIdToken({
            iss: 'https://accounts.google.com',
            aud: 'test-client-id',
            exp: Math.floor(Date.now() / 1000) + 3600,
            email: 'owner@example.com',
            email_verified: true,
            name: 'Owner',
            nonce: 'wrong-nonce',
          }),
        });
      }

      if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) {
        return jsonResponse({
          iss: 'https://accounts.google.com',
          aud: 'test-client-id',
          exp: String(Math.floor(Date.now() / 1000) + 3600),
          email: 'owner@example.com',
          email_verified: 'true',
          name: 'Owner',
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    await expect(
      authService.completeGoogleOAuthCallback({
        state: oauthStart.state,
        code: 'auth-code-2',
      }),
    ).rejects.toMatchObject({ code: 'google_nonce_mismatch' });
  });

  it('rejects code flow when id token is expired', async () => {
    vi.resetModules();
    vi.stubEnv('AUTH_DEV_MODE', 'false');
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'test-client-id');
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'test-client-secret');
    vi.stubEnv(
      'GOOGLE_OAUTH_REDIRECT_URI',
      'http://127.0.0.1:3210/api/v1/auth/google/callback',
    );

    const db = await import('../db/index.js');
    const authService = await import('./auth-service.js');
    db._initTestDatabase();

    const oauthStart = authService.startGoogleOAuth();
    const authUrl = new URL(oauthStart.authorizationUrl);
    const nonce = authUrl.searchParams.get('nonce');
    expect(nonce).toBeTruthy();

    globalThis.fetch = vi.fn(async (input) => {
      const url = getRequestUrl(input);
      if (url === 'https://oauth2.googleapis.com/token') {
        return jsonResponse({
          id_token: buildTestIdToken({
            iss: 'https://accounts.google.com',
            aud: 'test-client-id',
            exp: Math.floor(Date.now() / 1000) - 600,
            email: 'owner@example.com',
            email_verified: true,
            name: 'Owner',
            nonce: nonce!,
          }),
        });
      }

      if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) {
        return jsonResponse({
          iss: 'https://accounts.google.com',
          aud: 'test-client-id',
          exp: String(Math.floor(Date.now() / 1000) - 600),
          email: 'owner@example.com',
          email_verified: 'true',
          name: 'Owner',
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    await expect(
      authService.completeGoogleOAuthCallback({
        state: oauthStart.state,
        code: 'auth-code-3',
      }),
    ).rejects.toMatchObject({ code: 'google_id_token_expired' });
  });

  it('rejects code flow when google email is not verified', async () => {
    vi.resetModules();
    vi.stubEnv('AUTH_DEV_MODE', 'false');
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'test-client-id');
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'test-client-secret');
    vi.stubEnv(
      'GOOGLE_OAUTH_REDIRECT_URI',
      'http://127.0.0.1:3210/api/v1/auth/google/callback',
    );

    const db = await import('../db/index.js');
    const authService = await import('./auth-service.js');
    db._initTestDatabase();

    const oauthStart = authService.startGoogleOAuth();
    const authUrl = new URL(oauthStart.authorizationUrl);
    const nonce = authUrl.searchParams.get('nonce');
    expect(nonce).toBeTruthy();

    globalThis.fetch = vi.fn(async (input) => {
      const url = getRequestUrl(input);
      if (url === 'https://oauth2.googleapis.com/token') {
        return jsonResponse({
          id_token: buildTestIdToken({
            iss: 'https://accounts.google.com',
            aud: 'test-client-id',
            exp: Math.floor(Date.now() / 1000) + 3600,
            email: 'owner@example.com',
            email_verified: false,
            name: 'Owner',
            nonce: nonce!,
          }),
        });
      }

      if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) {
        return jsonResponse({
          iss: 'https://accounts.google.com',
          aud: 'test-client-id',
          exp: String(Math.floor(Date.now() / 1000) + 3600),
          email: 'owner@example.com',
          email_verified: 'false',
          name: 'Owner',
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    await expect(
      authService.completeGoogleOAuthCallback({
        state: oauthStart.state,
        code: 'auth-code-4',
      }),
    ).rejects.toMatchObject({ code: 'google_email_not_verified' });
  });
});

function getRequestUrl(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return (input as { url: string }).url;
}

function normalizeFormBody(body: unknown): URLSearchParams {
  if (body instanceof URLSearchParams) return body;
  return new URLSearchParams(String(body ?? ''));
}

function buildTestIdToken(payload: Record<string, unknown>): string {
  const headerPart = Buffer.from(
    JSON.stringify({
      alg: 'RS256',
      typ: 'JWT',
    }),
  ).toString('base64url');
  const payloadPart = Buffer.from(
    JSON.stringify({
      sub: 'google-test-subject',
      ...payload,
    }),
  ).toString('base64url');
  return `${headerPart}.${payloadPart}.signature`;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json',
    },
  });
}
