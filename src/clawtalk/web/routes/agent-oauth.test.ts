import { beforeEach, describe, expect, it, vi } from 'vitest';

const oauthStateRows = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const sqlMock = vi.hoisted(() =>
  vi.fn(
    async (
      strings: TemplateStringsArray,
      ..._values: unknown[]
    ): Promise<Record<string, unknown>[]> => {
      const query = strings.join('?');
      if (query.includes('from public.provider_oauth_states')) {
        return oauthStateRows;
      }
      throw new Error(
        `Unexpected SQL in agent-oauth.test: ${strings.join('?')}`,
      );
    },
  ),
);

vi.mock('../../../db.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../../db.js')>('../../../db.js');
  return {
    ...actual,
    getDbPg: () => sqlMock,
    withUserContext: async <T>(_userId: string, fn: () => Promise<T>) => fn(),
    withTrustedDbWrites: async <T>(fn: () => Promise<T>) => fn(),
  };
});

vi.mock('../../llm/anthropic-oauth.js', () => ({
  exchangeAnthropicAuthorizationCode: vi.fn(async () => {
    throw new Error('exchangeAnthropicAuthorizationCode should not be called');
  }),
  initiateAnthropicOauth: vi.fn(async () => {
    throw new Error('initiateAnthropicOauth should not be called');
  }),
}));

vi.mock('../../llm/openai-codex-oauth.js', () => ({
  exchangeOpenAiCodexAuthorizationCode: vi.fn(async () => {
    throw new Error(
      'exchangeOpenAiCodexAuthorizationCode should not be called',
    );
  }),
  pollOpenAiCodexDeviceAuth: vi.fn(async () => {
    throw new Error('pollOpenAiCodexDeviceAuth should not be called');
  }),
  requestOpenAiCodexDeviceCode: vi.fn(async () => {
    throw new Error('requestOpenAiCodexDeviceCode should not be called');
  }),
}));

import type { AuthContext } from '../types.js';
import {
  completeAnthropicOauthRoute,
  initiateAnthropicOauthRoute,
  initiateOpenAiCodexOauthRoute,
  pollOpenAiCodexOauthRoute,
} from './agent-oauth.js';

const AUTH: AuthContext = {
  sessionId: 'agent-oauth-test-session',
  userId: '0c949494-eeee-eeee-eeee-eeeeeeeeeeee',
  role: 'owner',
  authType: 'bearer',
};
const OTHER_USER_ID = '0c949494-dddd-dddd-dddd-dddddddddddd';

beforeEach(() => {
  oauthStateRows.length = 0;
  sqlMock.mockClear();
});

describe('agent OAuth credential route scoping', () => {
  it('requires an explicit workspace for workspace-scoped Anthropic OAuth', async () => {
    const result = await initiateAnthropicOauthRoute(AUTH, {
      scope: 'workspace',
    });

    expect(result.statusCode).toBe(400);
    expect(result.body.ok ? null : result.body.error).toMatchObject({
      code: 'invalid_input',
      message:
        'workspaceId is required for workspace-scoped provider credentials.',
    });
  });

  it('requires an explicit workspace for workspace-scoped OpenAI Codex OAuth', async () => {
    const result = await initiateOpenAiCodexOauthRoute(AUTH, {
      scope: 'workspace',
    });

    expect(result.statusCode).toBe(400);
    expect(result.body.ok ? null : result.body.error).toMatchObject({
      code: 'invalid_input',
      message:
        'workspaceId is required for workspace-scoped provider credentials.',
    });
  });

  it('rejects Anthropic OAuth completion for a state owned by another user', async () => {
    oauthStateRows.push({
      id: '11111111-1111-4111-8111-111111111111',
      scope: 'user',
      user_id: OTHER_USER_ID,
      workspace_id: null,
      flow_kind: 'pkce',
      code_verifier: 'verifier',
      device_auth_id: null,
      user_code: null,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      consumed_at: null,
    });

    const result = await completeAnthropicOauthRoute(AUTH, {
      state: 'state-1',
      code: 'code-1',
    });

    expect(result.statusCode).toBe(403);
    expect(result.body.ok ? null : result.body.error).toMatchObject({
      code: 'forbidden',
      message: 'OAuth state is not available for this user.',
    });
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });

  it('rejects OpenAI Codex OAuth polling for a state owned by another user', async () => {
    oauthStateRows.push({
      id: '22222222-2222-4222-8222-222222222222',
      scope: 'user',
      user_id: OTHER_USER_ID,
      workspace_id: null,
      flow_kind: 'device_code',
      code_verifier: null,
      device_auth_id: 'device-auth-1',
      user_code: 'USER-CODE',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      consumed_at: null,
    });

    const result = await pollOpenAiCodexOauthRoute(AUTH, {
      state: 'state-2',
    });

    expect(result.statusCode).toBe(403);
    expect(result.body.ok ? null : result.body.error).toMatchObject({
      code: 'forbidden',
      message: 'OAuth state is not available for this user.',
    });
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });
});
