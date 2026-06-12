import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const runWebSearchForUserMock = vi.hoisted(() => vi.fn());

vi.mock('../agents/agent-router.js', () => ({
  executeWithResolvedAgent: vi.fn(),
}));
vi.mock('./attachment-storage.js', () => ({
  loadPageImage: vi.fn(),
}));
vi.mock('../web-search/registry.js', () => ({
  runWebSearchForUser: runWebSearchForUserMock,
}));

import {
  closePgDatabase,
  getCurrentUserId,
  getDbPg,
  initPgDatabase,
} from '../../db.js';
import { executeWithResolvedAgent } from '../agents/agent-router.js';
import type { LlmContentBlock, LlmMessage } from '../agents/llm-client.js';
import { ensureWorkspaceBootstrapForUser } from '../workspaces/bootstrap.js';
import { loadPageImage } from './attachment-storage.js';
import {
  createGreenfieldTalk,
  listDefaultTalkAgentIds,
} from './greenfield-accessors.js';
import { enqueueGreenfieldChatTurn } from './greenfield-chat-accessors.js';
import {
  createGreenfieldDocumentForTalk,
  getGreenfieldDocumentForTalk,
  replaceGreenfieldDocumentBlocks,
} from './greenfield-detail-accessors.js';
import {
  createGreenfieldJob,
  createGreenfieldJobRunNow,
} from './greenfield-job-accessors.js';
import {
  buildGreenfieldStepUserMessageText,
  raceToolCallDeadline,
} from './greenfield-executor.js';
import { processTalkRunMessage } from './queue-consumer.js';

const USER_ID = '0c787878-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

async function seedAuthUser(): Promise<void> {
  const db = getDbPg();
  await db`
    insert into auth.users (id, email, raw_user_meta_data)
    values (
      ${USER_ID}::uuid,
      'greenfield-executor@clawtalk.local',
      jsonb_build_object('full_name', 'Executor User')
    )
    on conflict (id) do update set
      email = excluded.email,
      raw_user_meta_data = excluded.raw_user_meta_data
  `;
}

async function deleteUser(): Promise<void> {
  const db = getDbPg();
  await db`
    delete from public.event_outbox
    where topic like 'talk:%'
       or topic like 'user:%'
  `;
  await db`delete from public.workspaces where owner_id = ${USER_ID}::uuid`;
  await db`delete from auth.users where id = ${USER_ID}::uuid`;
}

async function createTalkFixture(options?: {
  agentCount?: number;
  mode?: 'ordered' | 'parallel';
}): Promise<{
  workspaceId: string;
  talkId: string;
  agentIds: string[];
}> {
  const workspaceId = await ensureWorkspaceBootstrapForUser(USER_ID);
  const agentIds = (await listDefaultTalkAgentIds({ workspaceId })).slice(
    0,
    options?.agentCount ?? 1,
  );
  const talk = await createGreenfieldTalk({
    workspaceId,
    createdBy: USER_ID,
    title: 'Executor Talk',
    mode: options?.mode ?? 'ordered',
    roundsLimit: 3,
    agentIds,
  });
  return { workspaceId, talkId: talk.id, agentIds };
}

async function seedWorkspaceProviderSecret(
  workspaceId: string,
  credentialKind: 'api_key' | 'subscription' = 'api_key',
): Promise<void> {
  const db = getDbPg();
  await db`
    insert into public.workspace_provider_secrets (
      workspace_id, provider_id, credential_kind, ciphertext, updated_by
    )
    values (
      ${workspaceId}::uuid, 'provider.anthropic', ${credentialKind},
      'greenfield-executor-test-secret', ${USER_ID}::uuid
    )
    on conflict (workspace_id, provider_id, credential_kind) do update set
      ciphertext = excluded.ciphertext,
      updated_by = excluded.updated_by,
      updated_at = now()
  `;
}

function mockResolvedExecution(
  content: string,
  mockOptions?: {
    onExecute?: (
      executeToolCall: NonNullable<
        Parameters<typeof executeWithResolvedAgent>[3]['executeToolCall']
      >,
    ) => Promise<void>;
    providerData?: {
      codexReasoningItems?: Array<Record<string, unknown>>;
      codexMessageItems?: Array<Record<string, unknown>>;
    };
    providerId?: string;
    modelId?: string;
    startedProviderId?: string;
    startedModelId?: string;
  },
): {
  calls: Array<{
    agent: {
      id: string;
      system_prompt: string | null;
      model_id: string;
      credential_mode: 'api_key' | 'subscription' | null;
    };
    context: {
      systemPrompt: string;
      contextToolNames: string[];
      connectorToolNames: string[];
    };
    history: LlmMessage[];
    userMessage: string | LlmContentBlock[];
    effectiveTools: Array<{
      toolFamily: string;
      enabled: boolean;
      runtimeTools: string[];
      requiresApproval: boolean;
    }>;
    hasExecuteToolCall: boolean;
    forceToolUseOnFirstIteration: boolean | undefined;
    credentialKindSnapshot: 'api_key' | 'subscription' | null | undefined;
    credentialScope:
      | { principalUserId?: string | null; workspaceId?: string | null }
      | null
      | undefined;
  }>;
} {
  const calls: ReturnType<typeof mockResolvedExecution>['calls'] = [];
  vi.mocked(executeWithResolvedAgent).mockImplementation(
    async (agent, context, userMessage, options) => {
      calls.push({
        agent: {
          id: agent.id,
          system_prompt: agent.system_prompt,
          model_id: agent.model_id,
          credential_mode: agent.credential_mode,
        },
        context: {
          systemPrompt: context?.systemPrompt ?? '',
          contextToolNames:
            context?.contextTools.map((tool) => tool.name) ?? [],
          connectorToolNames:
            context?.connectorTools.map((tool) => tool.name) ?? [],
        },
        history: context?.history ?? [],
        userMessage,
        effectiveTools: options.effectiveTools ?? [],
        hasExecuteToolCall: typeof options.executeToolCall === 'function',
        forceToolUseOnFirstIteration: options.forceToolUseOnFirstIteration,
        credentialKindSnapshot: options.credentialKindSnapshot,
        credentialScope: options.credentialScope,
      });
      if (options.executeToolCall && mockOptions?.onExecute) {
        await mockOptions.onExecute(options.executeToolCall);
      }
      options.emit?.({
        type: 'started',
        runId: options.runId,
        agentId: agent.id,
        providerId: mockOptions?.startedProviderId ?? agent.provider_id,
        modelId: mockOptions?.startedModelId ?? agent.model_id,
      });
      options.emit?.({ type: 'text_delta', text: content });
      options.emit?.({
        type: 'completed',
        content,
        completion: { completionStatus: 'complete' },
      });
      return {
        content,
        agentId: agent.id,
        providerId: mockOptions?.providerId ?? agent.provider_id,
        modelId: mockOptions?.modelId ?? agent.model_id,
        usage: { inputTokens: 11, outputTokens: 7, estimatedCostUsd: 0 },
        completion: { completionStatus: 'complete' },
        providerData: mockOptions?.providerData,
      };
    },
  );
  return { calls };
}

