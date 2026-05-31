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

import { closePgDatabase, getDbPg, initPgDatabase } from '../../db.js';
import { executeWithResolvedAgent } from '../agents/agent-router.js';
import { ensureWorkspaceBootstrapForUser } from '../workspaces/bootstrap.js';
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

async function createTalkFixture(options?: { agentCount?: number }): Promise<{
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
    mode: 'ordered',
    roundsLimit: 3,
    agentIds,
  });
  return { workspaceId, talkId: talk.id, agentIds };
}

function mockResolvedExecution(content: string): {
  calls: Array<{
    agent: { id: string; system_prompt: string | null; model_id: string };
    context: { systemPrompt: string };
    userMessage: string;
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
        userMessage: typeof userMessage === 'string' ? userMessage : '',
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
        workspace_id, talk_id, kind, name, extracted_text, added_by_user_id
      )
      values (
        ${workspaceId}::uuid,
        ${talkId}::uuid,
        'rule',
        'Launch rules',
        'Use clear milestones.',
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
    expect(calls[0]!.context.systemPrompt).toContain('Launch rules');
    expect(calls[0]!.context.systemPrompt).toContain('Use clear milestones.');
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
});
