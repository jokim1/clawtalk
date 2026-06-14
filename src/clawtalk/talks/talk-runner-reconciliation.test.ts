// Path-aware reconciliation pass (Talk Runtime v2, Wave 2 PR-B). Node suite,
// real local Postgres + an injected probe (node has no DO; the workers pool has
// no Postgres — so the probe is the seam). Proves the required fixture:
//   • a do-path run the DO reports terminal → counted reconciled (flushed);
//   • a do-path orphan (DO has no record) → FLAGGED failed;
//   • a queue-path run during the soak → NOT scanned, NOT touched.
//
// MUTATION-VERIFY (path-awareness, BOTH directions): the "does not scan / flag
// the queue-path run" assertions are load-bearing — drop `runtime = 'do'` from
// the candidate query in talk-runner-reconciliation.ts and `probeCalls` gains
// the queue-path runId and it gets flagged, failing this test. With the filter,
// the queue-path run is never probed and stays 'running'.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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
import { getGreenfieldQueueRunById } from './greenfield-run-accessors.js';
import {
  runTalkRunnerReconciliation,
  type ReconcileAction,
  type ReconcileProbe,
  type ReconcileRedispatch,
} from './talk-runner-reconciliation.js';

// A re-dispatch seam that records which runs it was asked to re-drive (no-op:
// node has no DO, so the run's PG status is left untouched).
function recordingRedispatch(): {
  redispatch: ReconcileRedispatch;
  calls: string[];
} {
  const calls: string[] = [];
  return { redispatch: async ({ runId }) => void calls.push(runId), calls };
}

const TEST_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54432/postgres';
const OWNER_ID = '0c444444-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

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

// Create a talk + a single queued run, then force its (runtime, status,
// created_at) to model a reconciliation candidate.
async function seedRun(opts: {
  runtime: 'queue' | 'do';
  status: 'queued' | 'running';
  ageMinutes: number;
}): Promise<{ talkId: string; runId: string }> {
  const workspaceId = await ensureWorkspaceBootstrapForUser(OWNER_ID);
  const created = await withUserContext(OWNER_ID, async () => {
    const agentIds = (await listDefaultTalkAgentIds({ workspaceId })).slice(
      0,
      1,
    );
    const talk = await createGreenfieldTalk({
      workspaceId,
      createdBy: OWNER_ID,
      title: 'Reconciliation Test Talk',
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
    return { talkId: talk.id, runId: turn.runs[0]!.id };
  });
  // Force the run into the desired reconciliation-candidate state as the node
  // superuser (outside withUserContext, where getDbPg is the RLS-scoped
  // `authenticated` role that cannot UPDATE runs directly). Pure test setup.
  await getDbPg()`
    update public.runs
    set runtime = ${opts.runtime},
        status = ${opts.status},
        started_at = case
          when ${opts.status} = 'running'
            then now() - (${opts.ageMinutes} || ' minutes')::interval
          else null
        end,
        created_at = now() - (${opts.ageMinutes} || ' minutes')::interval
    where id = ${created.runId}::uuid
  `;
  return created;
}

// An ordered do-path round: two sibling runs (seq 0 running, seq 1 queued) in
// one response group. Models the DO's sequential loop mid-round — seq 1 is
// legitimately blocked, NOT orphaned.
async function seedOrderedDoRound(): Promise<{
  headRunId: string;
  blockedRunId: string;
}> {
  const workspaceId = await ensureWorkspaceBootstrapForUser(OWNER_ID);
  const runIds = await withUserContext(OWNER_ID, async () => {
    const agentIds = (await listDefaultTalkAgentIds({ workspaceId })).slice(
      0,
      2,
    );
    if (agentIds.length < 2) throw new Error('need 2 default agents');
    const talk = await createGreenfieldTalk({
      workspaceId,
      createdBy: OWNER_ID,
      title: 'Reconciliation Ordered Talk',
      agentIds,
      mode: 'ordered',
    });
    const turn = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId: talk.id,
      userId: OWNER_ID,
      content: 'trigger me',
      targetAgentIds: agentIds,
    });
    if (!turn.ok) throw new Error(`enqueue failed: ${turn.reason}`);
    // runs are returned in sequence_index order.
    return { head: turn.runs[0]!.id, blocked: turn.runs[1]!.id };
  });
  // seq 0 running (DO mid-flight, started long enough ago to be past the grace),
  // seq 1 still queued — both do-path, both old.
  await getDbPg()`
    update public.runs
    set runtime = 'do',
        created_at = now() - interval '10 minutes',
        status = case when id = ${runIds.head}::uuid then 'running' else 'queued' end,
        started_at = case
          when id = ${runIds.head}::uuid then now() - interval '10 minutes'
          else null
        end
    where id in (${runIds.head}::uuid, ${runIds.blocked}::uuid)
  `;
  return { headRunId: runIds.head, blockedRunId: runIds.blocked };
}

