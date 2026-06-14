// Write-behind default persister against real Postgres (Talk Runtime v2, Wave 2
// PR-B). Node suite. Proves the system-of-record half of the contract that the
// workers-pool DO-orchestration test cannot (it has no Postgres):
//   • terminal persist → the SNAPSHOT shows the run completed (hard-refresh
//     survival: the snapshot API reads Postgres);
//   • idempotent (re-flush after a committed terminal is a no-op, no duplicate
//     message, no second outbox event);
//   • monotonic (a committed terminal never regresses — fail/cancel after
//     complete is a no-op);
//   • the new single-run cancel accessor matches the talk_run_cancelled shape.
//
// MUTATION-VERIFY (the monotonic guard, both directions): see the inline NOTE on
// the monotonic test for how to confirm it is load-bearing.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import {
  closePgDatabase,
  getDbPg,
  initPgDatabase,
  withUserContext,
} from '../../db.js';
import { getOutboxEventsForTopics } from '../db/core-accessors.js';
import { ensureWorkspaceBootstrapForUser } from '../workspaces/bootstrap.js';
import {
  createGreenfieldTalk,
  listDefaultTalkAgentIds,
} from './greenfield-accessors.js';
import { enqueueGreenfieldChatTurn } from './greenfield-chat-accessors.js';
import { listGreenfieldRuns } from './greenfield-detail-accessors.js';
import { getGreenfieldQueueRunById } from './greenfield-run-accessors.js';
import {
  createDefaultRunStatePersister,
  type RunCompletedPayload,
} from './talk-runner-write-behind.js';

const TEST_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54432/postgres';
const OWNER_ID = '0c333333-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const persister = createDefaultRunStatePersister();

async function seedAuthUser(id: string, email: string): Promise<void> {
  const db = getDbPg();
  await db`
    insert into auth.users (id, email, raw_user_meta_data)
    values (${id}::uuid, ${email}::text, jsonb_build_object('full_name', ${email}::text))
    on conflict (id) do nothing
  `;
}

async function purge(): Promise<void> {
  const db = getDbPg();
  await db`delete from public.event_outbox where topic like 'talk:%' or topic like 'user:%'`;
  await db`delete from public.workspaces where owner_id = ${OWNER_ID}::uuid`;
}

async function setupQueuedRun(): Promise<{
  workspaceId: string;
  talkId: string;
  runId: string;
}> {
  const workspaceId = await ensureWorkspaceBootstrapForUser(OWNER_ID);
  return withUserContext(OWNER_ID, async () => {
    const agentIds = (await listDefaultTalkAgentIds({ workspaceId })).slice(
      0,
      1,
    );
    const talk = await createGreenfieldTalk({
      workspaceId,
      createdBy: OWNER_ID,
      title: 'Write-behind Test Talk',
      agentIds,
    });
    const turn = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId: talk.id,
      userId: OWNER_ID,
      content: 'trigger me',
      targetAgentIds: agentIds,
    });
    if (!turn.ok) throw new Error(`enqueue failed: ${turn.reason}`);
    return { workspaceId, talkId: talk.id, runId: turn.runs[0]!.id };
  });
}

function completedPayload(
  runId: string,
  run: {
    target_agent_id: string | null;
    target_agent_name: string | null;
    provider_id: string;
    model_id: string;
  },
  content: string,
): RunCompletedPayload {
  return {
    runId,
    responseMessageId: randomUUID(),
    responseContent: content,
    responseMetadata: null,
    agentId: run.target_agent_id,
    agentNickname: run.target_agent_name,
    providerId: run.provider_id,
    modelId: run.model_id,
    latencyMs: 123,
    usage: { inputTokens: 10, outputTokens: 5 },
    responseSequenceInRun: 0,
  };
}

async function countResponseMessages(
  workspaceId: string,
  runId: string,
): Promise<number> {
  const rows = await getDbPg()<{ n: number }[]>`
    select count(*)::int as n from public.messages
    where workspace_id = ${workspaceId}::uuid and run_id = ${runId}::uuid
  `;
  return rows[0]?.n ?? 0;
}

