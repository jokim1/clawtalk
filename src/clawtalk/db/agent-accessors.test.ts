import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closePgDatabase,
  deleteAuthUsers,
  getDbPg,
  initPgDatabase,
  purgeUserData,
  seedAuthUser,
  seedLlmProvider,
  seedTalk,
  withUserContext,
} from './test-helpers.js';
import { ensureWorkspaceBootstrapForUser } from '../workspaces/bootstrap.js';
import {
  autoUpgradeAgentModel,
  autoUpgradeAgentModelOutsideTx,
  clearAgentModelUpgradeNotice,
  createRegisteredAgent,
  deleteRegisteredAgent,
  getEffectiveToolsForAgent,
  getFallbackSteps,
  getRegisteredAgent,
  getRegisteredAgentSnapshot,
  getUserToolPermission,
  listEnabledAgents,
  listRegisteredAgents,
  listUserToolPermissions,
  setFallbackSteps,
  TOOL_FAMILY_MAP,
  updateRegisteredAgent,
  upsertUserToolPermission,
} from './agent-accessors.js';

const USER_ID = '0c111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_USER_ID = '0c111111-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const TALK_ID = '0c111111-cccc-cccc-cccc-cccccccccccc';
const FALLBACK_PROVIDER_ID = 'test.fallback-provider';
const FALLBACK_MODEL_ID = 'test.fallback-model';

