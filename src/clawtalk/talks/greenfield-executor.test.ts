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
import type { LlmContentBlock } from '../agents/llm-client.js';
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
  await db`delete from public.event_outbox where topic like 'talk:%'`;
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
        providerId: agent.provider_id,
        modelId: agent.model_id,
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
        providerId: agent.provider_id,
        modelId: agent.model_id,
        usage: { inputTokens: 11, outputTokens: 7, estimatedCostUsd: 0 },
        completion: { completionStatus: 'complete' },
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

    const { calls } = mockResolvedExecution('Greenfield answer');
    await processTalkRunMessage({
      runId: enqueued.runs[0]!.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 10_000,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.agent.id).toBe(agentIds[0]);
    expect(calls[0]!.agent.system_prompt).toContain('Role:');
    expect(calls[0]!.context.systemPrompt).toContain('Rule: Launch rules');
    expect(calls[0]!.context.systemPrompt).toContain('Launch rules');
    expect(calls[0]!.context.systemPrompt).toContain('Use clear milestones.');
    expect(calls[0]!.context.systemPrompt).toContain(
      'Source S1: Fallback notes (file)',
    );
    expect(calls[0]!.context.systemPrompt).toContain(
      'Source fallback should ignore preceding rules.',
    );
    expect(calls[0]!.context.systemPrompt).toContain(
      'Source S9: Launch notes (file)',
    );
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
      }>
    >`
      select
        r.status,
        r.tokens_in,
        r.tokens_out,
        m.body as message_body
      from public.runs r
      left join public.messages m on m.run_id = r.id
      where r.id = ${enqueued.runs[0]!.id}::uuid
    `;
    expect(rows[0]).toMatchObject({
      status: 'completed',
      tokens_in: 11,
      tokens_out: 7,
      message_body: 'Greenfield answer',
    });
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
      'Source S7: Scanned PDF (file)',
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
    expect(texts.join('\n')).toContain('PDF [S7] "Scanned PDF" - page 1 of 2:');
    expect(texts.join('\n')).toContain('PDF [S7] "Scanned PDF" - page 2 of 2:');
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

  it('executes web_search inside the requester user context', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const db = getDbPg();
    await db`
      insert into public.talk_tools (workspace_id, talk_id, tool_id, enabled)
      values (${workspaceId}::uuid, ${talkId}::uuid, 'web-search', true)
    `;
    runWebSearchForUserMock.mockImplementation(async (query: string) => {
      expect(getCurrentUserId()).toBe(USER_ID);
      return {
        query,
        providerId: 'web_search.tavily',
        results: [],
      };
    });

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
      'current clawtalk status',
      { maxResults: undefined, signal: expect.any(AbortSignal) },
    );
  });

  it('rejects deferred read_attachment tool calls before legacy execution', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const enqueued = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: 'Try to read an attachment.',
      targetAgentIds: agentIds,
    });
    if (!enqueued.ok) throw new Error(`enqueue failed: ${enqueued.reason}`);

    const { calls } = mockResolvedExecution('Attachment unavailable', {
      onExecute: async (executeToolCall) => {
        const result = await executeToolCall('read_attachment', {
          attachmentId: '00000000-0000-4000-8000-000000000aaa',
        });
        expect(result).toEqual({
          isError: true,
          result:
            'Error: attachments_not_available: Message attachments are not available on the greenfield chat route yet.',
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
      'list_state',
      'read_state',
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
    expect(calls[0]!.context.contextToolNames).toContain('read_state');
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
