import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { RegisteredAgentRecord } from '../db/agent-accessors.js';
import {
  closePgDatabase,
  deleteAuthUsers,
  getDbPg,
  initPgDatabase,
  purgeUserData,
  seedAuthUser,
  withUserContext,
} from '../db/test-helpers.js';
import { encryptProviderSecret } from '../llm/provider-secret-store.js';
import { ensureWorkspaceBootstrapForUser } from '../workspaces/bootstrap.js';
import { TALK_EXECUTOR_ANTHROPIC_API_KEY } from '../config.js';
import {
  getAnthropicApiKeyFromDb,
  getProviderVerificationStatus,
} from './execution-planner.js';
import {
  isAnthropicDirectHttpReady,
  resolveCredentialKindSnapshot,
  resolveExecution,
} from './execution-resolver.js';

const TEST_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54432/postgres';
const USER_ID = '0c909090-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_USER_ID = '0c909090-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const PROVIDER_ID = 'provider.anthropic';

function makeAgent(
  overrides: Partial<RegisteredAgentRecord> = {},
): RegisteredAgentRecord {
  return {
    id: '0c909090-1111-4111-8111-111111111111',
    owner_id: USER_ID,
    name: 'Workspace Claude',
    provider_id: PROVIDER_ID,
    model_id: 'claude-sonnet-4-5',
    persona_role: null,
    system_prompt: null,
    description: null,
    enabled: true,
    credential_mode: null,
    model_auto_upgraded_from: null,
    model_auto_upgraded_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('execution resolver credential snapshots', () => {
  beforeAll(async () => {
    await initPgDatabase({ url: TEST_DB_URL });
    await seedAuthUser({
      id: USER_ID,
      email: 'execution-resolver@clawtalk.local',
    });
    await seedAuthUser({
      id: OTHER_USER_ID,
      email: 'execution-resolver-other@clawtalk.local',
    });
  });

  beforeEach(async () => {
    await purgeUserData([USER_ID, OTHER_USER_ID]);
  });

  afterAll(async () => {
    await deleteAuthUsers([USER_ID, OTHER_USER_ID]);
    await closePgDatabase();
  });

  it('snapshots workspace-shared credentials from an explicit workspace scope', async () => {
    const workspaceId = await ensureWorkspaceBootstrapForUser(USER_ID);
    const db = getDbPg();
    await db`
      insert into public.workspace_provider_secrets (
        workspace_id, provider_id, credential_kind, ciphertext, updated_by
      )
      values (
        ${workspaceId}::uuid, ${PROVIDER_ID}, 'api_key', 'encrypted-key',
        ${USER_ID}::uuid
      )
    `;

    const snapshot = await withUserContext(USER_ID, () =>
      resolveCredentialKindSnapshot(makeAgent(), {
        principalUserId: USER_ID,
        workspaceId,
      }),
    );

    expect(snapshot).toBe('api_key');
  });

  it('does not snapshot workspace credentials without an explicit workspace scope', async () => {
    const workspaceId = await ensureWorkspaceBootstrapForUser(USER_ID);
    const db = getDbPg();
    await db`
      insert into public.workspace_provider_secrets (
        workspace_id, provider_id, credential_kind, ciphertext, updated_by
      )
      values (
        ${workspaceId}::uuid, ${PROVIDER_ID}, 'api_key', 'encrypted-key',
        ${USER_ID}::uuid
      )
    `;

    const snapshot = await withUserContext(USER_ID, () =>
      resolveCredentialKindSnapshot(makeAgent(), {
        principalUserId: USER_ID,
        workspaceId: null,
      }),
    );

    expect(snapshot).toBeNull();
  });

  it('snapshots only the explicit principal personal credential', async () => {
    const db = getDbPg();
    await db`
      insert into public.llm_provider_secrets (
        owner_id, provider_id, credential_kind, ciphertext
      )
      values
        (${USER_ID}::uuid, ${PROVIDER_ID}, 'api_key', 'user-key'),
        (${OTHER_USER_ID}::uuid, ${PROVIDER_ID}, 'api_key', 'other-key')
    `;

    await expect(
      resolveCredentialKindSnapshot(makeAgent(), {
        principalUserId: USER_ID,
        workspaceId: null,
      }),
    ).resolves.toBe('api_key');
    await expect(
      resolveCredentialKindSnapshot(makeAgent(), {
        principalUserId: null,
        workspaceId: null,
      }),
    ).resolves.toBeNull();
  });

  it('resolves only the explicit principal personal provider secret', async () => {
    const userCiphertext = await encryptProviderSecret({
      apiKey: 'sk-openai-user',
    });
    const otherCiphertext = await encryptProviderSecret({
      apiKey: 'sk-openai-other',
    });
    const db = getDbPg();
    await db`
      insert into public.llm_provider_secrets (
        owner_id, provider_id, credential_kind, ciphertext
      )
      values
        (${USER_ID}::uuid, ${'provider.openai'}, 'api_key', ${userCiphertext}),
        (${OTHER_USER_ID}::uuid, ${'provider.openai'}, 'api_key', ${otherCiphertext})
    `;
    const openAiAgent = makeAgent({
      provider_id: 'provider.openai',
      model_id: 'gpt-5-mini',
    });

    await expect(
      resolveExecution(openAiAgent, {
        credentialScope: { principalUserId: USER_ID, workspaceId: null },
      }),
    ).resolves.toMatchObject({
      secret: { apiKey: 'sk-openai-user', credentialKind: 'api_key' },
    });
    await expect(
      resolveExecution(openAiAgent, {
        credentialScope: { principalUserId: null, workspaceId: null },
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_SECRET_MISSING' });
  });

  it('reads workspace-shared Anthropic API keys from an explicit workspace scope', async () => {
    const workspaceId = await ensureWorkspaceBootstrapForUser(USER_ID);
    const ciphertext = await encryptProviderSecret({
      apiKey: 'sk-workspace-anthropic',
    });
    const db = getDbPg();
    await db`
      insert into public.workspace_provider_secrets (
        workspace_id, provider_id, credential_kind, ciphertext, updated_by
      )
      values (
        ${workspaceId}::uuid, ${PROVIDER_ID}, 'api_key', ${ciphertext},
        ${USER_ID}::uuid
      )
    `;

    const apiKey = await withUserContext(USER_ID, () =>
      getAnthropicApiKeyFromDb({ principalUserId: USER_ID, workspaceId }),
    );

    expect(apiKey).toBe('sk-workspace-anthropic');
  });

  it('reads only the explicit principal personal Anthropic API key', async () => {
    const userCiphertext = await encryptProviderSecret({
      apiKey: 'sk-user-anthropic',
    });
    const otherCiphertext = await encryptProviderSecret({
      apiKey: 'sk-other-anthropic',
    });
    const db = getDbPg();
    await db`
      insert into public.llm_provider_secrets (
        owner_id, provider_id, credential_kind, ciphertext
      )
      values
        (${USER_ID}::uuid, ${PROVIDER_ID}, 'api_key', ${userCiphertext}),
        (${OTHER_USER_ID}::uuid, ${PROVIDER_ID}, 'api_key', ${otherCiphertext})
    `;

    await expect(
      getAnthropicApiKeyFromDb({
        principalUserId: USER_ID,
        workspaceId: null,
      }),
    ).resolves.toBe('sk-user-anthropic');
    await expect(
      getAnthropicApiKeyFromDb({
        principalUserId: OTHER_USER_ID,
        workspaceId: null,
      }),
    ).resolves.toBe('sk-other-anthropic');
    await expect(
      getAnthropicApiKeyFromDb({
        principalUserId: null,
        workspaceId: null,
      }),
    ).resolves.toBeNull();
  });

  it('reads provider verification only for the explicit personal API-key credential', async () => {
    const db = getDbPg();
    await db`
      insert into public.llm_provider_secrets (
        owner_id, provider_id, credential_kind, ciphertext
      )
      values
        (${USER_ID}::uuid, ${PROVIDER_ID}, 'api_key', 'user-key'),
        (${OTHER_USER_ID}::uuid, ${PROVIDER_ID}, 'api_key', 'other-key')
    `;
    await db`
      insert into public.llm_provider_verifications (
        owner_id, provider_id, credential_kind, status
      )
      values
        (${USER_ID}::uuid, ${PROVIDER_ID}, 'api_key', 'invalid'),
        (${OTHER_USER_ID}::uuid, ${PROVIDER_ID}, 'api_key', 'verified')
    `;

    await expect(
      getProviderVerificationStatus(PROVIDER_ID, {
        principalUserId: USER_ID,
        workspaceId: null,
      }),
    ).resolves.toBe('invalid');
    await expect(
      getProviderVerificationStatus(PROVIDER_ID, {
        principalUserId: OTHER_USER_ID,
        workspaceId: null,
      }),
    ).resolves.toBe('verified');
    await expect(
      getProviderVerificationStatus(PROVIDER_ID, {
        principalUserId: null,
        workspaceId: null,
      }),
    ).resolves.toBeNull();
  });

  it('reads workspace provider verification only from an explicit workspace scope', async () => {
    const workspaceId = await ensureWorkspaceBootstrapForUser(USER_ID);
    const otherWorkspaceId =
      await ensureWorkspaceBootstrapForUser(OTHER_USER_ID);
    const db = getDbPg();
    await db`
      insert into public.workspace_provider_secrets (
        workspace_id, provider_id, credential_kind, ciphertext, updated_by
      )
      values
        (
          ${workspaceId}::uuid, ${PROVIDER_ID}, 'api_key',
          'workspace-key', ${USER_ID}::uuid
        ),
        (
          ${otherWorkspaceId}::uuid, ${PROVIDER_ID}, 'api_key',
          'other-workspace-key', ${OTHER_USER_ID}::uuid
        )
    `;
    await db`
      insert into public.workspace_provider_verifications (
        workspace_id, provider_id, credential_kind, status
      )
      values
        (${workspaceId}::uuid, ${PROVIDER_ID}, 'api_key', 'verified'),
        (${otherWorkspaceId}::uuid, ${PROVIDER_ID}, 'api_key', 'invalid')
    `;

    await expect(
      getProviderVerificationStatus(PROVIDER_ID, {
        principalUserId: null,
        workspaceId,
      }),
    ).resolves.toBe('verified');
    await expect(
      getProviderVerificationStatus(PROVIDER_ID, {
        principalUserId: null,
        workspaceId: otherWorkspaceId,
      }),
    ).resolves.toBe('invalid');
    await expect(
      getProviderVerificationStatus(PROVIDER_ID, {
        principalUserId: null,
        workspaceId: null,
      }),
    ).resolves.toBeNull();
  });

  it('does not use workspace verification when a personal API key would shadow it', async () => {
    const workspaceId = await ensureWorkspaceBootstrapForUser(USER_ID);
    const db = getDbPg();
    await db`
      insert into public.llm_provider_secrets (
        owner_id, provider_id, credential_kind, ciphertext
      )
      values (${USER_ID}::uuid, ${PROVIDER_ID}, 'api_key', 'user-key')
    `;
    await db`
      insert into public.workspace_provider_secrets (
        workspace_id, provider_id, credential_kind, ciphertext, updated_by
      )
      values (
        ${workspaceId}::uuid, ${PROVIDER_ID}, 'api_key', 'workspace-key',
        ${USER_ID}::uuid
      )
    `;
    await db`
      insert into public.workspace_provider_verifications (
        workspace_id, provider_id, credential_kind, status
      )
      values (${workspaceId}::uuid, ${PROVIDER_ID}, 'api_key', 'verified')
    `;

    await expect(
      getProviderVerificationStatus(PROVIDER_ID, {
        principalUserId: USER_ID,
        workspaceId,
      }),
    ).resolves.toBeNull();
  });

  it('does not treat Anthropic subscription credentials as API keys', async () => {
    const workspaceId = await ensureWorkspaceBootstrapForUser(USER_ID);
    const personalSubscriptionCiphertext = await encryptProviderSecret({
      apiKey: 'oauth-user-token',
    });
    const workspaceSubscriptionCiphertext = await encryptProviderSecret({
      apiKey: 'oauth-workspace-token',
    });
    const db = getDbPg();
    await db`
      insert into public.llm_provider_secrets (
        owner_id, provider_id, credential_kind, ciphertext
      )
      values (
        ${USER_ID}::uuid,
        ${PROVIDER_ID},
        'subscription',
        ${personalSubscriptionCiphertext}
      )
    `;
    await db`
      insert into public.workspace_provider_secrets (
        workspace_id, provider_id, credential_kind, ciphertext, updated_by
      )
      values (
        ${workspaceId}::uuid,
        ${PROVIDER_ID},
        'subscription',
        ${workspaceSubscriptionCiphertext},
        ${USER_ID}::uuid
      )
    `;

    await expect(
      getAnthropicApiKeyFromDb({ principalUserId: USER_ID, workspaceId }),
    ).resolves.toBeNull();
  });

  it('does not treat Anthropic subscription credentials as direct HTTP readiness', async () => {
    if (TALK_EXECUTOR_ANTHROPIC_API_KEY) return;
    const workspaceId = await ensureWorkspaceBootstrapForUser(USER_ID);
    const db = getDbPg();
    await db`
      insert into public.llm_provider_secrets (
        owner_id, provider_id, credential_kind, ciphertext
      )
      values (
        ${USER_ID}::uuid,
        ${PROVIDER_ID},
        'subscription',
        'subscription-user-secret'
      )
    `;
    await db`
      insert into public.workspace_provider_secrets (
        workspace_id, provider_id, credential_kind, ciphertext, updated_by
      )
      values (
        ${workspaceId}::uuid,
        ${PROVIDER_ID},
        'subscription',
        'subscription-workspace-secret',
        ${USER_ID}::uuid
      )
    `;

    await expect(
      isAnthropicDirectHttpReady({ principalUserId: USER_ID, workspaceId }),
    ).resolves.toBe(false);
  });

  it('checks Anthropic direct readiness only for the explicit principal personal key', async () => {
    if (TALK_EXECUTOR_ANTHROPIC_API_KEY) return;
    const db = getDbPg();
    await db`
      insert into public.llm_provider_secrets (
        owner_id, provider_id, credential_kind, ciphertext
      )
      values
        (${USER_ID}::uuid, ${PROVIDER_ID}, 'api_key', 'user-key'),
        (${OTHER_USER_ID}::uuid, ${PROVIDER_ID}, 'api_key', 'other-key')
    `;

    await expect(
      isAnthropicDirectHttpReady({
        principalUserId: USER_ID,
        workspaceId: null,
      }),
    ).resolves.toBe(true);
    await expect(
      isAnthropicDirectHttpReady({
        principalUserId: null,
        workspaceId: null,
      }),
    ).resolves.toBe(false);
  });

  it('does not read workspace-shared Anthropic keys without an explicit workspace scope', async () => {
    const workspaceId = await ensureWorkspaceBootstrapForUser(USER_ID);
    const ciphertext = await encryptProviderSecret({
      apiKey: 'sk-workspace-anthropic',
    });
    const db = getDbPg();
    await db`
      insert into public.workspace_provider_secrets (
        workspace_id, provider_id, credential_kind, ciphertext, updated_by
      )
      values (
        ${workspaceId}::uuid, ${PROVIDER_ID}, 'api_key', ${ciphertext},
        ${USER_ID}::uuid
      )
    `;

    const apiKey = await withUserContext(USER_ID, () =>
      getAnthropicApiKeyFromDb({
        principalUserId: USER_ID,
        workspaceId: null,
      }),
    );

    expect(apiKey).toBeNull();
  });
});
