import { afterEach, describe, expect, it, vi } from 'vitest';

describe('auth service public mode bootstrap', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function loadAuthService() {
    vi.resetModules();
    vi.stubEnv('PUBLIC_MODE', 'true');
    vi.stubEnv('TRUSTED_PROXY_MODE', 'cloudflare');
    vi.stubEnv('INITIAL_OWNER_EMAIL', 'owner@example.com');

    const db = await import('../db/index.js');
    const authService = await import('./auth-service.js');
    db._initTestDatabase();
    return { db, authService };
  }

  it('allows only INITIAL_OWNER_EMAIL to claim the first owner', async () => {
    const { authService } = await loadAuthService();

    const oauthStart = authService.startGoogleOAuth();
    const result = await authService.completeGoogleOAuthCallback({
      state: oauthStart.state,
      email: 'Owner@Example.com',
      displayName: 'Owner',
    });

    expect(result.user.role).toBe('owner');
    expect(result.user.email).toBe('owner@example.com');
  });

  it('rejects a non-matching first login in public mode', async () => {
    const { authService } = await loadAuthService();

    const oauthStart = authService.startGoogleOAuth();

    await expect(
      authService.completeGoogleOAuthCallback({
        state: oauthStart.state,
        email: 'intruder@example.com',
        displayName: 'Intruder',
      }),
    ).rejects.toMatchObject({
      code: 'invite_required',
      status: 403,
    });
  });

  it('ignores INITIAL_OWNER_EMAIL once an owner exists and uses invite flow', async () => {
    const { authService } = await loadAuthService();

    const ownerStart = authService.startGoogleOAuth();
    const ownerResult = await authService.completeGoogleOAuthCallback({
      state: ownerStart.state,
      email: 'owner@example.com',
      displayName: 'Owner',
    });

    authService.createInvite({
      inviterUserId: ownerResult.user.id,
      role: 'member',
      email: 'member@example.com',
    });

    const memberStart = authService.startGoogleOAuth();
    const memberResult = await authService.completeGoogleOAuthCallback({
      state: memberStart.state,
      email: 'member@example.com',
      displayName: 'Member',
    });

    expect(memberResult.user.role).toBe('member');
    expect(memberResult.user.email).toBe('member@example.com');
  });
});
