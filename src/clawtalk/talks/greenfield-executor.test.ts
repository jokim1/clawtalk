import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

vi.mock('../agents/agent-router.js', () => ({
  executeWithResolvedAgent: vi.fn(),
}));
vi.mock('./attachment-storage.js', () => ({
  loadPageImage: vi.fn(),
}));

import { closePgDatabase, getDbPg, initPgDatabase } from '../../db.js';
import { executeWithResolvedAgent } from '../agents/agent-router.js';
import type { LlmContentBlock } from '../agents/llm-client.js';
import { ensureWorkspaceBootstrapForUser } from '../workspaces/bootstrap.js';
import { loadPageImage } from './attachment-storage.js';
import {
  createGreenfieldTalk,
  listDefaultTalkAgentIds,
} from './greenfield-accessors.js';
import { enqueueGreenfieldChatTurn } from './greenfield-chat-accessors.js';
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

function mockResolvedExecution(content: string): {
  calls: Array<{
    agent: { id: string; system_prompt: string | null; model_id: string };
    context: { systemPrompt: string };
    userMessage: string | LlmContentBlock[];
    effectiveTools: Array<{
      toolFamily: string;
      enabled: boolean;
      runtimeTools: string[];
      requiresApproval: boolean;
    }>;
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
        },
        context: {
          systemPrompt: context?.systemPrompt ?? '',
        },
        userMessage,
        effectiveTools: options.effectiveTools ?? [],
        credentialScope: options.credentialScope,
      });
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
