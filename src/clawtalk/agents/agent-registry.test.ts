// T-new-A: resolveTalkAgentMentionsFromList parity + behavior.
//
// The Option A dedupe in enqueueTalkChat replaces a re-read of
// talk_agents with a pure-function call against the already-loaded
// list. These tests pin:
//   - the pure mention-resolution logic (FromList, no DB)
//   - parity between FromList and the IO-wrapper resolveTalkAgentMentions
//     across content fixtures, against real DB state. Parity is
//     structurally guaranteed by the refactor (the wrapper now calls
//     the pure variant), but the test guards future drift.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closePgDatabase,
  getDbPg,
  initPgDatabase,
  withUserContext,
} from '../../db.js';
import { createTalk } from '../db/accessors.js';
import { createRegisteredAgent } from '../db/agent-accessors.js';
import type { TalkAgentAssignment } from '../db/talk-agents.js';
import {
  listTalkAgents,
  resolveTalkAgentMentions,
  resolveTalkAgentMentionsFromList,
  setTalkAgents,
} from './agent-registry.js';

const TEST_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54432/postgres';
const OWNER_ID = '0c888888-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

async function seedAuthUser(id: string, email: string): Promise<void> {
  const db = getDbPg();
  await db`
    insert into auth.users (id, email, raw_user_meta_data)
    values (${id}::uuid, ${email}::text,
            jsonb_build_object('full_name', ${email}::text))
    on conflict (id) do nothing
  `;
}

async function purge(): Promise<void> {
  const db = getDbPg();
  await db`delete from public.talks where owner_id = ${OWNER_ID}::uuid`;
  await db`delete from public.registered_agents where owner_id = ${OWNER_ID}::uuid`;
}

function makeAssignment(
  agentId: string,
  agentName: string,
  nickname: string,
  isPrimary = false,
  sortOrder = 0,
): TalkAgentAssignment {
  return {
    assignmentId: `assign-${agentId}`,
    agentId,
    agentName,
    nickname,
    personaRole: 'assistant',
    isPrimary,
    sortOrder,
  };
}

describe('resolveTalkAgentMentionsFromList (pure)', () => {
  const alice = makeAssignment('aaaa', 'Alice', 'alice', true, 0);
  const bob = makeAssignment('bbbb', 'Bob', 'bob', false, 1);
  const carolWithNick = makeAssignment(
    'cccc',
    'Carol Engineer',
    'car',
    false,
    2,
  );

  it('no mention tokens → empty array', () => {
    const result = resolveTalkAgentMentionsFromList(
      [alice, bob],
      'hello world',
    );
    expect(result).toEqual([]);
  });

  it('empty talk_agents list → empty array', () => {
    const result = resolveTalkAgentMentionsFromList([], '@alice hi');
    expect(result).toEqual([]);
  });

  it('single mention by nickname → returns that agent', () => {
    const result = resolveTalkAgentMentionsFromList(
      [alice, bob],
      '@bob can you help',
    );
    expect(result.map((a) => a.agentId)).toEqual(['bbbb']);
  });

  it('multiple distinct mentions → returns both agents', () => {
    const result = resolveTalkAgentMentionsFromList(
      [alice, bob],
      '@alice and @bob lets talk',
    );
    expect(result.map((a) => a.agentId).sort()).toEqual(['aaaa', 'bbbb']);
  });

  it('mention matching nickname-short-form resolves correctly', () => {
    const result = resolveTalkAgentMentionsFromList(
      [alice, bob, carolWithNick],
      '@car please draft this',
    );
    expect(result.map((a) => a.agentId)).toEqual(['cccc']);
  });

  it('unknown mention with no alias match → empty array (fallback)', () => {
    const result = resolveTalkAgentMentionsFromList(
      [alice, bob],
      '@zoe are you here',
    );
    expect(result).toEqual([]);
  });
});

describe('resolveTalkAgentMentionsFromList ↔ resolveTalkAgentMentions parity', () => {
  beforeAll(async () => {
    await initPgDatabase({ url: TEST_DB_URL });
    await seedAuthUser(OWNER_ID, 'agent-registry-test@clawtalk.test');
  });

  afterAll(async () => {
    await purge();
    await closePgDatabase();
  });

  beforeEach(async () => {
    await purge();
  });

  it('produces identical output across 5 content fixtures', async () => {
    await withUserContext(OWNER_ID, async () => {
      const agentA = await createRegisteredAgent({
        ownerId: OWNER_ID,
        name: 'Alpha',
        providerId: 'provider.openai',
        modelId: 'gpt-5-mini',
      });
      const agentB = await createRegisteredAgent({
        ownerId: OWNER_ID,
        name: 'Beta',
        providerId: 'provider.openai',
        modelId: 'gpt-5-mini',
      });

      const talk = await createTalk({
        ownerId: OWNER_ID,
        topicTitle: 'parity test',
      });

      await setTalkAgents({
        talkId: talk.id,
        ownerId: OWNER_ID,
        agents: [
          {
            id: agentA.id,
            sourceKind: 'provider',
            providerId: 'provider.openai',
            modelId: 'gpt-5-mini',
            nickname: 'alpha',
            nicknameMode: 'custom',
            personaRole: 'assistant',
            isPrimary: true,
            sortOrder: 0,
          },
          {
            id: agentB.id,
            sourceKind: 'provider',
            providerId: 'provider.openai',
            modelId: 'gpt-5-mini',
            nickname: 'beta',
            nicknameMode: 'custom',
            personaRole: 'assistant',
            isPrimary: false,
            sortOrder: 1,
          },
        ],
      });

      const fixtures = [
        'no mentions here at all',
        '@alpha please summarize',
        '@alpha and @beta both weigh in',
        'hey @Beta thoughts?',
        '@unknown should fall back',
      ];

      const loadedList = await listTalkAgents(talk.id);
      for (const content of fixtures) {
        const fromIO = await resolveTalkAgentMentions(talk.id, content);
        const fromList = resolveTalkAgentMentionsFromList(loadedList, content);
        // Order may differ in fallback paths; compare agentId sets.
        const ioIds = fromIO.map((a) => a.agentId).sort();
        const listIds = fromList.map((a) => a.agentId).sort();
        expect(listIds).toEqual(ioIds);
      }
    });
  });
});