describe('agent-accessors greenfield compatibility', () => {
  beforeAll(async () => {
    await initPgDatabase();
    await seedAuthUser({
      id: USER_ID,
      email: 'agent-accessors@clawtalk.local',
    });
    await seedAuthUser({
      id: OTHER_USER_ID,
      email: 'agent-accessors-other@clawtalk.local',
    });
    await seedLlmProvider({
      id: FALLBACK_PROVIDER_ID,
      modelId: FALLBACK_MODEL_ID,
      displayName: 'Test Fallback Provider',
    });
  });

  beforeEach(async () => {
    await purgeUserData([USER_ID, OTHER_USER_ID]);
  });

  afterAll(async () => {
    const db = getDbPg();
    await purgeUserData([USER_ID, OTHER_USER_ID]);
    await db`
      delete from public.llm_provider_models
      where provider_id = ${FALLBACK_PROVIDER_ID}
    `;
    await db`
      delete from public.llm_providers
      where id = ${FALLBACK_PROVIDER_ID}
    `;
    await deleteAuthUsers([USER_ID, OTHER_USER_ID]);
    await closePgDatabase();
  });

  it('creates workspace agents in final public.agents while preserving the compatibility record shape', async () => {
    const workspaceId = await ensureWorkspaceBootstrapForUser(USER_ID);

    const agent = await withUserContext(USER_ID, () =>
      createRegisteredAgent({
        ownerId: USER_ID,
        workspaceId,
        name: 'Research Analyst',
        providerId: 'provider.anthropic',
        modelId: 'claude-opus-4-7',
        personaRole: 'researcher',
      }),
    );

    expect(agent).toMatchObject({
      owner_id: USER_ID,
      name: 'Research Analyst',
      provider_id: 'provider.anthropic',
      model_id: 'claude-opus-4-7',
      persona_role: 'researcher',
      enabled: true,
    });

    const rows = await getDbPg()<
      Array<{ workspace_id: string; role_key: string; is_custom: boolean }>
    >`
      select workspace_id::text as workspace_id, role_key, is_custom
      from public.agents
      where id = ${agent.id}::uuid
    `;
    expect(rows[0]).toEqual({
      workspace_id: workspaceId,
      role_key: 'researcher',
      is_custom: true,
    });
  });

  it('round-trips active CRUD, list, snapshot, and delete accessors', async () => {
    const workspaceId = await ensureWorkspaceBootstrapForUser(USER_ID);

    await withUserContext(USER_ID, async () => {
      const agent = await createRegisteredAgent({
        ownerId: USER_ID,
        workspaceId,
        name: 'Lifecycle Analyst',
        providerId: 'provider.anthropic',
        modelId: 'claude-opus-4-7',
        personaRole: 'researcher',
        systemPrompt: 'Analyze trends.',
        description: 'Cites sources for every claim.',
      });

      expect((await getRegisteredAgent(agent.id, workspaceId))?.id).toBe(
        agent.id,
      );
      expect((await getRegisteredAgentSnapshot(agent.id))?.personaRole).toBe(
        'researcher',
      );
      expect(
        (await listRegisteredAgents(workspaceId)).map((item) => item.id),
      ).toContain(agent.id);
      expect((await listEnabledAgents()).map((item) => item.id)).toContain(
        agent.id,
      );

      const updated = await updateRegisteredAgent(
        agent.id,
        {
          name: 'Lifecycle Analyst Renamed',
          description: null,
          enabled: false,
        },
        workspaceId,
      );
      expect(updated).toMatchObject({
        id: agent.id,
        name: 'Lifecycle Analyst Renamed',
        description: null,
        enabled: false,
      });
      expect((await listEnabledAgents()).map((item) => item.id)).not.toContain(
        agent.id,
      );

      expect(await deleteRegisteredAgent(agent.id, workspaceId)).toBe(true);
      expect(await getRegisteredAgent(agent.id, workspaceId)).toBeUndefined();
      expect(await deleteRegisteredAgent(agent.id, workspaceId)).toBe(false);
    });
  });

  it('tracks and clears model auto-upgrade notices', async () => {
    const workspaceId = await ensureWorkspaceBootstrapForUser(USER_ID);

    await withUserContext(USER_ID, async () => {
      const agent = await createRegisteredAgent({
        ownerId: USER_ID,
        workspaceId,
        name: 'Upgrade Analyst',
        providerId: 'provider.anthropic',
        modelId: 'claude-opus-4-7',
      });

      const upgraded = await autoUpgradeAgentModel(
        agent.id,
        'claude-opus-4-7',
        'claude-opus-4-8',
      );
      expect(upgraded).toMatchObject({
        id: agent.id,
        model_id: 'claude-opus-4-8',
        model_auto_upgraded_from: 'claude-opus-4-7',
      });
      expect(upgraded?.model_auto_upgraded_at).toBeTruthy();

      expect(
        await autoUpgradeAgentModel(
          agent.id,
          'claude-opus-4-7',
          'claude-opus-4-8',
        ),
      ).toBeUndefined();
      expect(await clearAgentModelUpgradeNotice(agent.id, workspaceId)).toBe(
        true,
      );
      expect(
        (await getRegisteredAgent(agent.id, workspaceId))
          ?.model_auto_upgraded_from,
      ).toBeNull();
      expect(await clearAgentModelUpgradeNotice(agent.id, workspaceId)).toBe(
        false,
      );
    });
  });

  it('auto-upgrades committed agents outside the request transaction', async () => {
    const workspaceId = await ensureWorkspaceBootstrapForUser(USER_ID);
    const agentId = await withUserContext(USER_ID, async () => {
      const agent = await createRegisteredAgent({
        ownerId: USER_ID,
        workspaceId,
        name: 'Out-of-band Upgrade Analyst',
        providerId: 'provider.anthropic',
        modelId: 'claude-opus-4-7',
      });
      return agent.id;
    });

    expect(
      await autoUpgradeAgentModelOutsideTx(
        agentId,
        'provider.openai',
        'claude-opus-4-7',
        'claude-opus-4-8',
      ),
    ).toBeUndefined();

    const upgraded = await autoUpgradeAgentModelOutsideTx(
      agentId,
      'provider.anthropic',
      'claude-opus-4-7',
      'claude-opus-4-8',
    );
    expect(upgraded).toMatchObject({
      id: agentId,
      model_id: 'claude-opus-4-8',
      model_auto_upgraded_from: 'claude-opus-4-7',
    });
    expect(upgraded?.model_auto_upgraded_at).toBeTruthy();

    expect(
      await autoUpgradeAgentModelOutsideTx(
        agentId,
        'provider.anthropic',
        'claude-opus-4-7',
        'claude-opus-4-8',
      ),
    ).toBeUndefined();

    const persisted = await withUserContext(USER_ID, () =>
      getRegisteredAgent(agentId, workspaceId),
    );
    expect(persisted?.model_id).toBe('claude-opus-4-8');
  });

  it('treats retired fallback-step reads as empty and writes as unavailable', async () => {
    const workspaceId = await ensureWorkspaceBootstrapForUser(USER_ID);
    const agent = await withUserContext(USER_ID, () =>
      createRegisteredAgent({
        ownerId: USER_ID,
        workspaceId,
        name: 'Fallback Analyst',
        providerId: 'provider.anthropic',
        modelId: 'claude-opus-4-7',
      }),
    );

    await withUserContext(USER_ID, async () => {
      expect(await getFallbackSteps(agent.id)).toEqual([]);
      await expect(
        setFallbackSteps({
          ownerId: USER_ID,
          agentId: agent.id,
          steps: [
            { providerId: FALLBACK_PROVIDER_ID, modelId: FALLBACK_MODEL_ID },
          ],
        }),
      ).rejects.toThrow('legacy_agent_fallback_steps_not_available');
      expect(await getFallbackSteps(agent.id)).toEqual([]);
    });
  });

  it('upserts and lists user tool permissions under caller RLS', async () => {
    await withUserContext(USER_ID, async () => {
      await upsertUserToolPermission({
        userId: USER_ID,
        toolId: 'web_search',
        allowed: false,
        requiresApproval: true,
      });
      expect(await getUserToolPermission('web_search')).toEqual({
        toolId: 'web_search',
        allowed: false,
        requiresApproval: true,
      });

      await upsertUserToolPermission({
        userId: USER_ID,
        toolId: 'web_search',
        allowed: true,
        requiresApproval: false,
      });
      expect(await listUserToolPermissions()).toEqual([
        {
          toolId: 'web_search',
          allowed: true,
          requiresApproval: false,
        },
      ]);
    });

    await withUserContext(OTHER_USER_ID, async () => {
      await upsertUserToolPermission({
        userId: OTHER_USER_ID,
        toolId: 'gmail_read',
        allowed: false,
        requiresApproval: false,
      });
      expect(
        (await listUserToolPermissions()).map((item) => item.toolId),
      ).toEqual(['gmail_read']);
    });

    await withUserContext(USER_ID, async () => {
      expect(
        (await listUserToolPermissions()).map((item) => item.toolId),
      ).toEqual(['web_search']);
    });
  });

  it('enforces cross-user RLS isolation for greenfield public.agents', async () => {
    const workspaceId = await ensureWorkspaceBootstrapForUser(USER_ID);
    const otherWorkspaceId =
      await ensureWorkspaceBootstrapForUser(OTHER_USER_ID);
    const agent = await withUserContext(USER_ID, () =>
      createRegisteredAgent({
        ownerId: USER_ID,
        workspaceId,
        name: 'Private Analyst',
        providerId: 'provider.anthropic',
        modelId: 'claude-opus-4-7',
      }),
    );

    await withUserContext(OTHER_USER_ID, async () => {
      expect(await getRegisteredAgent(agent.id, workspaceId)).toBeUndefined();
      expect(
        (await listRegisteredAgents(workspaceId)).map((item) => item.id),
      ).not.toContain(agent.id);

      const visibleRows = await getDbPg()<Array<{ id: string }>>`
        select id::text as id
        from public.agents
        where id = ${agent.id}::uuid
      `;
      expect(visibleRows).toEqual([]);

      const updated = await updateRegisteredAgent(
        agent.id,
        { name: 'Cross-user overwrite' },
        workspaceId,
      );
      expect(updated).toBeUndefined();
    });

    await expect(
      withUserContext(OTHER_USER_ID, () =>
        createRegisteredAgent({
          ownerId: USER_ID,
          workspaceId,
          name: 'Foreign Workspace Agent',
          providerId: 'provider.anthropic',
          modelId: 'claude-opus-4-7',
        }),
      ),
    ).rejects.toThrow();

    await expect(
      withUserContext(OTHER_USER_ID, () =>
        createRegisteredAgent({
          ownerId: OTHER_USER_ID,
          workspaceId: otherWorkspaceId,
          name: 'Own Workspace Agent',
          providerId: 'provider.anthropic',
          modelId: 'claude-opus-4-7',
        }),
      ),
    ).resolves.toMatchObject({
      owner_id: OTHER_USER_ID,
      name: 'Own Workspace Agent',
    });
  });

  it('resolves effective tools from greenfield talk_tools rows', async () => {
    const workspaceId = await ensureWorkspaceBootstrapForUser(USER_ID);
    await seedTalk({ ownerId: USER_ID, talkId: TALK_ID });
    const agent = await withUserContext(USER_ID, () =>
      createRegisteredAgent({
        ownerId: USER_ID,
        workspaceId,
        name: 'Tool Agent',
        providerId: 'provider.nvidia',
        modelId: 'moonshotai/kimi-k2.6',
      }),
    );

    await getDbPg()`
      insert into public.talk_tools (workspace_id, talk_id, tool_id, enabled)
      values
        (${workspaceId}::uuid, ${TALK_ID}::uuid, 'web-search', true),
        (${workspaceId}::uuid, ${TALK_ID}::uuid, 'web-fetch', true),
        (${workspaceId}::uuid, ${TALK_ID}::uuid, 'gdrive-read', false),
        (${workspaceId}::uuid, ${TALK_ID}::uuid, 'messaging', true),
        (${workspaceId}::uuid, ${TALK_ID}::uuid, 'shell', true),
        (${workspaceId}::uuid, ${TALK_ID}::uuid, 'filesystem', true),
        (${workspaceId}::uuid, ${TALK_ID}::uuid, 'browser', true)
      on conflict (talk_id, tool_id) do update
        set enabled = excluded.enabled
    `;

    const effective = await withUserContext(USER_ID, () =>
      getEffectiveToolsForAgent(agent.id, { talkId: TALK_ID }),
    );

    expect(effective.map((tool) => tool.toolFamily).sort()).toEqual(
      Object.keys(TOOL_FAMILY_MAP).sort(),
    );
    expect(effective.find((tool) => tool.toolFamily === 'web')).toMatchObject({
      enabled: true,
      runtimeTools: expect.arrayContaining(['web_search']),
    });
    expect(
      effective.find((tool) => tool.toolFamily === 'google_read'),
    ).toMatchObject({ enabled: false });
    expect(
      effective.find((tool) => tool.toolFamily === 'messaging'),
    ).toMatchObject({ enabled: true });
    for (const heavy of ['shell', 'filesystem', 'browser']) {
      expect(effective.find((tool) => tool.toolFamily === heavy)?.enabled).toBe(
        false,
      );
    }
  });

  it('uses activeFamilies snapshots over live talk rows for queued runs', async () => {
    const workspaceId = await ensureWorkspaceBootstrapForUser(USER_ID);
    await seedTalk({ ownerId: USER_ID, talkId: TALK_ID });
    const agent = await withUserContext(USER_ID, () =>
      createRegisteredAgent({
        ownerId: USER_ID,
        workspaceId,
        name: 'Snapshot Agent',
        providerId: 'provider.anthropic',
        modelId: 'claude-opus-4-7',
      }),
    );
    await getDbPg()`
      insert into public.talk_tools (workspace_id, talk_id, tool_id, enabled)
      values (${workspaceId}::uuid, ${TALK_ID}::uuid, 'web-search', true)
      on conflict (talk_id, tool_id) do update
        set enabled = excluded.enabled
    `;

    const effective = await withUserContext(USER_ID, () =>
      getEffectiveToolsForAgent(agent.id, {
        talkId: TALK_ID,
        activeFamilies: {
          web: false,
          google_read: true,
          shell: true,
          filesystem: true,
          browser: true,
        },
      }),
    );

    expect(effective.find((tool) => tool.toolFamily === 'web')?.enabled).toBe(
      false,
    );
    expect(
      effective.find((tool) => tool.toolFamily === 'google_read')?.enabled,
    ).toBe(true);
    for (const heavy of ['shell', 'filesystem', 'browser']) {
      expect(effective.find((tool) => tool.toolFamily === heavy)?.enabled).toBe(
        false,
      );
    }
  });
});