beforeAll(async () => {
  await initPgDatabase({ url: TEST_DB_URL });
  await seedAuthUser(OWNER_ID, 'reconciliation-test@clawtalk.test');
});

afterAll(async () => {
  await purge();
  await closePgDatabase();
});

beforeEach(purge);

describe('runTalkRunnerReconciliation (path-aware)', () => {
  it('reconciles do-path divergence, flags do-path orphans, and leaves queue-path runs alone', async () => {
    const doFlushed = await seedRun({
      runtime: 'do',
      status: 'running',
      ageMinutes: 10,
    });
    const doOrphanRunning = await seedRun({
      runtime: 'do',
      status: 'running',
      ageMinutes: 10,
    });
    const doOrphanQueued = await seedRun({
      runtime: 'do',
      status: 'queued',
      ageMinutes: 10,
    });
    const queuePath = await seedRun({
      runtime: 'queue',
      status: 'running',
      ageMinutes: 10,
    });
    const doRecent = await seedRun({
      runtime: 'do',
      status: 'running',
      ageMinutes: 0,
    });

    const actionByRun = new Map<string, ReconcileAction>([
      [doFlushed.runId, 'flushed'],
      [doOrphanRunning.runId, 'no_record'],
      [doOrphanQueued.runId, 'no_record'],
    ]);
    const probeCalls: string[] = [];
    const probe: ReconcileProbe = async ({ runId }) => {
      probeCalls.push(runId);
      return { action: actionByRun.get(runId) ?? 'probe_error', status: null };
    };
    const { redispatch, calls: redispatchCalls } = recordingRedispatch();

    const result = await runTalkRunnerReconciliation({
      probe,
      redispatch,
      graceMs: 2 * 60 * 1000,
    });

    // PATH-AWARENESS: only the do-path candidates older than the grace are probed.
    expect(probeCalls).toContain(doFlushed.runId);
    expect(probeCalls).toContain(doOrphanRunning.runId);
    expect(probeCalls).toContain(doOrphanQueued.runId);
    expect(probeCalls).not.toContain(queuePath.runId); // queue-path: never scanned
    expect(probeCalls).not.toContain(doRecent.runId); // within grace: not scanned

    expect(result.scanned).toBe(3);
    expect(result.flushed).toBe(1);
    // A no_record RUNNING orphan is flagged failed; a no_record QUEUED head is
    // RE-DRIVEN (it may be an ordered sibling the DO forgot), never failed.
    expect(result.flagged).toBe(1);
    expect(result.redispatched).toBe(1);
    expect(redispatchCalls).toEqual([doOrphanQueued.runId]);

    // The running orphan flipped to failed; the queued orphan was re-dispatched
    // (still queued — the re-drive seam is a no-op here); others untouched.
    expect(
      (await getGreenfieldQueueRunById(doOrphanRunning.runId))?.status,
    ).toBe('failed');
    expect(
      (await getGreenfieldQueueRunById(doOrphanQueued.runId))?.status,
    ).toBe('queued');
    expect((await getGreenfieldQueueRunById(doFlushed.runId))?.status).toBe(
      'running',
    );
    expect((await getGreenfieldQueueRunById(queuePath.runId))?.status).toBe(
      'running',
    );
    expect((await getGreenfieldQueueRunById(doRecent.runId))?.status).toBe(
      'running',
    );

    // The orphan flag emitted a talk_run_failed event (UI moves on).
    const events = await getOutboxEventsForTopics(
      [`talk:${doOrphanRunning.talkId}`],
      0,
    );
    const failedEvent = events.find((e) => e.event_type === 'talk_run_failed');
    expect(failedEvent).toBeDefined();
    expect((failedEvent!.payload as { errorCode: string }).errorCode).toBe(
      'do_run_orphaned',
    );
  });

  it('does not flag a BLOCKED ordered sibling as an orphan (it is legitimately waiting)', async () => {
    // Codex P1: in an ordered do-path round, a later sibling stays queued with no
    // DO record until the sequential loop reaches it. It must NOT be flagged.
    // MUTATION-VERIFY: drop the `not exists (earlier non-terminal sibling)`
    // exclusion from the candidate query and the blocked seq-1 run is scanned →
    // probed → no_record → flagged 'do_run_orphaned', failing this test.
    const { headRunId, blockedRunId } = await seedOrderedDoRound();
    const probeCalls: string[] = [];
    const probe: ReconcileProbe = async ({ runId }) => {
      probeCalls.push(runId);
      // The head (seq 0) is genuinely running in the DO; a real probe would say
      // noop_running. The blocked sibling must never reach the probe at all.
      return { action: 'noop_running', status: 'running' };
    };
    const { redispatch, calls: redispatchCalls } = recordingRedispatch();
    const result = await runTalkRunnerReconciliation({
      probe,
      redispatch,
      graceMs: 2 * 60 * 1000,
    });
    expect(probeCalls).toContain(headRunId); // running head IS scanned
    expect(probeCalls).not.toContain(blockedRunId); // blocked sibling excluded
    expect(redispatchCalls).not.toContain(blockedRunId); // never re-driven either
    expect(result.flagged).toBe(0); // nothing failed
    expect((await getGreenfieldQueueRunById(blockedRunId))?.status).toBe(
      'queued',
    ); // still waiting its turn, untouched
  });

  it('does not orphan-fail a JUST-CLAIMED running run (started_at within grace, created_at old)', async () => {
    // Codex round-5 P1: an ordered sibling created long ago that only just became
    // running (runOne claimed PG 'running' but has not yet written runs_local —
    // an await gap). The grace is gated on started_at, not created_at, so this
    // window is covered. MUTATION-VERIFY: gate running on created_at instead and
    // this run is scanned → probed → no_record → permanently orphan-failed.
    const justStarted = await seedRun({
      runtime: 'do',
      status: 'running',
      ageMinutes: 10,
    });
    // created_at stays 10min old; started_at = NOW (just claimed this instant).
    await getDbPg()`
      update public.runs set started_at = now() where id = ${justStarted.runId}::uuid
    `;
    const probeCalls: string[] = [];
    const probe: ReconcileProbe = async ({ runId }) => {
      probeCalls.push(runId);
      return { action: 'no_record', status: null };
    };
    const result = await runTalkRunnerReconciliation({
      probe,
      redispatch: recordingRedispatch().redispatch,
      graceMs: 2 * 60 * 1000,
    });
    expect(probeCalls).not.toContain(justStarted.runId); // within started_at grace
    expect(result.flagged).toBe(0);
    expect((await getGreenfieldQueueRunById(justStarted.runId))?.status).toBe(
      'running',
    ); // NOT orphan-failed
  });

  it('is a no-op during the flag-OFF soak (no do-path runs to scan)', async () => {
    await seedRun({ runtime: 'queue', status: 'running', ageMinutes: 10 });
    await seedRun({ runtime: 'queue', status: 'queued', ageMinutes: 10 });
    const probeCalls: string[] = [];
    const probe: ReconcileProbe = async ({ runId }) => {
      probeCalls.push(runId);
      return { action: 'noop_running', status: null };
    };
    const result = await runTalkRunnerReconciliation({
      probe,
      redispatch: recordingRedispatch().redispatch,
      graceMs: 2 * 60 * 1000,
    });
    expect(result.scanned).toBe(0);
    expect(probeCalls).toHaveLength(0);
  });
});