beforeAll(async () => {
  await initPgDatabase({ url: TEST_DB_URL });
  await seedAuthUser(OWNER_ID, 'write-behind-test@clawtalk.test');
});

afterAll(async () => {
  await purge();
  await closePgDatabase();
});

beforeEach(purge);

describe('write-behind default persister', () => {
  it('claims running then persists a completed run that survives a snapshot read (hard refresh)', async () => {
    const { workspaceId, talkId, runId } = await setupQueuedRun();

    const claim = await persister.claimRunning(runId);
    expect(claim.status).toBe('claimed');
    if (claim.status !== 'claimed') throw new Error('unreachable');
    expect((await getGreenfieldQueueRunById(runId))?.status).toBe('running');

    const completed = await persister.persistCompleted(
      completedPayload(runId, claim.run, 'the answer is 42'),
    );
    expect(completed.applied).toBe(true);

    // System of record reflects the terminal state.
    expect((await getGreenfieldQueueRunById(runId))?.status).toBe('completed');

    // Hard-refresh: the snapshot API (listGreenfieldRuns, user-scoped) shows it
    // completed, and the response message is durably present.
    const snapshot = await withUserContext(OWNER_ID, () =>
      listGreenfieldRuns({ workspaceId, talkId }),
    );
    const snapRun = snapshot.find((r) => r.id === runId);
    expect(snapRun?.status).toBe('completed');
    expect(await countResponseMessages(workspaceId, runId)).toBe(1);

    const events = await getOutboxEventsForTopics([`talk:${talkId}`], 0);
    expect(events.some((e) => e.event_type === 'talk_run_completed')).toBe(
      true,
    );
  });

  it('is idempotent: a second persistCompleted is a no-op with no duplicate message or event', async () => {
    const { workspaceId, talkId, runId } = await setupQueuedRun();
    const claim = await persister.claimRunning(runId);
    if (claim.status !== 'claimed') throw new Error('claim failed');

    expect(
      (
        await persister.persistCompleted(
          completedPayload(runId, claim.run, 'first'),
        )
      ).applied,
    ).toBe(true);
    // Re-flush (e.g. restart re-flush after a crash that lost the synced flag).
    expect(
      (
        await persister.persistCompleted(
          completedPayload(runId, claim.run, 'second'),
        )
      ).applied,
    ).toBe(false);

    expect(await countResponseMessages(workspaceId, runId)).toBe(1);
    const completedEvents = (
      await getOutboxEventsForTopics([`talk:${talkId}`], 0)
    ).filter((e) => e.event_type === 'talk_run_completed');
    expect(completedEvents).toHaveLength(1);
  });

  it('is monotonic: fail/cancel after a committed completion are no-ops', async () => {
    // MUTATION-VERIFY: the monotonicity here comes from the accessors' in-tx
    // `where status='running'` CAS. Flip completeGreenfieldRun /
    // failGreenfieldRun / cancelGreenfieldRunForDo to `where status is not null`
    // (drop the running guard) and this test fails BOTH directions: persistFailed
    // would regress completed→failed (applied:true) and the snapshot status would
    // change. With the guard, both stay no-ops.
    const { runId } = await setupQueuedRun();
    const claim = await persister.claimRunning(runId);
    if (claim.status !== 'claimed') throw new Error('claim failed');
    await persister.persistCompleted(
      completedPayload(runId, claim.run, 'done'),
    );

    expect(
      (
        await persister.persistFailed({
          runId,
          errorCode: 'x',
          errorMessage: 'y',
        })
      ).applied,
    ).toBe(false);
    expect((await persister.persistCancelled({ runId })).applied).toBe(false);
    expect((await getGreenfieldQueueRunById(runId))?.status).toBe('completed');
  });

  it('persists a cancelled run with the talk_run_cancelled event shape (single run)', async () => {
    const { talkId, runId } = await setupQueuedRun();
    const claim = await persister.claimRunning(runId);
    if (claim.status !== 'claimed') throw new Error('claim failed');

    const cancelled = await persister.persistCancelled({
      runId,
      cancelledBy: OWNER_ID,
    });
    expect(cancelled.applied).toBe(true);
    expect((await getGreenfieldQueueRunById(runId))?.status).toBe('cancelled');

    const events = await getOutboxEventsForTopics([`talk:${talkId}`], 0);
    const cancelEvent = events.find(
      (e) => e.event_type === 'talk_run_cancelled',
    );
    expect(cancelEvent).toBeDefined();
    expect((cancelEvent!.payload as { runIds: string[] }).runIds).toEqual([
      runId,
    ]);

    // Idempotent re-flush.
    expect((await persister.persistCancelled({ runId })).applied).toBe(false);
  });

  it('persists a failed run and is idempotent on re-flush', async () => {
    const { talkId, runId } = await setupQueuedRun();
    const claim = await persister.claimRunning(runId);
    if (claim.status !== 'claimed') throw new Error('claim failed');

    expect(
      (
        await persister.persistFailed({
          runId,
          errorCode: 'talk_runner_step_failed',
          errorMessage: 'boom',
        })
      ).applied,
    ).toBe(true);
    expect((await getGreenfieldQueueRunById(runId))?.status).toBe('failed');
    expect(
      (
        await persister.persistFailed({
          runId,
          errorCode: 'talk_runner_step_failed',
          errorMessage: 'boom',
        })
      ).applied,
    ).toBe(false);

    const failedEvents = (
      await getOutboxEventsForTopics([`talk:${talkId}`], 0)
    ).filter((e) => e.event_type === 'talk_run_failed');
    expect(failedEvents).toHaveLength(1);
  });

  it('claimRunning reports terminal for an already-cancelled run (no claim)', async () => {
    const { runId } = await setupQueuedRun();
    const claim = await persister.claimRunning(runId);
    if (claim.status !== 'claimed') throw new Error('claim failed');
    await persister.persistCancelled({ runId });
    // A second claim attempt must not resurrect a terminal run.
    const second = await persister.claimRunning(runId);
    expect(second.status).toBe('terminal');
  });

  it('stamps runs.runtime from the dispatch flag (do vs the queue default)', async () => {
    const workspaceId = await ensureWorkspaceBootstrapForUser(OWNER_ID);
    const { doRunId, queueRunId } = await withUserContext(
      OWNER_ID,
      async () => {
        const agentIds = (await listDefaultTalkAgentIds({ workspaceId })).slice(
          0,
          1,
        );
        const doTalk = await createGreenfieldTalk({
          workspaceId,
          createdBy: OWNER_ID,
          title: 'Runtime Marker Do',
          agentIds,
        });
        const doTurn = await enqueueGreenfieldChatTurn({
          workspaceId,
          talkId: doTalk.id,
          userId: OWNER_ID,
          content: 'hi',
          targetAgentIds: agentIds,
          runtime: 'do',
        });
        const queueTalk = await createGreenfieldTalk({
          workspaceId,
          createdBy: OWNER_ID,
          title: 'Runtime Marker Queue',
          agentIds,
        });
        const queueTurn = await enqueueGreenfieldChatTurn({
          workspaceId,
          talkId: queueTalk.id,
          userId: OWNER_ID,
          content: 'hi',
          targetAgentIds: agentIds,
          // no runtime → default 'queue'
        });
        if (!doTurn.ok || !queueTurn.ok) throw new Error('enqueue failed');
        return {
          doRunId: doTurn.runs[0]!.id,
          queueRunId: queueTurn.runs[0]!.id,
        };
      },
    );
    const rows = await getDbPg()<{ id: string; runtime: string }[]>`
      select id, runtime from public.runs where id in (${doRunId}::uuid, ${queueRunId}::uuid)
    `;
    const byId = new Map(rows.map((r) => [r.id, r.runtime]));
    expect(byId.get(doRunId)).toBe('do');
    expect(byId.get(queueRunId)).toBe('queue');
  });
});