describe('GreenfieldTalkExecutor queue integration', () => {
  beforeAll(async () => {
    await initPgDatabase();
  });

  beforeEach(async () => {
    vi.mocked(executeWithResolvedAgent).mockReset();
    vi.mocked(loadPageImage).mockReset();
    runWebSearchForUserMock.mockReset();
    await deleteUser();
    await seedAuthUser();
  });

  afterAll(async () => {
    await deleteUser();
    await closePgDatabase();
  });

  it('executes a claimed greenfield run from the frozen snapshot and persists the agent message', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const db = getDbPg();
    await db`
      insert into public.context_sources (
        workspace_id, talk_id, kind, name, extracted_text, meta_json,
        include_in_prompt, sort_order, added_by_user_id
      )
      values
        (
          ${workspaceId}::uuid,
          ${talkId}::uuid,
          'rule',
          'Active whitespace goal',
          '   ',
          ${db.json({ compatKind: 'goal' } as never)},
          true,
          -3,
          ${USER_ID}::uuid
        ),
        (
          ${workspaceId}::uuid,
          ${talkId}::uuid,
          'rule',
          'Active whitespace rule',
          '   ',
          ${db.json({ compatKind: 'rule' } as never)},
          true,
          -2,
          ${USER_ID}::uuid
        ),
        (
          ${workspaceId}::uuid,
          ${talkId}::uuid,
          'rule',
          'Launch rules',
          'Use clear milestones.',
          ${db.json({ compatKind: 'rule' } as never)},
          true,
          -1,
          ${USER_ID}::uuid
        ),
        (
          ${workspaceId}::uuid,
          ${talkId}::uuid,
          'file',
          'Fallback notes',
          'Source fallback should ignore preceding rules.',
          ${db.json({ compatKind: 'source', sourceType: 'text' } as never)},
          true,
          0,
          ${USER_ID}::uuid
        ),
        (
          ${workspaceId}::uuid,
          ${talkId}::uuid,
          'file',
          'Launch notes',
          'Budget is tight.',
          ${db.json({ compatKind: 'source', sourceRef: 'S9', sourceType: 'text' } as never)},
          true,
          1,
          ${USER_ID}::uuid
        )
    `;
    const enqueued = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: 'Plan the launch.',
      targetAgentIds: agentIds,
    });
    if (!enqueued.ok) throw new Error(`enqueue failed: ${enqueued.reason}`);

    const { calls } = mockResolvedExecution('Greenfield answer', {
      providerData: {
        codexReasoningItems: [{ encrypted_content: 'greenfield-ciphertext' }],
        codexMessageItems: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Greenfield answer' }],
          },
        ],
      },
    });
    await processTalkRunMessage({
      runId: enqueued.runs[0]!.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.agent.id).toBe(agentIds[0]);
    expect(calls[0]!.agent.system_prompt).toContain('Role:');
    expect(calls[0]!.context.systemPrompt).toContain(
      'Goal\nActive whitespace goal',
    );
    expect(calls[0]!.context.systemPrompt).toContain(
      'Rule: Active whitespace rule\nActive whitespace rule',
    );
    expect(calls[0]!.context.systemPrompt).toContain('Rule: Launch rules');
    expect(calls[0]!.context.systemPrompt).toContain('Launch rules');
    expect(calls[0]!.context.systemPrompt).toContain('Use clear milestones.');
    const sourceRows = await db<Array<{ id: string; name: string }>>`
      select id::text as id, name
      from public.context_sources
      where workspace_id = ${workspaceId}::uuid
        and talk_id = ${talkId}::uuid
        and kind <> 'rule'
    `;
    const fallbackSourceId = sourceRows.find(
      (row) => row.name === 'Fallback notes',
    )?.id;
    const launchSourceId = sourceRows.find(
      (row) => row.name === 'Launch notes',
    )?.id;
    expect(fallbackSourceId).toBeTruthy();
    expect(launchSourceId).toBeTruthy();
    expect(calls[0]!.context.systemPrompt).toContain(
      `Source ${fallbackSourceId}: Fallback notes (file)`,
    );
    expect(calls[0]!.context.systemPrompt).toContain(
      'Source fallback should ignore preceding rules.',
    );
    expect(calls[0]!.context.systemPrompt).toContain(
      `Source ${launchSourceId}: Launch notes (file)`,
    );
    expect(calls[0]!.context.systemPrompt).not.toContain('Source S9:');
    expect(calls[0]!.context.systemPrompt).toContain('Budget is tight.');
    expect(calls[0]!.userMessage).toBe('Plan the launch.');
    expect(calls[0]!.credentialScope).toEqual({
      principalUserId: USER_ID,
      workspaceId,
    });

    const rows = await db<
      Array<{
        status: string;
        tokens_in: number | null;
        tokens_out: number | null;
        message_body: string | null;
        message_metadata: Record<string, unknown>;
        provider_data: Record<string, unknown> | null;
      }>
    >`
      select
        r.status,
        r.tokens_in,
        r.tokens_out,
        m.body as message_body,
        m.metadata_json as message_metadata,
        mpr.provider_data_json as provider_data
      from public.runs r
      left join public.messages m on m.run_id = r.id
      left join public.message_provider_replay mpr
        on mpr.workspace_id = m.workspace_id
       and mpr.talk_id = m.talk_id
       and mpr.message_id = m.id
      where r.id = ${enqueued.runs[0]!.id}::uuid
    `;
    expect(rows[0]).toMatchObject({
      status: 'completed',
      tokens_in: 11,
      tokens_out: 7,
      message_body: 'Greenfield answer',
      message_metadata: {
        providerId: 'provider.anthropic',
        modelId: expect.any(String),
      },
      provider_data: {
        codexReasoningItems: [{ encrypted_content: 'greenfield-ciphertext' }],
        codexMessageItems: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Greenfield answer' }],
          },
        ],
      },
    });
    expect(rows[0]!.message_metadata).not.toHaveProperty('codexReasoningItems');
    expect(rows[0]!.message_metadata).not.toHaveProperty('codexMessageItems');

    const appendedEvents = await db<
      Array<{ payload: { metadata?: Record<string, unknown> | null } }>
    >`
      select payload
      from public.event_outbox
      where topic = ${`talk:${talkId}`}
        and event_type = 'message_appended'
        and payload->>'runId' = ${enqueued.runs[0]!.id}
      order by event_id desc
      limit 1
    `;
    expect(appendedEvents).toHaveLength(1);
    expect(appendedEvents[0]!.payload.metadata).toMatchObject({
      providerId: 'provider.anthropic',
      modelId: expect.any(String),
    });
    expect(appendedEvents[0]!.payload.metadata).not.toHaveProperty(
      'codexReasoningItems',
    );
    expect(appendedEvents[0]!.payload.metadata).not.toHaveProperty(
      'codexMessageItems',
    );
  });

  it('reads greenfield sources by uppercase raw id when a stored sourceRef exists', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const sourceId = '0c787878-7777-4777-8777-0000000000a1';
    const db = getDbPg();
    await db`
      insert into public.context_sources (
        id, workspace_id, talk_id, kind, name, extracted_text, meta_json,
        include_in_prompt, sort_order, added_by_user_id
      )
      values (
        ${sourceId}::uuid,
        ${workspaceId}::uuid,
        ${talkId}::uuid,
        'file',
        'Stored ref source',
        'Stored ref source body',
        ${db.json({ compatKind: 'source', sourceRef: 'S10', sourceType: 'text' } as never)},
        true,
        0,
        ${USER_ID}::uuid
      )
    `;
    const enqueued = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: 'Read the source.',
      targetAgentIds: agentIds,
    });
    if (!enqueued.ok) throw new Error(`enqueue failed: ${enqueued.reason}`);

    const { calls } = mockResolvedExecution('Source read answer', {
      onExecute: async (executeToolCall) => {
        await expect(
          executeToolCall('read_source', {
            sourceRef: sourceId.toUpperCase(),
          }),
        ).resolves.toEqual({ result: 'Stored ref source body' });
        await expect(
          executeToolCall('read_source', { sourceRef: 's10' }),
        ).resolves.toEqual({ result: 'Stored ref source body' });
      },
    });
    await processTalkRunMessage({
      runId: enqueued.runs[0]!.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });

    expect(calls).toHaveLength(1);
  });

  it('does not read greenfield rules through read_source by raw id', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const ruleId = '0c787878-7777-4777-8777-0000000000a2';
    const db = getDbPg();
    await db`
      insert into public.context_sources (
        id, workspace_id, talk_id, kind, name, extracted_text, meta_json,
        include_in_prompt, sort_order, added_by_user_id
      )
      values (
        ${ruleId}::uuid,
        ${workspaceId}::uuid,
        ${talkId}::uuid,
        'rule',
        'Private rule body',
        'Rules stay in the system prompt, not read_source.',
        ${db.json({ compatKind: 'rule' } as never)},
        true,
        -1,
        ${USER_ID}::uuid
      )
    `;
    const enqueued = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: 'Read the rule as a source.',
      targetAgentIds: agentIds,
    });
    if (!enqueued.ok) throw new Error(`enqueue failed: ${enqueued.reason}`);

    const { calls } = mockResolvedExecution('Rule read unavailable', {
      onExecute: async (executeToolCall) => {
        await expect(
          executeToolCall('read_source', { sourceRef: ruleId }),
        ).resolves.toEqual({
          result: `Source ${ruleId} not found`,
          isError: true,
        });
      },
    });
    await processTalkRunMessage({
      runId: enqueued.runs[0]!.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });

    expect(calls).toHaveLength(1);
  });

  it('does not put pending or unprocessed context sources into the prompt but direct reads report status', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const db = getDbPg();
    await db`
      insert into public.context_sources (
        workspace_id, talk_id, kind, name, extracted_text, meta_json,
        include_in_prompt, sort_order, added_by_user_id
      )
      values (
        ${workspaceId}::uuid,
        ${talkId}::uuid,
        'url',
        'Pending stale URL',
        'Stale URL body',
        ${db.json({
          compatKind: 'source',
          sourceRef: 'S11',
          sourceType: 'url',
          sourceUrl: 'https://example.test/stale',
          mimeType: 'text/plain',
          status: 'pending',
        } as never)},
        true,
        10,
        ${USER_ID}::uuid
      )
    `;
    await db`
      insert into public.context_sources (
        workspace_id, talk_id, kind, name, extracted_text, meta_json,
        include_in_prompt, sort_order, added_by_user_id
      )
      values (
        ${workspaceId}::uuid,
        ${talkId}::uuid,
        'file',
        'No status unprocessed file',
        null,
        ${db.json({
          compatKind: 'source',
          sourceRef: 'S12',
          sourceType: 'file',
          mimeType: 'text/plain',
        } as never)},
        true,
        11,
        ${USER_ID}::uuid
      )
    `;
    const enqueued = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: 'Read the pending source.',
      targetAgentIds: agentIds,
    });
    if (!enqueued.ok) throw new Error(`enqueue failed: ${enqueued.reason}`);

    const { calls } = mockResolvedExecution('Pending source unavailable', {
      onExecute: async (executeToolCall) => {
        await expect(
          executeToolCall('read_source', { sourceRef: 'S11' }),
        ).resolves.toEqual({
          result: 'Source S11 is pending; extracted text is not available yet.',
          isError: true,
        });
        await expect(
          executeToolCall('read_source', { sourceRef: 'S12' }),
        ).resolves.toEqual({
          result: 'Source S12 is pending; extracted text is not available yet.',
          isError: true,
        });
      },
    });
    await processTalkRunMessage({
      runId: enqueued.runs[0]!.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.context.systemPrompt).not.toContain('Pending stale URL');
    expect(calls[0]!.context.systemPrompt).not.toContain('Stale URL body');
    expect(calls[0]!.context.systemPrompt).not.toContain(
      'No status unprocessed file',
    );
    expect(calls[0]!.context.systemPrompt).not.toContain('S12');
  });

  it('reads prompt-visible sources even when earlier unready sources exceed the source cap', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const db = getDbPg();
    await db`
      insert into public.context_sources (
        workspace_id, talk_id, kind, name, extracted_text, meta_json,
        include_in_prompt, sort_order, added_by_user_id
      )
      select
        ${workspaceId}::uuid,
        ${talkId}::uuid,
        'url',
        'Pending early source ' || n::text,
        'Stale early body ' || n::text,
        jsonb_build_object(
          'compatKind', 'source',
          'sourceRef', 'P' || n::text,
          'sourceType', 'url',
          'mimeType', 'text/plain',
          'status', 'pending'
        ),
        true,
        n,
        ${USER_ID}::uuid
      from generate_series(0, 24) as g(n)
    `;
    await db`
      insert into public.context_sources (
        workspace_id, talk_id, kind, name, extracted_text, meta_json,
        include_in_prompt, sort_order, added_by_user_id
      )
      values (
        ${workspaceId}::uuid,
        ${talkId}::uuid,
        'file',
        'Late ready source',
        'Late ready body',
        ${db.json({
          compatKind: 'source',
          sourceRef: 'S77',
          sourceType: 'file',
          mimeType: 'text/plain',
          status: 'ready',
        } as never)},
        true,
        100,
        ${USER_ID}::uuid
      )
    `;
    const lateSources = await db<Array<{ id: string }>>`
      select id::text as id
      from public.context_sources
      where workspace_id = ${workspaceId}::uuid
        and talk_id = ${talkId}::uuid
        and name = 'Late ready source'
      limit 1
    `;
    const lateSourceId = lateSources[0]!.id;
    const enqueued = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: 'Read the late source.',
      targetAgentIds: agentIds,
    });
    if (!enqueued.ok) throw new Error(`enqueue failed: ${enqueued.reason}`);

    const { calls } = mockResolvedExecution('Late source answer', {
      onExecute: async (executeToolCall) => {
        await expect(
          executeToolCall('read_source', { sourceRef: 'S77' }),
        ).resolves.toEqual({ result: 'Late ready body' });
      },
    });
    await processTalkRunMessage({
      runId: enqueued.runs[0]!.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.context.systemPrompt).toContain(
      `Source ${lateSourceId}: Late ready source`,
    );
  });

  it('replays persisted Codex provider data from prior greenfield agent messages', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const first = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: 'Start the thread.',
      targetAgentIds: agentIds,
    });
    if (!first.ok) throw new Error(`enqueue failed: ${first.reason}`);

    mockResolvedExecution('First answer', {
      providerData: {
        codexReasoningItems: [
          { encrypted_content: 'first-turn-ciphertext', summary: [] },
        ],
      },
    });
    await processTalkRunMessage({
      runId: first.runs[0]!.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });

    const second = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: 'Continue.',
      targetAgentIds: agentIds,
    });
    if (!second.ok) throw new Error(`enqueue failed: ${second.reason}`);

    const { calls } = mockResolvedExecution('Second answer');
    await processTalkRunMessage({
      runId: second.runs[0]!.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          providerData: {
            codexReasoningItems: [
              { encrypted_content: 'first-turn-ciphertext', summary: [] },
            ],
          },
        }),
      ]),
    );
  });

  it('persists and emits greenfield provider identity from the frozen snapshot', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const enqueued = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: 'Return mismatched provider metadata.',
      targetAgentIds: agentIds,
    });
    if (!enqueued.ok) throw new Error(`enqueue failed: ${enqueued.reason}`);

    mockResolvedExecution('Mismatched replay answer', {
      providerId: 'provider.mismatched',
      modelId: 'mismatched-model',
      startedProviderId: 'provider.started-mismatch',
      startedModelId: 'started-mismatched-model',
      providerData: {
        codexReasoningItems: [
          { encrypted_content: 'snapshot-provider-ciphertext', summary: [] },
        ],
      },
    });
    await processTalkRunMessage({
      runId: enqueued.runs[0]!.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });

    const rows = await getDbPg()<
      Array<{
        replay_provider_id: string;
        replay_model_id: string;
        message_metadata: Record<string, unknown>;
        snapshot_provider_id: string;
        snapshot_model_id: string;
      }>
    >`
      select
        mpr.provider_id as replay_provider_id,
        mpr.model_id as replay_model_id,
        m.metadata_json as message_metadata,
        tas.provider_id as snapshot_provider_id,
        tas.model_id as snapshot_model_id
      from public.message_provider_replay mpr
      join public.messages m on m.id = mpr.message_id
      join public.runs r on r.id = mpr.run_id
      join public.talk_agent_snapshots tas
        on tas.workspace_id = r.workspace_id
       and tas.talk_id = r.talk_id
       and tas.id = r.agent_snapshot_id
      where mpr.run_id = ${enqueued.runs[0]!.id}::uuid
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      replay_provider_id: rows[0]!.snapshot_provider_id,
      replay_model_id: rows[0]!.snapshot_model_id,
    });
    expect(rows[0]!.message_metadata).toMatchObject({
      providerId: rows[0]!.snapshot_provider_id,
      modelId: rows[0]!.snapshot_model_id,
    });
    expect(rows[0]!.replay_provider_id).not.toBe('provider.mismatched');
    expect(rows[0]!.replay_model_id).not.toBe('mismatched-model');
    expect(rows[0]!.message_metadata).not.toMatchObject({
      providerId: 'provider.mismatched',
      modelId: 'mismatched-model',
    });

    const events = await getDbPg()<
      Array<{
        event_type: string;
        payload: {
          metadata?: Record<string, unknown> | null;
          providerId?: string | null;
          modelId?: string | null;
          executorModel?: string | null;
        };
      }>
    >`
      select event_type, payload
      from public.event_outbox
      where topic = ${`talk:${talkId}`}
        and event_type in (
          'talk_response_started',
          'message_appended',
          'talk_run_completed'
        )
        and payload->>'runId' = ${enqueued.runs[0]!.id}
      order by event_id asc
    `;
    const startedEvent = events.find(
      (event) => event.event_type === 'talk_response_started',
    );
    expect(startedEvent?.payload).toMatchObject({
      providerId: rows[0]!.snapshot_provider_id,
      modelId: rows[0]!.snapshot_model_id,
    });
    expect(startedEvent?.payload).not.toMatchObject({
      providerId: 'provider.started-mismatch',
      modelId: 'started-mismatched-model',
    });
    const appendedEvent = events.find(
      (event) => event.event_type === 'message_appended',
    );
    expect(appendedEvent?.payload.metadata).toMatchObject({
      providerId: rows[0]!.snapshot_provider_id,
      modelId: rows[0]!.snapshot_model_id,
    });
    const completedEvent = events.find(
      (event) => event.event_type === 'talk_run_completed',
    );
    expect(completedEvent?.payload).toMatchObject({
      providerId: rows[0]!.snapshot_provider_id,
      executorModel: rows[0]!.snapshot_model_id,
    });
  });

  it('uses the frozen snapshot model when the denormalized run model drifts', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const enqueued = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: 'Run from the snapshot model.',
      targetAgentIds: agentIds,
    });
    if (!enqueued.ok) throw new Error(`enqueue failed: ${enqueued.reason}`);

    const db = getDbPg();
    const [snapshot] = await db<
      Array<{
        snapshot_provider_id: string;
        snapshot_model_id: string;
      }>
    >`
      select
        tas.provider_id as snapshot_provider_id,
        tas.model_id as snapshot_model_id
      from public.runs r
      join public.talk_agent_snapshots tas
        on tas.workspace_id = r.workspace_id
       and tas.talk_id = r.talk_id
       and tas.id = r.agent_snapshot_id
      where r.id = ${enqueued.runs[0]!.id}::uuid
    `;
    if (!snapshot) throw new Error('snapshot row missing for test run');
    const [otherModel] = await db<Array<{ model_id: string }>>`
      select model_id
      from public.llm_provider_models
      where provider_id = ${snapshot.snapshot_provider_id}
        and model_id <> ${snapshot.snapshot_model_id}
      order by model_id asc
      limit 1
    `;
    if (!otherModel) throw new Error('same-provider alternate model missing');
    await db`
      update public.runs
      set model_id = ${otherModel.model_id}
      where id = ${enqueued.runs[0]!.id}::uuid
    `;

    const { calls } = mockResolvedExecution('Snapshot model answer', {
      providerData: {
        codexReasoningItems: [
          { encrypted_content: 'snapshot-model-ciphertext', summary: [] },
        ],
      },
    });
    await processTalkRunMessage({
      runId: enqueued.runs[0]!.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.agent.model_id).toBe(snapshot.snapshot_model_id);
    expect(calls[0]!.agent.model_id).not.toBe(otherModel.model_id);

    const replayRows = await db<Array<{ model_id: string }>>`
      select model_id
      from public.message_provider_replay
      where run_id = ${enqueued.runs[0]!.id}::uuid
    `;
    expect(replayRows).toEqual([{ model_id: snapshot.snapshot_model_id }]);
  });

  it('completes snapshot-only greenfield runs without writing provider replay provenance', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const enqueued = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: 'Run from a snapshot without a live source agent.',
      targetAgentIds: agentIds,
    });
    if (!enqueued.ok) throw new Error(`enqueue failed: ${enqueued.reason}`);

    const db = getDbPg();
    await db`
      update public.talk_agent_snapshots tas
      set source_agent_id = null
      from public.runs r
      where r.workspace_id = tas.workspace_id
        and r.talk_id = tas.talk_id
        and r.agent_snapshot_id = tas.id
        and r.id = ${enqueued.runs[0]!.id}::uuid
    `;

    const { calls } = mockResolvedExecution('Snapshot-only answer', {
      providerData: {
        codexReasoningItems: [
          { encrypted_content: 'snapshot-only-ciphertext', summary: [] },
        ],
      },
    });
    await processTalkRunMessage({
      runId: enqueued.runs[0]!.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });

    expect(calls).toHaveLength(1);
    const rows = await db<
      Array<{
        status: string;
        message_body: string | null;
        replay_count: string;
      }>
    >`
      select
        r.status,
        m.body as message_body,
        (
          select count(*)::text
          from public.message_provider_replay mpr
          where mpr.run_id = r.id
        ) as replay_count
      from public.runs r
      left join public.messages m
        on m.workspace_id = r.workspace_id
       and m.talk_id = r.talk_id
       and m.run_id = r.id
      where r.id = ${enqueued.runs[0]!.id}::uuid
    `;
    expect(rows[0]).toEqual({
      status: 'completed',
      message_body: 'Snapshot-only answer',
      replay_count: '0',
    });
  });

  it('replays multiple same-agent Codex provider data turns within budget', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const first = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: 'Start the thread.',
      targetAgentIds: agentIds,
    });
    if (!first.ok) throw new Error(`enqueue failed: ${first.reason}`);

    mockResolvedExecution('First answer', {
      providerData: {
        codexReasoningItems: [
          { encrypted_content: 'first-turn-ciphertext', summary: [] },
        ],
      },
    });
    await processTalkRunMessage({
      runId: first.runs[0]!.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });

    const second = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: 'Continue.',
      targetAgentIds: agentIds,
    });
    if (!second.ok) throw new Error(`enqueue failed: ${second.reason}`);

    mockResolvedExecution('Second answer', {
      providerData: {
        codexReasoningItems: [
          { encrypted_content: 'second-turn-ciphertext', summary: [] },
        ],
      },
    });
    await processTalkRunMessage({
      runId: second.runs[0]!.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });

    const third = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: 'Continue again.',
      targetAgentIds: agentIds,
    });
    if (!third.ok) throw new Error(`enqueue failed: ${third.reason}`);

    const { calls } = mockResolvedExecution('Third answer');
    await processTalkRunMessage({
      runId: third.runs[0]!.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });

    expect(calls).toHaveLength(1);
    const encryptedItems = calls[0]!.history.flatMap(
      (message) =>
        message.providerData?.codexReasoningItems?.map(
          (item) => item.encrypted_content,
        ) ?? [],
    );
    expect(encryptedItems).toEqual([
      'first-turn-ciphertext',
      'second-turn-ciphertext',
    ]);
  });

  it('keeps greenfield provider replay as a contiguous newest tail when the budget fills', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const first = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: 'Start the replay budget thread.',
      targetAgentIds: agentIds,
    });
    if (!first.ok) throw new Error(`enqueue failed: ${first.reason}`);

    mockResolvedExecution('First budget answer', {
      providerData: {
        codexReasoningItems: [
          { encrypted_content: 'first-budget-ciphertext', summary: [] },
        ],
      },
    });
    await processTalkRunMessage({
      runId: first.runs[0]!.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });

    const second = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: 'Add a large middle replay payload.',
      targetAgentIds: agentIds,
    });
    if (!second.ok) throw new Error(`enqueue failed: ${second.reason}`);

    mockResolvedExecution('Middle budget answer', {
      providerData: {
        codexReasoningItems: [
          { encrypted_content: 'm'.repeat(60_000), summary: [] },
        ],
      },
    });
    await processTalkRunMessage({
      runId: second.runs[0]!.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });

    const third = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: 'Add the newest replay payload.',
      targetAgentIds: agentIds,
    });
    if (!third.ok) throw new Error(`enqueue failed: ${third.reason}`);

    mockResolvedExecution('Newest budget answer', {
      providerData: {
        codexReasoningItems: [
          { encrypted_content: 'n'.repeat(10_000), summary: [] },
        ],
      },
    });
    await processTalkRunMessage({
      runId: third.runs[0]!.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });

    const fourth = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: 'Continue after the budget fills.',
      targetAgentIds: agentIds,
    });
    if (!fourth.ok) throw new Error(`enqueue failed: ${fourth.reason}`);

    const { calls } = mockResolvedExecution('After budget answer');
    await processTalkRunMessage({
      runId: fourth.runs[0]!.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });

    expect(calls).toHaveLength(1);
    const encryptedItems = calls[0]!.history.flatMap(
      (message) =>
        message.providerData?.codexReasoningItems?.map(
          (item) => item.encrypted_content,
        ) ?? [],
    );
    expect(encryptedItems).toEqual(['n'.repeat(10_000)]);
    expect(calls[0]!.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          content: expect.stringContaining('First budget answer'),
        }),
        expect.objectContaining({
          role: 'assistant',
          content: expect.stringContaining('Middle budget answer'),
        }),
        expect.objectContaining({
          role: 'assistant',
          content: expect.stringContaining('Newest budget answer'),
        }),
      ]),
    );
  });

  it('preserves nullable-body greenfield history turns', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const first = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: 'Start the thread.',
      targetAgentIds: agentIds,
    });
    if (!first.ok) throw new Error(`enqueue failed: ${first.reason}`);

    mockResolvedExecution('First answer');
    await processTalkRunMessage({
      runId: first.runs[0]!.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });

    const db = getDbPg();
    await db`
      update public.messages
      set created_at = '2026-05-26T09:59:00Z'::timestamptz
      where workspace_id = ${workspaceId}::uuid
        and talk_id = ${talkId}::uuid
        and round = 1
        and author_kind = 'user'
    `;
    await db`
      update public.messages
      set created_at = '2026-05-26T10:00:00Z'::timestamptz
      where workspace_id = ${workspaceId}::uuid
        and talk_id = ${talkId}::uuid
        and run_id = ${first.runs[0]!.id}::uuid
        and author_kind = 'agent'
    `;
    await db`
      insert into public.messages (
        workspace_id, talk_id, round, author_kind, author_user_id, body,
        metadata_json, created_at
      )
      values (
        ${workspaceId}::uuid,
        ${talkId}::uuid,
        1,
        'user',
        ${USER_ID}::uuid,
        null,
        '{}'::jsonb,
        '2026-05-26T10:01:00Z'::timestamptz
      )
    `;
    await db`
      insert into public.messages (
        workspace_id, talk_id, round, author_kind, agent_snapshot_id, run_id,
        body, metadata_json, created_at
      )
      select
        workspace_id,
        talk_id,
        round,
        'agent',
        agent_snapshot_id,
        id,
        '',
        '{}'::jsonb,
        '2026-05-26T10:02:00Z'::timestamptz
      from public.runs
      where id = ${first.runs[0]!.id}::uuid
    `;

    const second = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: 'Continue.',
      targetAgentIds: agentIds,
    });
    if (!second.ok) throw new Error(`enqueue failed: ${second.reason}`);

    const { calls } = mockResolvedExecution('Second answer');
    await processTalkRunMessage({
      runId: second.runs[0]!.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.history.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(calls[0]!.history.map((message) => message.content)).toEqual([
      'Start the thread.',
      expect.stringContaining('First answer'),
      '[No text content in this turn]',
      expect.stringContaining('[No text content in this turn]'),
    ]);
  });

  it('does not replay persisted Codex provider data across greenfield agents', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture({
      agentCount: 2,
    });
    if (agentIds.length < 2) throw new Error('Expected two default agents');

    const first = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: 'First agent, start.',
      targetAgentIds: [agentIds[0]!],
    });
    if (!first.ok) throw new Error(`enqueue failed: ${first.reason}`);

    mockResolvedExecution('First agent answer', {
      providerData: {
        codexReasoningItems: [
          { encrypted_content: 'agent-a-ciphertext', summary: [] },
        ],
      },
    });
    await processTalkRunMessage({
      runId: first.runs[0]!.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });

    const second = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: 'Second agent, continue.',
      targetAgentIds: [agentIds[1]!],
    });
    if (!second.ok) throw new Error(`enqueue failed: ${second.reason}`);

    const { calls } = mockResolvedExecution('Second agent answer');
    await processTalkRunMessage({
      runId: second.runs[0]!.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          content: expect.stringContaining('First agent answer'),
        }),
      ]),
    );
    expect(calls[0]!.history.filter((message) => message.providerData)).toEqual(
      [],
    );
  });

  it('does not replay persisted Codex provider data across model boundaries', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const first = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: 'Start with this model.',
      targetAgentIds: agentIds,
    });
    if (!first.ok) throw new Error(`enqueue failed: ${first.reason}`);

    mockResolvedExecution('First model answer', {
      providerData: {
        codexReasoningItems: [
          { encrypted_content: 'model-a-ciphertext', summary: [] },
        ],
      },
    });
    await processTalkRunMessage({
      runId: first.runs[0]!.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });

    await getDbPg()`
      update public.message_provider_replay
      set model_id = 'different-model'
      where run_id = ${first.runs[0]!.id}::uuid
    `;

    const second = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: 'Continue on the same agent.',
      targetAgentIds: agentIds,
    });
    if (!second.ok) throw new Error(`enqueue failed: ${second.reason}`);

    const { calls } = mockResolvedExecution('Second model answer');
    await processTalkRunMessage({
      runId: second.runs[0]!.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          content: expect.stringContaining('First model answer'),
        }),
      ]),
    );
    expect(calls[0]!.history.filter((message) => message.providerData)).toEqual(
      [],
    );
  });

  it('does not replay persisted Codex provider data across provider boundaries', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const first = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: 'Start with this provider.',
      targetAgentIds: agentIds,
    });
    if (!first.ok) throw new Error(`enqueue failed: ${first.reason}`);

    mockResolvedExecution('First provider answer', {
      providerData: {
        codexReasoningItems: [
          { encrypted_content: 'provider-a-ciphertext', summary: [] },
        ],
      },
    });
    await processTalkRunMessage({
      runId: first.runs[0]!.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });

    await getDbPg()`
      update public.message_provider_replay
      set provider_id = 'provider.openai'
      where run_id = ${first.runs[0]!.id}::uuid
    `;

    const second = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: 'Continue on the same agent.',
      targetAgentIds: agentIds,
    });
    if (!second.ok) throw new Error(`enqueue failed: ${second.reason}`);

    const { calls } = mockResolvedExecution('Second provider answer');
    await processTalkRunMessage({
      runId: second.runs[0]!.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          content: expect.stringContaining('First provider answer'),
        }),
      ]),
    );
    expect(calls[0]!.history.filter((message) => message.providerData)).toEqual(
      [],
    );
  });

  it('does not replay persisted Codex provider data when the message snapshot identity drifts', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const first = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: 'Start with the original snapshot.',
      targetAgentIds: agentIds,
    });
    if (!first.ok) throw new Error(`enqueue failed: ${first.reason}`);

    mockResolvedExecution('Original snapshot answer', {
      providerData: {
        codexReasoningItems: [
          { encrypted_content: 'snapshot-drift-ciphertext', summary: [] },
        ],
      },
    });
    await processTalkRunMessage({
      runId: first.runs[0]!.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });

    const db = getDbPg();
    const [historyMessage] = await db<
      Array<{
        agent_snapshot_id: string;
        replay_provider_id: string;
        replay_model_id: string;
      }>
    >`
      select
        m.agent_snapshot_id::text as agent_snapshot_id,
        mpr.provider_id as replay_provider_id,
        mpr.model_id as replay_model_id
      from public.messages m
      join public.message_provider_replay mpr
        on mpr.workspace_id = m.workspace_id
       and mpr.talk_id = m.talk_id
       and mpr.message_id = m.id
      where m.run_id = ${first.runs[0]!.id}::uuid
      limit 1
    `;
    if (!historyMessage) throw new Error('history replay row missing');
    const [alternateModel] = await db<
      Array<{ provider_id: string; model_id: string }>
    >`
      select provider_id, model_id
      from public.llm_provider_models
      where (provider_id, model_id) <> (
        ${historyMessage.replay_provider_id},
        ${historyMessage.replay_model_id}
      )
      order by provider_id asc, model_id asc
      limit 1
    `;
    if (!alternateModel) throw new Error('alternate provider model missing');
    await db`
      update public.talk_agent_snapshots
      set provider_id = ${alternateModel.provider_id},
          model_id = ${alternateModel.model_id}
      where id = ${historyMessage.agent_snapshot_id}::uuid
    `;

    const second = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: 'Continue on the same live agent.',
      targetAgentIds: agentIds,
    });
    if (!second.ok) throw new Error(`enqueue failed: ${second.reason}`);

    const { calls } = mockResolvedExecution('After snapshot drift answer');
    await processTalkRunMessage({
      runId: second.runs[0]!.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          content: expect.stringContaining('Original snapshot answer'),
        }),
      ]),
    );
    expect(calls[0]!.history.filter((message) => message.providerData)).toEqual(
      [],
    );
  });

  it('drops oversized Codex provider replay data from greenfield history', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const first = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: 'Produce a large replay payload.',
      targetAgentIds: agentIds,
    });
    if (!first.ok) throw new Error(`enqueue failed: ${first.reason}`);

    mockResolvedExecution('Large replay answer', {
      providerData: {
        codexReasoningItems: [
          { encrypted_content: 'x'.repeat(70_000), summary: [] },
        ],
      },
    });
    await processTalkRunMessage({
      runId: first.runs[0]!.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });
    const oversizedReplayRows = await getDbPg()<Array<{ count: string }>>`
      select count(*)::text as count
      from public.message_provider_replay
      where run_id = ${first.runs[0]!.id}::uuid
    `;
    expect(oversizedReplayRows[0]?.count).toBe('0');

    const second = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: 'Continue after the large payload.',
      targetAgentIds: agentIds,
    });
    if (!second.ok) throw new Error(`enqueue failed: ${second.reason}`);

    const { calls } = mockResolvedExecution('After large replay answer');
    await processTalkRunMessage({
      runId: second.runs[0]!.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          content: expect.stringContaining('Large replay answer'),
        }),
      ]),
    );
    expect(calls[0]!.history.filter((message) => message.providerData)).toEqual(
      [],
    );
  });

  it('attaches complete greenfield PDF page images to the user turn', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const db = getDbPg();
    const sources = await db<{ id: string }[]>`
      insert into public.context_sources (
        workspace_id, talk_id, kind, name, extracted_text, meta_json,
        expected_page_count, include_in_prompt, sort_order, added_by_user_id
      )
      values (
        ${workspaceId}::uuid,
        ${talkId}::uuid,
        'file',
        'Scanned PDF',
        null,
        ${db.json({
          compatKind: 'source',
          sourceRef: 'S7',
          sourceType: 'file',
          mimeType: 'application/pdf',
        } as never)},
        2,
        true,
        6,
        ${USER_ID}::uuid
      )
      returning id
    `;
    const sourceId = sources[0]!.id;
    await db`
      insert into public.context_source_pages (
        workspace_id, source_id, page_index, byte_size, payload_ref
      )
      values
        (${workspaceId}::uuid, ${sourceId}::uuid, 0, 123, 'page-0.jpg'),
        (${workspaceId}::uuid, ${sourceId}::uuid, 1, 456, 'page-1.jpg')
    `;
    vi.mocked(loadPageImage).mockImplementation(
      async (_talkId, _sourceId, pageIndex) =>
        Buffer.from(`jpeg-page-${pageIndex}`),
    );

    const enqueued = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: 'Summarize the scanned PDF.',
      targetAgentIds: agentIds,
    });
    if (!enqueued.ok) throw new Error(`enqueue failed: ${enqueued.reason}`);

    const { calls } = mockResolvedExecution('PDF answer');
    await processTalkRunMessage({
      runId: enqueued.runs[0]!.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.context.systemPrompt).toContain(
      `Source ${sourceId}: Scanned PDF (file)`,
    );
    expect(calls[0]!.context.systemPrompt).toContain(
      'No extracted text is available.',
    );
    expect(loadPageImage).toHaveBeenNthCalledWith(1, talkId, sourceId, 0);
    expect(loadPageImage).toHaveBeenNthCalledWith(2, talkId, sourceId, 1);

    const userMessage = calls[0]!.userMessage;
    expect(Array.isArray(userMessage)).toBe(true);
    const blocks = userMessage as LlmContentBlock[];
    const texts = blocks
      .filter(
        (block): block is Extract<LlmContentBlock, { type: 'text' }> =>
          block.type === 'text',
      )
      .map((block) => block.text);
    const images = blocks.filter(
      (block): block is Extract<LlmContentBlock, { type: 'image' }> =>
        block.type === 'image',
    );
    expect(texts.join('\n')).toContain(
      `PDF [${sourceId}] "Scanned PDF" - page 1 of 2:`,
    );
    expect(texts.join('\n')).toContain(
      `PDF [${sourceId}] "Scanned PDF" - page 2 of 2:`,
    );
    expect(texts.at(-1)).toBe('Summarize the scanned PDF.');
    expect(images).toHaveLength(2);
    expect(images[0]).toMatchObject({
      type: 'image',
      mimeType: 'image/jpeg',
      data: Buffer.from('jpeg-page-0').toString('base64'),
    });
  });

  it('freezes talk_tools into the run snapshot and passes them to execution', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const db = getDbPg();
    await db`
      insert into public.talk_tools (workspace_id, talk_id, tool_id, enabled)
      values
        (${workspaceId}::uuid, ${talkId}::uuid, 'web-search', true),
        (${workspaceId}::uuid, ${talkId}::uuid, 'web-fetch', false),
        (${workspaceId}::uuid, ${talkId}::uuid, 'news-monitor', false),
        (${workspaceId}::uuid, ${talkId}::uuid, 'linear', true),
        (${workspaceId}::uuid, ${talkId}::uuid, 'gdrive-read', false)
    `;
    const permissionTable = await db<{ exists: boolean }[]>`
      select to_regclass('public.user_tool_permissions') is not null as exists
    `;
    const hasPermissionTable = permissionTable[0]?.exists === true;
    if (hasPermissionTable) {
      await db`
        insert into public.user_tool_permissions (
          user_id, tool_id, allowed, requires_approval
        )
        values (${USER_ID}::uuid, 'web_search', true, true)
        on conflict (user_id, tool_id) do update set
          allowed = excluded.allowed,
          requires_approval = excluded.requires_approval,
          updated_at = now()
      `;
    }

    const enqueued = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: 'Use web context.',
      targetAgentIds: agentIds,
    });
    if (!enqueued.ok) throw new Error(`enqueue failed: ${enqueued.reason}`);

    await db`
      update public.talk_tools
      set enabled = false
      where workspace_id = ${workspaceId}::uuid
        and talk_id = ${talkId}::uuid
        and tool_id in ('web-search', 'web-fetch', 'news-monitor')
    `;
    if (hasPermissionTable) {
      await db`
        update public.user_tool_permissions
        set allowed = false, requires_approval = false, updated_at = now()
        where user_id = ${USER_ID}::uuid
          and tool_id = 'web_search'
      `;
    }

    const { calls } = mockResolvedExecution('Tool-gated answer');
    await processTalkRunMessage({
      runId: enqueued.runs[0]!.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.hasExecuteToolCall).toBe(true);
    expect(calls[0]!.context.contextToolNames).toContain('web_search');
    expect(calls[0]!.effectiveTools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolFamily: 'web',
          enabled: true,
          runtimeTools: ['web_search'],
          requiresApproval: hasPermissionTable,
        }),
        expect.objectContaining({
          toolFamily: 'google_read',
          enabled: false,
        }),
        expect.objectContaining({
          toolFamily: 'connectors',
          enabled: true,
          runtimeTools: [],
        }),
      ]),
    );

    const snapshots = await db<
      Array<{
        tool_manifest_json: {
          active?: Record<string, boolean>;
          effectiveTools?: Array<{
            toolFamily: string;
            enabled: boolean;
            requiresApproval: boolean;
          }>;
        } | null;
      }>
    >`
      select rps.tool_manifest_json
      from public.runs r
      join public.run_prompt_snapshots rps
        on rps.workspace_id = r.workspace_id
       and rps.id = r.prompt_snapshot_id
      where r.id = ${enqueued.runs[0]!.id}::uuid
    `;
    expect(snapshots[0]?.tool_manifest_json?.active).toMatchObject({
      web: true,
      google_read: false,
    });
    expect(snapshots[0]?.tool_manifest_json?.effectiveTools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolFamily: 'web',
          enabled: true,
          runtimeTools: ['web_search'],
          requiresApproval: hasPermissionTable,
        }),
        expect.objectContaining({
          toolFamily: 'connectors',
          enabled: true,
          runtimeTools: [],
        }),
      ]),
    );
  });

  it('keeps disabled web tools out of execution even when live tools are re-enabled', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const db = getDbPg();
    await db`
      insert into public.talk_tools (workspace_id, talk_id, tool_id, enabled)
      values
        (${workspaceId}::uuid, ${talkId}::uuid, 'web-search', false),
        (${workspaceId}::uuid, ${talkId}::uuid, 'web-fetch', false),
        (${workspaceId}::uuid, ${talkId}::uuid, 'news-monitor', false)
      on conflict (talk_id, tool_id) do update
        set enabled = excluded.enabled
    `;

    const enqueued = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: 'Answer without web.',
      targetAgentIds: agentIds,
    });
    if (!enqueued.ok) throw new Error(`enqueue failed: ${enqueued.reason}`);

    await db`
      update public.talk_tools
      set enabled = true
      where workspace_id = ${workspaceId}::uuid
        and talk_id = ${talkId}::uuid
        and tool_id in ('web-search', 'web-fetch', 'news-monitor')
    `;

    const { calls } = mockResolvedExecution('No-web answer');
    await processTalkRunMessage({
      runId: enqueued.runs[0]!.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.context.contextToolNames).not.toContain('web_search');
    expect(calls[0]!.context.contextToolNames).not.toContain('web_fetch');
    expect(calls[0]!.effectiveTools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolFamily: 'web',
          enabled: false,
          runtimeTools: [],
        }),
      ]),
    );
  });

  it('passes the requester to web_search without holding a user-context tx (P1-0 split)', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const db = getDbPg();
    await db`
      insert into public.talk_tools (workspace_id, talk_id, tool_id, enabled)
      values (${workspaceId}::uuid, ${talkId}::uuid, 'web-search', true)
    `;
    runWebSearchForUserMock.mockImplementation(
      async (_userId: string, query: string) => {
        // The registry owns its own short committed credential tx; the
        // executor must NOT wrap the call (a wrapper would keep a tx —
        // and the max:1 connection — open across the provider fetch).
        expect(getCurrentUserId()).toBeNull();
        return {
          query,
          providerId: 'web_search.tavily',
          results: [],
        };
      },
    );

    const enqueued = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: 'Use web search.',
      targetAgentIds: agentIds,
    });
    if (!enqueued.ok) throw new Error(`enqueue failed: ${enqueued.reason}`);

    mockResolvedExecution('Search answer', {
      onExecute: async (executeToolCall) => {
        const result = await executeToolCall('web_search', {
          query: 'current clawtalk status',
        });
        expect(result).toEqual({
          result: JSON.stringify({
            provider: 'web_search.tavily',
            query: 'current clawtalk status',
            results: [],
            note: 'No results returned by the provider.',
          }),
        });
      },
    });
    await processTalkRunMessage({
      runId: enqueued.runs[0]!.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });

    expect(runWebSearchForUserMock).toHaveBeenCalledWith(
      USER_ID,
      'current clawtalk status',
      { maxResults: undefined, signal: expect.any(AbortSignal) },
    );
  });

  it('rejects unknown context tool calls before legacy execution', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const enqueued = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: 'Try to call unknown tools.',
      targetAgentIds: agentIds,
    });
    if (!enqueued.ok) throw new Error(`enqueue failed: ${enqueued.reason}`);

    const { calls } = mockResolvedExecution('Unknown tools unavailable', {
      onExecute: async (executeToolCall) => {
        const result = await executeToolCall('unknown_context_tool', {});
        expect(result).toEqual({
          isError: true,
          result:
            "Tool 'unknown_context_tool' is not available in greenfield execution",
        });
        await expect(
          executeToolCall('update_state', {
            key: 'scratch',
            value: 'legacy write',
          }),
        ).resolves.toEqual({
          isError: true,
          result:
            'Error: state_not_available: Greenfield Talks do not have mutable state in this runtime.',
        });
      },
    });
    await processTalkRunMessage({
      runId: enqueued.runs[0]!.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });

    expect(calls).toHaveLength(1);
  });

  it('does not over-grant tools when only the family-level active manifest is present', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const db = getDbPg();
    await db`
      insert into public.talk_tools (workspace_id, talk_id, tool_id, enabled)
      values
        (${workspaceId}::uuid, ${talkId}::uuid, 'web-search', true),
        (${workspaceId}::uuid, ${talkId}::uuid, 'web-fetch', false),
        (${workspaceId}::uuid, ${talkId}::uuid, 'news-monitor', false)
    `;

    const enqueued = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: 'Use only web search.',
      targetAgentIds: agentIds,
    });
    if (!enqueued.ok) throw new Error(`enqueue failed: ${enqueued.reason}`);

    await db`
      update public.run_prompt_snapshots rps
      set tool_manifest_json = jsonb_build_object(
        'active', jsonb_build_object('web', true)
      )
      from public.runs r
      where r.workspace_id = rps.workspace_id
        and r.prompt_snapshot_id = rps.id
        and r.id = ${enqueued.runs[0]!.id}::uuid
    `;

    const { calls } = mockResolvedExecution('Fallback tool-gated answer');
    await processTalkRunMessage({
      runId: enqueued.runs[0]!.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.effectiveTools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolFamily: 'web',
          enabled: true,
          runtimeTools: ['web_search'],
        }),
      ]),
    );
  });

  it('enumerates the advertised toolset in the system prompt so toggles override stale history', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const db = getDbPg();

    // Web off: the prompt must list only read_source.
    const withoutWeb = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: 'What tools do you have?',
      targetAgentIds: agentIds,
    });
    if (!withoutWeb.ok) throw new Error(`enqueue failed: ${withoutWeb.reason}`);
    const first = mockResolvedExecution('No web yet');
    await processTalkRunMessage({
      runId: withoutWeb.runs[0]!.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });
    expect(first.calls).toHaveLength(1);
    expect(first.calls[0]!.context.systemPrompt).toContain(
      'Tools available in this run: read_source.',
    );

    // Web toggled on mid-Talk: the next run's prompt must enumerate
    // web_search and assert authority over earlier turns.
    await db`
      insert into public.talk_tools (workspace_id, talk_id, tool_id, enabled)
      values
        (${workspaceId}::uuid, ${talkId}::uuid, 'web-search', true),
        (${workspaceId}::uuid, ${talkId}::uuid, 'web-fetch', false),
        (${workspaceId}::uuid, ${talkId}::uuid, 'news-monitor', false)
    `;
    const withWeb = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: 'Now search the web.',
      targetAgentIds: agentIds,
    });
    if (!withWeb.ok) throw new Error(`enqueue failed: ${withWeb.reason}`);
    const second = mockResolvedExecution('Web available');
    await processTalkRunMessage({
      runId: withWeb.runs[0]!.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });
    expect(second.calls).toHaveLength(1);
    expect(second.calls[0]!.context.systemPrompt).toContain(
      'Tools available in this run: read_source, web_search.',
    );
    expect(second.calls[0]!.context.systemPrompt).toContain(
      'overrides any earlier turn',
    );
  });

  it('rejects Google tool calls when the frozen effective tool snapshot does not enable Google', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const db = getDbPg();
    const enqueued = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: 'Do not use Google tools.',
      targetAgentIds: agentIds,
    });
    if (!enqueued.ok) throw new Error(`enqueue failed: ${enqueued.reason}`);

    await db`
      update public.run_prompt_snapshots rps
      set tool_manifest_json = jsonb_build_object(
        'active',
        jsonb_build_object('google_read', false, 'google_write', false),
        'effectiveTools',
        jsonb_build_array(
          jsonb_build_object(
            'toolFamily', 'google_read',
            'enabled', false,
            'runtimeTools', jsonb_build_array(),
            'requiresApproval', false
          ),
          jsonb_build_object(
            'toolFamily', 'google_write',
            'enabled', false,
            'runtimeTools', jsonb_build_array(),
            'requiresApproval', false
          )
        )
      )
      from public.runs r
      where r.workspace_id = rps.workspace_id
        and r.prompt_snapshot_id = rps.id
        and r.id = ${enqueued.runs[0]!.id}::uuid
    `;

    const { calls } = mockResolvedExecution('Google calls rejected', {
      onExecute: async (executeToolCall) => {
        const readResult = await executeToolCall('google_drive_search', {
          query: 'private docs',
        });
        const writeResult = await executeToolCall('google_docs_create', {
          title: 'Unauthorized doc',
        });
        expect(readResult).toMatchObject({
          isError: true,
          result:
            "Tool 'google_drive_search' is not available in greenfield execution",
        });
        expect(writeResult).toMatchObject({
          isError: true,
          result:
            "Tool 'google_docs_create' is not available in greenfield execution",
        });
      },
    });
    await processTalkRunMessage({
      runId: enqueued.runs[0]!.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });

    expect(calls).toHaveLength(1);
  });

  it('freezes the agent credential mode into the run snapshot', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const db = getDbPg();
    await seedWorkspaceProviderSecret(workspaceId, 'subscription');
    await db`
      update public.agents
      set credential_mode = 'subscription'
      where workspace_id = ${workspaceId}::uuid
        and id = ${agentIds[0]}::uuid
    `;

    const enqueued = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: 'Use the pinned credential path.',
      targetAgentIds: agentIds,
    });
    if (!enqueued.ok) throw new Error(`enqueue failed: ${enqueued.reason}`);

    await db`
      update public.agents
      set credential_mode = 'api_key'
      where workspace_id = ${workspaceId}::uuid
        and id = ${agentIds[0]}::uuid
    `;

    const { calls } = mockResolvedExecution('Pinned credential answer');
    await processTalkRunMessage({
      runId: enqueued.runs[0]!.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.agent.credential_mode).toBe('subscription');
    expect(calls[0]!.credentialKindSnapshot).toBe('subscription');

    const snapshots = await db<Array<{ agent_credential_mode: string | null }>>`
      select rps.tool_manifest_json->>'agentCredentialMode' as agent_credential_mode
      from public.runs r
      join public.run_prompt_snapshots rps
        on rps.workspace_id = r.workspace_id
       and rps.id = r.prompt_snapshot_id
      where r.id = ${enqueued.runs[0]!.id}::uuid
    `;
    expect(snapshots[0]?.agent_credential_mode).toBe('subscription');
  });

  it('freezes the resolved workspace credential kind for unpinned greenfield runs', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const db = getDbPg();
    await seedWorkspaceProviderSecret(workspaceId, 'api_key');
    await db`
      update public.agents
      set credential_mode = null
      where workspace_id = ${workspaceId}::uuid
        and id = ${agentIds[0]}::uuid
    `;

    const enqueued = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: 'Use the workspace credential path.',
      targetAgentIds: agentIds,
    });
    if (!enqueued.ok) throw new Error(`enqueue failed: ${enqueued.reason}`);

    await db`
      update public.agents
      set credential_mode = 'subscription'
      where workspace_id = ${workspaceId}::uuid
        and id = ${agentIds[0]}::uuid
    `;

    const { calls } = mockResolvedExecution('Workspace credential answer');
    await processTalkRunMessage({
      runId: enqueued.runs[0]!.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.agent.credential_mode).toBe('api_key');
    expect(calls[0]!.credentialKindSnapshot).toBe('api_key');

    const snapshots = await db<Array<{ agent_credential_mode: string | null }>>`
      select rps.tool_manifest_json->>'agentCredentialMode' as agent_credential_mode
      from public.runs r
      join public.run_prompt_snapshots rps
        on rps.workspace_id = r.workspace_id
       and rps.id = r.prompt_snapshot_id
      where r.id = ${enqueued.runs[0]!.id}::uuid
    `;
    expect(snapshots[0]?.agent_credential_mode).toBe('api_key');
  });

  it('freezes the resolved workspace credential kind for manual job runs', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const db = getDbPg();
    await seedWorkspaceProviderSecret(workspaceId, 'api_key');
    await db`
      update public.agents
      set credential_mode = null
      where workspace_id = ${workspaceId}::uuid
        and id = ${agentIds[0]}::uuid
    `;
    const job = await createGreenfieldJob({
      workspaceId,
      talkId,
      title: 'Credential Snapshot Job',
      prompt: 'Use the workspace credential path.',
      agentId: agentIds[0]!,
      schedule: { kind: 'interval', everyHours: 1 },
      timezone: 'UTC',
      sourceScope: { allowWeb: false, toolIds: [] },
      createdBy: USER_ID,
    });

    const runNow = await createGreenfieldJobRunNow({
      workspaceId,
      talkId,
      jobId: job.id,
      requestedBy: USER_ID,
    });
    if (runNow.status !== 'enqueued') {
      throw new Error(`Expected job run to enqueue, got ${runNow.status}`);
    }
    await db`
      update public.agents
      set credential_mode = 'subscription'
      where workspace_id = ${workspaceId}::uuid
        and id = ${agentIds[0]}::uuid
    `;

    const { calls } = mockResolvedExecution('Manual job credential answer');
    await processTalkRunMessage({
      runId: runNow.runId,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.agent.credential_mode).toBe('api_key');
    expect(calls[0]!.credentialKindSnapshot).toBe('api_key');

    const snapshots = await db<Array<{ agent_credential_mode: string | null }>>`
      select rps.tool_manifest_json->>'agentCredentialMode' as agent_credential_mode
      from public.run_prompt_snapshots rps
      where rps.workspace_id = ${workspaceId}::uuid
        and rps.run_id = ${runNow.runId}::uuid
    `;
    expect(snapshots[0]?.agent_credential_mode).toBe('api_key');
  });

  it('advertises and executes only exact frozen runtime tools for greenfield runs', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const db = getDbPg();
    const enqueued = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: 'Use tools.',
      targetAgentIds: agentIds,
    });
    if (!enqueued.ok) throw new Error(`enqueue failed: ${enqueued.reason}`);

    await db`
      update public.run_prompt_snapshots rps
      set tool_manifest_json = jsonb_build_object(
        'active',
        jsonb_build_object(
          'web', true,
          'google_read', true,
          'google_write', true
        ),
        'effectiveTools',
        jsonb_build_array(
          jsonb_build_object(
            'toolFamily', 'web',
            'enabled', true,
            'runtimeTools', jsonb_build_array('web_search'),
            'requiresApproval', false
          ),
          jsonb_build_object(
            'toolFamily', 'google_read',
            'enabled', true,
            'runtimeTools', jsonb_build_array('google_drive_search'),
            'requiresApproval', false
          ),
          jsonb_build_object(
            'toolFamily', 'google_write',
            'enabled', true,
            'runtimeTools', jsonb_build_array('google_docs_create'),
            'requiresApproval', false
          )
        )
      )
      from public.runs r
      where r.workspace_id = rps.workspace_id
        and r.prompt_snapshot_id = rps.id
        and r.id = ${enqueued.runs[0]!.id}::uuid
    `;

    const { calls } = mockResolvedExecution('Tool-enabled answer', {
      onExecute: async (executeToolCall) => {
        await expect(
          executeToolCall('web_fetch', { url: 'https://example.com' }),
        ).resolves.toMatchObject({
          isError: true,
          result: "Tool 'web_fetch' is not available in greenfield execution",
        });
        await expect(
          executeToolCall('google_drive_read', { fileId: 'file_1' }),
        ).resolves.toMatchObject({
          isError: true,
          result:
            "Tool 'google_drive_read' is not available in greenfield execution",
        });
        await expect(
          executeToolCall('google_docs_batch_update', {
            documentId: 'doc_1',
            requests: [],
          }),
        ).resolves.toMatchObject({
          isError: true,
          result:
            "Tool 'google_docs_batch_update' is not available in greenfield execution",
        });
      },
    });
    await processTalkRunMessage({
      runId: enqueued.runs[0]!.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.hasExecuteToolCall).toBe(true);
    expect(calls[0]!.context.contextToolNames).toEqual([
      'read_source',
      'web_search',
      'google_drive_search',
      'google_docs_create',
    ]);
    expect(calls[0]!.context.connectorToolNames).toEqual([]);
  });

  it('registers greenfield document edit tools and aborts edit-intent runs without an apply call', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const createdDocument = await createGreenfieldDocumentForTalk({
      workspaceId,
      talkId,
      title: 'Launch Draft',
      format: 'markdown',
    });
    await replaceGreenfieldDocumentBlocks({
      workspaceId,
      documentId: createdDocument.id,
      tabId: createdDocument.tab_id,
      blocks: [{ kind: 'p', text: 'Old intro paragraph.' }],
    });

    const enqueued = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: '@doc rewrite the intro.',
      targetAgentIds: agentIds,
    });
    if (!enqueued.ok) throw new Error(`enqueue failed: ${enqueued.reason}`);

    const { calls } = mockResolvedExecution('I will update it.');
    await processTalkRunMessage({
      runId: enqueued.runs[0]!.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.forceToolUseOnFirstIteration).toBe(true);
    expect(calls[0]!.context.contextToolNames).toContain('apply_content_edit');
    expect(calls[0]!.context.contextToolNames).toContain('read_source');
    expect(calls[0]!.context.contextToolNames).not.toContain('read_state');
    expect(calls[0]!.context.systemPrompt).toContain('The Doc');
    expect(calls[0]!.context.systemPrompt).toContain('Old intro paragraph.');

    const db = getDbPg();
    const events = await db<{ event_type: string }[]>`
      select event_type
      from public.event_outbox
      where topic = ${`talk:${talkId}`}
        and event_type like 'content_edit_%'
      order by event_id asc
    `;
    expect(events.map((event) => event.event_type)).toEqual([
      'content_edit_run_started',
      'content_edit_run_aborted',
    ]);
  });

  it('creates pending greenfield document edits through apply_content_edit', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const createdDocument = await createGreenfieldDocumentForTalk({
      workspaceId,
      talkId,
      title: 'Launch Draft',
      format: 'markdown',
    });
    await replaceGreenfieldDocumentBlocks({
      workspaceId,
      documentId: createdDocument.id,
      tabId: createdDocument.tab_id,
      blocks: [{ kind: 'p', text: 'Old intro paragraph.' }],
    });
    const document = await getGreenfieldDocumentForTalk({
      workspaceId,
      talkId,
    });
    const block = document?.blocks[0];
    if (!document || !block) throw new Error('Document fixture did not load');

    const enqueued = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: '@doc replace the first paragraph.',
      targetAgentIds: agentIds,
    });
    if (!enqueued.ok) throw new Error(`enqueue failed: ${enqueued.reason}`);

    const { calls } = mockResolvedExecution('Updated.', {
      onExecute: async (executeToolCall) => {
        const result = await executeToolCall('apply_content_edit', {
          kind: 'replace',
          anchor: block.id,
          markdown: 'Updated intro paragraph.',
          rationale: 'Refresh the opening.',
        });
        expect(result.isError).not.toBe(true);
        expect(JSON.parse(result.result).editIds).toHaveLength(1);
      },
    });
    await processTalkRunMessage({
      runId: enqueued.runs[0]!.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.forceToolUseOnFirstIteration).toBe(true);

    const db = getDbPg();
    const edits = await db<
      Array<{
        op: string;
        block_id: string | null;
        base_block_version: number | null;
        new_kind: string | null;
        new_text: string | null;
        proposed_by_run_id: string | null;
      }>
    >`
      select op, block_id, base_block_version, new_kind, new_text,
             proposed_by_run_id
      from public.document_edits
      where workspace_id = ${workspaceId}::uuid
        and document_id = ${document.id}::uuid
        and status = 'pending'
    `;
    expect(edits).toEqual([
      {
        op: 'replace',
        block_id: block.id,
        base_block_version: block.version,
        new_kind: 'p',
        new_text: 'Updated intro paragraph.',
        proposed_by_run_id: enqueued.runs[0]!.id,
      },
    ]);

    const events = await db<{ event_type: string }[]>`
      select event_type
      from public.event_outbox
      where topic = ${`talk:${talkId}`}
        and event_type like 'content_edit_%'
      order by event_id asc
    `;
    expect(events.map((event) => event.event_type)).toEqual([
      'content_edit_run_started',
      'content_edit_applied',
    ]);
  });

  it('does not advertise or execute document edits when the frozen runtime tool is missing', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const createdDocument = await createGreenfieldDocumentForTalk({
      workspaceId,
      talkId,
      title: 'Launch Draft',
      format: 'markdown',
    });
    await replaceGreenfieldDocumentBlocks({
      workspaceId,
      documentId: createdDocument.id,
      tabId: createdDocument.tab_id,
      blocks: [{ kind: 'p', text: 'Old intro paragraph.' }],
    });
    const document = await getGreenfieldDocumentForTalk({
      workspaceId,
      talkId,
    });
    const block = document?.blocks[0];
    if (!document || !block) throw new Error('Document fixture did not load');

    const enqueued = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: '@doc replace the first paragraph.',
      targetAgentIds: agentIds,
    });
    if (!enqueued.ok) throw new Error(`enqueue failed: ${enqueued.reason}`);

    const db = getDbPg();
    await db`
      update public.run_prompt_snapshots rps
      set tool_manifest_json = jsonb_set(
        rps.tool_manifest_json,
        '{effectiveTools}',
        (
          select coalesce(jsonb_agg(tool), '[]'::jsonb)
          from jsonb_array_elements(rps.tool_manifest_json->'effectiveTools') as tool
          where tool->>'toolFamily' <> 'document_edit'
        )
      )
      from public.runs r
      where r.workspace_id = rps.workspace_id
        and r.prompt_snapshot_id = rps.id
        and r.id = ${enqueued.runs[0]!.id}::uuid
    `;

    const { calls } = mockResolvedExecution('Not edited.', {
      onExecute: async (executeToolCall) => {
        const result = await executeToolCall('apply_content_edit', {
          kind: 'replace',
          anchor: block.id,
          markdown: 'Unauthorized edit.',
        });
        expect(result).toMatchObject({
          isError: true,
          result: 'Error: apply_content_edit is not enabled for this agent',
        });
      },
    });
    await processTalkRunMessage({
      runId: enqueued.runs[0]!.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.forceToolUseOnFirstIteration).toBe(false);
    expect(calls[0]!.context.contextToolNames).not.toContain(
      'apply_content_edit',
    );

    const edits = await db<Array<{ count: number }>>`
      select count(*)::int as count
      from public.document_edits
      where workspace_id = ${workspaceId}::uuid
        and document_id = ${document.id}::uuid
    `;
    expect(edits[0]?.count).toBe(0);
  });

  it('collapses multi-block document append proposals into one pending insert', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const createdDocument = await createGreenfieldDocumentForTalk({
      workspaceId,
      talkId,
      title: 'Launch Draft',
      format: 'markdown',
    });
    await replaceGreenfieldDocumentBlocks({
      workspaceId,
      documentId: createdDocument.id,
      tabId: createdDocument.tab_id,
      blocks: [{ kind: 'p', text: 'Anchor paragraph.' }],
    });
    const document = await getGreenfieldDocumentForTalk({
      workspaceId,
      talkId,
    });
    const block = document?.blocks[0];
    if (!document || !block) throw new Error('Document fixture did not load');

    const enqueued = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: '@doc add two follow-up paragraphs.',
      targetAgentIds: agentIds,
    });
    if (!enqueued.ok) throw new Error(`enqueue failed: ${enqueued.reason}`);

    mockResolvedExecution('Added.', {
      onExecute: async (executeToolCall) => {
        const result = await executeToolCall('apply_content_edit', {
          kind: 'append',
          anchor: block.id,
          markdown: 'First follow-up.\n\nSecond follow-up.',
        });
        expect(result.isError).not.toBe(true);
        expect(JSON.parse(result.result).editIds).toHaveLength(1);
      },
    });
    await processTalkRunMessage({
      runId: enqueued.runs[0]!.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });

    const db = getDbPg();
    const edits = await db<
      Array<{
        op: string;
        after_block_id: string | null;
        base_list_version: number | null;
        new_kind: string | null;
        new_text: string | null;
      }>
    >`
      select op, after_block_id, base_list_version, new_kind, new_text
      from public.document_edits
      where workspace_id = ${workspaceId}::uuid
        and document_id = ${document.id}::uuid
        and status = 'pending'
    `;
    expect(edits).toEqual([
      {
        op: 'insert',
        after_block_id: block.id,
        base_list_version: document.list_version,
        new_kind: 'p',
        new_text: 'First follow-up.\n\nSecond follow-up.',
      },
    ]);
  });

  it('rejects bulk document edits until grouped acceptance is implemented', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const createdDocument = await createGreenfieldDocumentForTalk({
      workspaceId,
      talkId,
      title: 'Launch Draft',
      format: 'markdown',
    });
    await replaceGreenfieldDocumentBlocks({
      workspaceId,
      documentId: createdDocument.id,
      tabId: createdDocument.tab_id,
      blocks: [
        { kind: 'p', text: 'First paragraph.' },
        { kind: 'p', text: 'Second paragraph.' },
      ],
    });
    const document = await getGreenfieldDocumentForTalk({
      workspaceId,
      talkId,
    });
    if (!document) throw new Error('Document fixture did not load');

    const enqueued = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: '@doc rewrite the whole document.',
      targetAgentIds: agentIds,
    });
    if (!enqueued.ok) throw new Error(`enqueue failed: ${enqueued.reason}`);

    mockResolvedExecution('Could not bulk replace.', {
      onExecute: async (executeToolCall) => {
        const result = await executeToolCall('apply_content_edit', {
          kind: 'bulk',
          markdown: 'Replacement body.',
        });
        expect(result).toMatchObject({
          isError: true,
          result:
            "Error: `kind` must be one of 'append', 'replace', or 'delete'.",
        });
      },
    });
    await processTalkRunMessage({
      runId: enqueued.runs[0]!.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });

    const db = getDbPg();
    const editRows = await db<Array<{ count: number }>>`
      select count(*)::int as count
      from public.document_edits
      where workspace_id = ${workspaceId}::uuid
        and document_id = ${document.id}::uuid
    `;
    expect(editRows[0]?.count).toBe(0);
    const events = await db<{ event_type: string }[]>`
      select event_type
      from public.event_outbox
      where topic = ${`talk:${talkId}`}
        and event_type like 'content_edit_%'
      order by event_id asc
    `;
    expect(events.map((event) => event.event_type)).toEqual([
      'content_edit_run_started',
      'content_edit_run_aborted',
    ]);
  });

  it('does not expose document edit tools to job runs with attached documents', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const createdDocument = await createGreenfieldDocumentForTalk({
      workspaceId,
      talkId,
      title: 'Launch Draft',
      format: 'markdown',
    });
    await replaceGreenfieldDocumentBlocks({
      workspaceId,
      documentId: createdDocument.id,
      tabId: createdDocument.tab_id,
      blocks: [{ kind: 'p', text: 'Old intro paragraph.' }],
    });
    const document = await getGreenfieldDocumentForTalk({
      workspaceId,
      talkId,
    });
    const block = document?.blocks[0];
    if (!document || !block) throw new Error('Document fixture did not load');

    const job = await createGreenfieldJob({
      workspaceId,
      talkId,
      title: 'Doc-safe job',
      prompt: '@doc replace the first paragraph.',
      agentId: agentIds[0]!,
      schedule: { kind: 'interval', everyHours: 1 },
      timezone: 'UTC',
      sourceScope: { allowWeb: false, toolIds: [] },
      createdBy: USER_ID,
    });
    const runNow = await createGreenfieldJobRunNow({
      workspaceId,
      talkId,
      jobId: job.id,
      requestedBy: USER_ID,
    });
    if (runNow.status !== 'enqueued') {
      throw new Error(`Expected job run to enqueue, got ${runNow.status}`);
    }

    const { calls } = mockResolvedExecution('Job answer', {
      onExecute: async (executeToolCall) => {
        const result = await executeToolCall('apply_content_edit', {
          kind: 'replace',
          anchor: block.id,
          markdown: 'Unauthorized job edit.',
          rationale: 'Jobs are read-only.',
        });
        expect(result).toMatchObject({
          isError: true,
          result:
            'Error: apply_content_edit is not available for scheduled job runs',
        });
      },
    });
    await processTalkRunMessage({
      runId: runNow.runId,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.forceToolUseOnFirstIteration).toBe(false);
    expect(calls[0]!.context.contextToolNames).not.toContain(
      'apply_content_edit',
    );
    expect(calls[0]!.context.systemPrompt).toContain(
      'scheduled jobs cannot edit the Talk document',
    );
    expect(calls[0]!.context.systemPrompt).not.toContain('apply_content_edit');

    const db = getDbPg();
    const edits = await db<Array<{ count: number }>>`
      select count(*)::int as count
      from public.document_edits
      where workspace_id = ${workspaceId}::uuid
        and document_id = ${document.id}::uuid
    `;
    expect(edits[0]?.count).toBe(0);

    const events = await db<{ event_type: string }[]>`
      select event_type
      from public.event_outbox
      where topic = ${`talk:${talkId}`}
        and event_type like 'content_edit_%'
      order by event_id asc
    `;
    expect(events).toEqual([]);
  });

  it('builds a downstream greenfield ordered prompt from prior completed outputs', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture({
      agentCount: 3,
    });
    const enqueued = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: 'Evaluate the doc.',
      targetAgentIds: agentIds,
    });
    if (!enqueued.ok) throw new Error(`enqueue failed: ${enqueued.reason}`);
    const firstRun = enqueued.runs[0]!;
    const secondRun = enqueued.runs[1]!;
    if (!firstRun.response_group_id || secondRun.sequence_index === null) {
      throw new Error('ordered run fixture missing response group metadata');
    }

    const db = getDbPg();
    await db`
      update public.runs
      set status = 'completed', started_at = now(), finished_at = now()
      where id = ${firstRun.id}::uuid
    `;
    await db`
      insert into public.messages (
        workspace_id, talk_id, round, author_kind, agent_snapshot_id, run_id, body
      )
      select workspace_id, talk_id, round, 'agent', agent_snapshot_id, id,
             'PRIOR_AGENT_ANALYSIS_XYZ'
      from public.runs
      where id = ${firstRun.id}::uuid
    `;

    const result = await buildGreenfieldStepUserMessageText({
      workspaceId,
      talkId,
      triggerContent: 'evaluate the doc',
      talkMode: 'ordered',
      responseGroupId: firstRun.response_group_id,
      sequenceIndex: secondRun.sequence_index,
    });

    expect(result.userMessageText).toContain('evaluate the doc');
    expect(result.userMessageText).toContain('PRIOR_AGENT_ANALYSIS_XYZ');
    expect(result.isSynthesis).toBe(false);
  });

  it('does not inject prior ordered outputs from another talk with the same response group id', async () => {
    const firstFixture = await createTalkFixture({
      agentCount: 2,
    });
    const secondFixture = await createTalkFixture({
      agentCount: 2,
    });
    const firstEnqueued = await enqueueGreenfieldChatTurn({
      workspaceId: firstFixture.workspaceId,
      talkId: firstFixture.talkId,
      userId: USER_ID,
      content: 'Analyze the first talk.',
      targetAgentIds: firstFixture.agentIds,
    });
    if (!firstEnqueued.ok) {
      throw new Error(`enqueue failed: ${firstEnqueued.reason}`);
    }
    const secondEnqueued = await enqueueGreenfieldChatTurn({
      workspaceId: secondFixture.workspaceId,
      talkId: secondFixture.talkId,
      userId: USER_ID,
      content: 'Analyze the second talk.',
      targetAgentIds: secondFixture.agentIds,
    });
    if (!secondEnqueued.ok) {
      throw new Error(`enqueue failed: ${secondEnqueued.reason}`);
    }
    const foreignFirstRun = firstEnqueued.runs[0]!;
    const secondTalkSecondRun = secondEnqueued.runs[1]!;
    if (
      !foreignFirstRun.response_group_id ||
      secondTalkSecondRun.sequence_index === null
    ) {
      throw new Error('ordered run fixture missing response group metadata');
    }

    const db = getDbPg();
    await db`
      update public.runs
      set status = 'completed', started_at = now(), finished_at = now()
      where id = ${foreignFirstRun.id}::uuid
    `;
    await db`
      insert into public.messages (
        workspace_id, talk_id, round, author_kind, agent_snapshot_id, run_id, body
      )
      select workspace_id, talk_id, round, 'agent', agent_snapshot_id, id,
             'FOREIGN_TALK_PRIOR_OUTPUT'
      from public.runs
      where id = ${foreignFirstRun.id}::uuid
    `;
    await db`
      update public.runs
      set response_group_id = ${foreignFirstRun.response_group_id}
      where id = ${secondTalkSecondRun.id}::uuid
    `;

    const result = await buildGreenfieldStepUserMessageText({
      workspaceId: secondFixture.workspaceId,
      talkId: secondFixture.talkId,
      triggerContent: 'evaluate the second talk',
      talkMode: 'ordered',
      responseGroupId: foreignFirstRun.response_group_id,
      sequenceIndex: secondTalkSecondRun.sequence_index,
    });

    expect(result.userMessageText).toBe('evaluate the second talk');
    expect(result.userMessageText).not.toContain('FOREIGN_TALK_PRIOR_OUTPUT');
    expect(result.isSynthesis).toBe(false);
  });

  it('marks the final greenfield ordered step as synthesis and surfaces gaps', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture({
      agentCount: 3,
    });
    const enqueued = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: 'Synthesize the round.',
      targetAgentIds: agentIds,
    });
    if (!enqueued.ok) throw new Error(`enqueue failed: ${enqueued.reason}`);
    const firstRun = enqueued.runs[0]!;
    const secondRun = enqueued.runs[1]!;
    const thirdRun = enqueued.runs[2]!;
    if (!thirdRun.response_group_id || thirdRun.sequence_index === null) {
      throw new Error('ordered run fixture missing response group metadata');
    }

    const db = getDbPg();
    await db`
      update public.runs
      set status = 'failed', finished_at = now()
      where id = ${firstRun.id}::uuid
    `;
    await db`
      update public.runs
      set status = 'completed', started_at = now(), finished_at = now()
      where id = ${secondRun.id}::uuid
    `;
    await db`
      insert into public.messages (
        workspace_id, talk_id, round, author_kind, agent_snapshot_id, run_id, body
      )
      select workspace_id, talk_id, round, 'agent', agent_snapshot_id, id,
             'SECOND_AGENT_TAKE'
      from public.runs
      where id = ${secondRun.id}::uuid
    `;

    const result = await buildGreenfieldStepUserMessageText({
      workspaceId,
      talkId,
      triggerContent: 'synthesize the round',
      talkMode: 'ordered',
      responseGroupId: thirdRun.response_group_id,
      sequenceIndex: thirdRun.sequence_index,
    });

    expect(result.isSynthesis).toBe(true);
    expect(result.userMessageText).toContain('SECOND_AGENT_TAKE');
    expect(result.userMessageText).toContain(
      'Unavailable earlier ordered steps',
    );
  });

  it('returns the bare trigger for the first greenfield ordered step', async () => {
    const result = await buildGreenfieldStepUserMessageText({
      workspaceId: '00000000-0000-4000-8000-000000000000',
      talkId: '00000000-0000-4000-8000-000000000001',
      triggerContent: 'first step content',
      talkMode: 'ordered',
      responseGroupId: 'text-response-group',
      sequenceIndex: 0,
    });

    expect(result.userMessageText).toBe('first step content');
    expect(result.isSynthesis).toBe(false);
  });

  it('injects prior ordered outputs before running a downstream synthesis step', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture({
      agentCount: 2,
    });
    const enqueued = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: 'Compare the options.',
      targetAgentIds: agentIds,
    });
    if (!enqueued.ok) throw new Error(`enqueue failed: ${enqueued.reason}`);
    const firstRun = enqueued.runs[0]!;
    const secondRun = enqueued.runs[1]!;

    const db = getDbPg();
    await db`
      update public.runs
      set status = 'completed', started_at = now(), finished_at = now()
      where id = ${firstRun.id}::uuid
    `;
    await db`
      insert into public.messages (
        workspace_id, talk_id, round, author_kind, agent_snapshot_id, run_id, body
      )
      select workspace_id, talk_id, round, 'agent', agent_snapshot_id, id,
             'FIRST_AGENT_ANALYSIS'
      from public.runs
      where id = ${firstRun.id}::uuid
    `;

    const { calls } = mockResolvedExecution('Synthesis answer');
    await processTalkRunMessage({
      runId: secondRun.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.userMessage).toContain('Compare the options.');
    expect(calls[0]!.userMessage).toContain('FIRST_AGENT_ANALYSIS');
    expect(calls[0]!.userMessage).toContain('Synthesize these perspectives');
  });

  it('does not inject prior outputs for parallel downstream steps', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture({
      agentCount: 2,
      mode: 'parallel',
    });
    const enqueued = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: 'Compare the options.',
      targetAgentIds: agentIds,
    });
    if (!enqueued.ok) throw new Error(`enqueue failed: ${enqueued.reason}`);
    const firstRun = enqueued.runs[0]!;
    const secondRun = enqueued.runs[1]!;

    const db = getDbPg();
    await db`
      update public.runs
      set status = 'completed', started_at = now(), finished_at = now()
      where id = ${firstRun.id}::uuid
    `;
    await db`
      insert into public.messages (
        workspace_id, talk_id, round, author_kind, agent_snapshot_id, run_id, body
      )
      select workspace_id, talk_id, round, 'agent', agent_snapshot_id, id,
             'FIRST_AGENT_ANALYSIS'
      from public.runs
      where id = ${firstRun.id}::uuid
    `;

    const { calls } = mockResolvedExecution('Parallel answer');
    await processTalkRunMessage({
      runId: secondRun.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.userMessage).toBe('Compare the options.');
    expect(calls[0]!.userMessage).not.toContain('FIRST_AGENT_ANALYSIS');
    expect(calls[0]!.userMessage).not.toContain(
      'Synthesize these perspectives',
    );
  });
});

describe('raceToolCallDeadline', () => {
  it('passes through a call that settles before the deadline', async () => {
    await expect(
      raceToolCallDeadline(
        Promise.resolve({ result: 'ok' }),
        'web_search',
        1_000,
      ),
    ).resolves.toEqual({ result: 'ok' });
  });

  it('abandons a wedged call at the deadline with a tool error', async () => {
    const wedged = new Promise<{ result: string }>(() => {});
    const result = await raceToolCallDeadline(wedged, 'web_search', 30);
    expect(result.isError).toBe(true);
    expect(result.result).toContain('did not return within');
  });

  it('propagates rejections from the underlying call', async () => {
    await expect(
      raceToolCallDeadline(
        Promise.reject(new Error('boom')),
        'web_search',
        1_000,
      ),
    ).rejects.toThrow('boom');
  });
});
