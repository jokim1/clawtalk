import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  closePgDatabase,
  deleteAuthUsers,
  getDbPg,
  initPgDatabase,
  seedAuthUser,
  seedTalk,
  purgeUserData,
} from '../../db/test-helpers.js';
import { DEV_USER_ID } from '../middleware/auth.js';
import type { AuthContext } from '../types.js';
import { _resetWorkerAppForTests, getWorkerApp } from '../worker-app.js';
import {
  dismissHomeInboxRoute,
  dismissHomeRecommendationRoute,
  getHomeSummaryRoute,
  listHomeInboxRoute,
  listHomeNewsRoute,
  listHomeRecommendationsRoute,
  snoozeHomeInboxRoute,
} from './home.js';

const USER_ID = '0c888888-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_USER_ID = '0c888888-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const EMPTY_USER_ID = '0c888888-cccc-cccc-cccc-cccccccccccc';

function auth(userId = USER_ID): AuthContext {
  return {
    sessionId: `home-${userId}`,
    userId,
    role: 'owner',
    authType: 'bearer',
  };
}

async function deleteHomeNewsFixtureItems(): Promise<void> {
  await getDbPg()`
    delete from public.home_news_items
    where content_hash like 'home-test:%'
  `;
}

async function createWorkspaceFixture(userId = USER_ID): Promise<{
  workspaceId: string;
  talkId: string;
}> {
  const talkId = await seedTalk({
    ownerId: userId,
    topicTitle: userId === USER_ID ? 'Pricing v2' : 'Other Workspace',
  });
  const rows = await getDbPg()<Array<{ workspace_id: string }>>`
    select workspace_id
    from public.talks
    where id = ${talkId}::uuid
  `;
  return { workspaceId: rows[0].workspace_id, talkId };
}

async function seedInboxItem(input: {
  workspaceId: string;
  talkId: string;
  type: string;
  title: string;
  severity: 'info' | 'action' | 'blocking';
  status?: string;
  score?: number | null;
  createdAt?: string;
  targetJson?: Record<string, unknown>;
  primaryActionJson?: Record<string, unknown>;
  storeTalkId?: boolean;
}): Promise<string> {
  const db = getDbPg();
  const targetJson = input.targetJson ?? {
    kind: 'talk',
    talkId: input.talkId,
  };
  const primaryActionJson = input.primaryActionJson ?? {
    type: 'open_talk',
    label: 'Open Talk',
    payload: { talkId: input.talkId },
  };
  const rows = await db<Array<{ id: string }>>`
    insert into public.home_inbox_items (
      workspace_id, type, target_kind, target_json, talk_id, severity, status,
      title, summary, reason, primary_action_json, score, algorithm_version,
      created_at
    )
    values (
      ${input.workspaceId}::uuid,
      ${input.type},
      'talk',
      ${db.json(targetJson as never)},
      ${input.storeTalkId === false ? null : input.talkId}::uuid,
      ${input.severity},
      ${input.status ?? 'unread'},
      ${input.title},
      ${`${input.title} summary`},
      ${`${input.title} reason`},
      ${db.json(primaryActionJson as never)},
      ${input.score ?? null},
      'inbox_test_v1',
      ${input.createdAt ?? '2026-01-01T00:00:00Z'}::timestamptz
    )
    returning id
  `;
  return rows[0].id;
}

async function seedRecommendation(input: {
  workspaceId: string;
  talkId: string;
  kind: string;
  title: string;
  priority: 'decide' | 'improve' | 'tidy';
  score: number;
  rank?: number | null;
  status?: string;
  actionType?: string;
  actionPayload?: Record<string, unknown>;
  actionJson?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
  featuresJson?: Record<string, unknown>;
  confidence?: number | null;
  expiresAt?: string | null;
}): Promise<string> {
  const db = getDbPg();
  const confidence: number | null =
    input.confidence === undefined ? 0.9 : input.confidence;
  const candidateRows = await db<Array<{ id: string }>>`
    insert into public.home_recommendation_candidates (
      workspace_id, kind, state_fingerprint, provenance_json, action_json,
      features_json, confidence, expires_at
    )
    values (
      ${input.workspaceId}::uuid,
      ${input.kind},
      ${`${input.kind}:${input.title}`},
      ${db.json((input.provenance ?? { talkId: input.talkId }) as never)},
      ${db.json(
        (input.actionJson ?? {
          type: input.actionType ?? 'open_talk',
          payload: input.actionPayload ?? { talkId: input.talkId },
        }) as never,
      )},
      ${db.json((input.featuresJson ?? { actionability: 1 }) as never)},
      ${confidence},
      ${input.expiresAt ?? null}::timestamptz
    )
    returning id
  `;
  const rows = await db<Array<{ id: string }>>`
    insert into public.home_recommendations (
      candidate_id, workspace_id, kind, title, why, priority, score, rank,
      surface, status, algorithm_version, expires_at
    )
    values (
      ${candidateRows[0].id}::uuid,
      ${input.workspaceId}::uuid,
      ${input.kind},
      ${input.title},
      ${`${input.title} why`},
      ${input.priority},
      ${input.score},
      ${input.rank ?? null},
      'recommendations',
      ${input.status ?? 'active'},
      'recommendation_test_v1',
      ${input.expiresAt ?? null}::timestamptz
    )
    returning id
  `;
  return rows[0].id;
}

async function archiveTalk(input: {
  workspaceId: string;
  talkId: string;
}): Promise<void> {
  await getDbPg()`
    update public.talks
    set archived_at = now()
    where workspace_id = ${input.workspaceId}::uuid
      and id = ${input.talkId}::uuid
  `;
}

async function deleteRecommendationCandidate(input: {
  workspaceId: string;
  kind: string;
  title: string;
}): Promise<void> {
  await getDbPg()`
    delete from public.home_recommendation_candidates
    where workspace_id = ${input.workspaceId}::uuid
      and state_fingerprint = ${`${input.kind}:${input.title}`}
  `;
}

async function seedNewsMatch(input: {
  workspaceId: string;
  talkId: string;
  title: string;
  status?: string;
  score?: number | null;
  publishedAt?: string;
}): Promise<string> {
  const db = getDbPg();
  const itemRows = await db<Array<{ id: string }>>`
    insert into public.home_news_items (
      canonical_url, title, source, source_domain, published_at, excerpt,
      content_hash
    )
    values (
      ${`https://news.example/${input.title.toLowerCase().replaceAll(' ', '-')}`},
      ${input.title},
      'Example News',
      'news.example',
      ${input.publishedAt ?? '2026-01-02T00:00:00Z'}::timestamptz,
      ${`${input.title} excerpt`},
      ${`home-test:${input.workspaceId}:${input.title}`}
    )
    on conflict (content_hash) do update set
      canonical_url = excluded.canonical_url,
      title = excluded.title,
      source = excluded.source,
      source_domain = excluded.source_domain,
      published_at = excluded.published_at,
      excerpt = excluded.excerpt
    returning id
  `;
  const topicRows = await db<Array<{ id: string }>>`
    insert into public.home_news_topics (
      workspace_id, talk_id, summary, mode, decision_type, keywords_json,
      entities_json, source_domains_json, negative_terms_json, confidence
    )
    values (
      ${input.workspaceId}::uuid,
      ${input.talkId}::uuid,
      'Pricing monitor',
      'work_context',
      'pricing',
      '["pricing"]'::jsonb,
      '["Acme"]'::jsonb,
      '["news.example"]'::jsonb,
      '[]'::jsonb,
      0.9
    )
    returning id
  `;
  const rows = await db<Array<{ id: string }>>`
    insert into public.home_news_matches (
      workspace_id, news_item_id, topic_id, talk_id, matched_on_json, impact,
      why_it_matters, score, confidence, status, algorithm_version
    )
    values (
      ${input.workspaceId}::uuid,
      ${itemRows[0].id}::uuid,
      ${topicRows[0].id}::uuid,
      ${input.talkId}::uuid,
      jsonb_build_object('keywords', jsonb_build_array('pricing')),
      'changes_assumption',
      ${`${input.title} matters`},
      ${input.score ?? null},
      0.8,
      ${input.status ?? 'active'},
      'news_test_v1'
    )
    returning id
  `;
  return rows[0].id;
}

beforeAll(async () => {
  await initPgDatabase();
  await seedAuthUser({ id: USER_ID, email: 'home-a@clawtalk.local' });
  await seedAuthUser({ id: OTHER_USER_ID, email: 'home-b@clawtalk.local' });
  await seedAuthUser({ id: EMPTY_USER_ID, email: 'home-empty@clawtalk.local' });
  await seedAuthUser({ id: DEV_USER_ID, email: 'dev-home@clawtalk.local' });
});

afterAll(async () => {
  await purgeUserData([USER_ID, OTHER_USER_ID, EMPTY_USER_ID, DEV_USER_ID]);
  await deleteHomeNewsFixtureItems();
  await deleteAuthUsers([USER_ID, OTHER_USER_ID, EMPTY_USER_ID, DEV_USER_ID]);
  await closePgDatabase();
  _resetWorkerAppForTests();
});

beforeEach(async () => {
  await purgeUserData([USER_ID, OTHER_USER_ID, EMPTY_USER_ID, DEV_USER_ID]);
  await deleteHomeNewsFixtureItems();
  vi.unstubAllEnvs();
  _resetWorkerAppForTests();
});

describe('Home read-only routes', () => {
  it('does not bootstrap workspace state from read routes', async () => {
    const result = await listHomeInboxRoute({
      auth: auth(EMPTY_USER_ID),
    });

    expect(result.statusCode).toBe(404);
    expect(result.body).toMatchObject({
      ok: false,
      error: { code: 'workspace_not_found' },
    });
    const rows = await getDbPg()<Array<{ count: number }>>`
      select count(*)::int as count
      from public.workspace_members
      where user_id = ${EMPTY_USER_ID}::uuid
    `;
    expect(rows[0].count).toBe(0);
  });

  it('lists active Inbox items for the requested workspace without treating Unfiled talks as Inbox', async () => {
    const { workspaceId, talkId } = await createWorkspaceFixture();
    const other = await createWorkspaceFixture(OTHER_USER_ID);
    const archivedTalkId = await seedTalk({
      ownerId: USER_ID,
      topicTitle: 'Archived inbox',
    });
    await seedTalk({ ownerId: USER_ID, topicTitle: 'Unfiled but quiet' });
    const blockingId = await seedInboxItem({
      workspaceId,
      talkId,
      type: 'run_failed',
      title: 'Retry failed run',
      severity: 'blocking',
      score: null,
      createdAt: '2026-01-02T00:00:00Z',
      targetJson: { kind: 'talk', talkId, internalSecret: 'do-not-leak' },
    });
    await seedInboxItem({
      workspaceId,
      talkId,
      type: 'round_completed',
      title: 'Review completed round',
      severity: 'info',
      score: 20,
      createdAt: '2026-01-03T00:00:00Z',
    });
    await seedInboxItem({
      workspaceId,
      talkId,
      type: 'agent_asks_user',
      title: 'Hidden resolved question',
      severity: 'action',
      status: 'resolved',
      score: 200,
    });
    await seedInboxItem({
      workspaceId,
      talkId: archivedTalkId,
      type: 'run_failed',
      title: 'Archived Talk blocker',
      severity: 'blocking',
      score: 999,
    });
    await seedInboxItem({
      workspaceId,
      talkId: archivedTalkId,
      type: 'run_failed',
      title: 'Archived raw-target blocker',
      severity: 'blocking',
      score: 998,
      targetJson: { kind: 'talk', talkId: archivedTalkId },
      storeTalkId: false,
    });
    await seedInboxItem({
      workspaceId,
      talkId,
      type: 'run_failed',
      title: 'Archived raw-target override blocker',
      severity: 'blocking',
      score: 997,
      targetJson: { kind: 'talk', talkId: archivedTalkId },
    });
    await archiveTalk({ workspaceId, talkId: archivedTalkId });
    await seedInboxItem({
      workspaceId: other.workspaceId,
      talkId: other.talkId,
      type: 'run_failed',
      title: 'Other workspace blocker',
      severity: 'blocking',
      score: 999,
    });

    const result = await listHomeInboxRoute({
      auth: auth(),
      workspaceId,
      limit: 10,
    });

    expect(result.body.ok).toBe(true);
    if (!result.body.ok) throw new Error('expected ok');
    expect(result.body.data.items.map((item) => item.title)).toEqual([
      'Retry failed run',
      'Review completed round',
    ]);
    expect(result.body.data.items[0]).toMatchObject({
      id: blockingId,
      severity: 'blocking',
      target: { kind: 'talk', talkId },
      primaryAction: { type: 'open_talk', label: 'Open Talk' },
    });
    expect(result.body.data.items[0].target).not.toHaveProperty(
      'internalSecret',
    );
    expect(result.body.data.items.map((item) => item.title)).not.toContain(
      'Archived Talk blocker',
    );
    expect(result.body.data.items.map((item) => item.title)).not.toContain(
      'Archived raw-target blocker',
    );
    expect(result.body.data.items.map((item) => item.title)).not.toContain(
      'Archived raw-target override blocker',
    );
    expect(result.body.data.counts).toEqual({
      unread: 2,
      blocking: 1,
      action: 0,
      info: 1,
    });
  });

  it('preserves top-level action identifiers in Inbox action payloads', async () => {
    const { workspaceId, talkId } = await createWorkspaceFixture();
    await seedInboxItem({
      workspaceId,
      talkId,
      type: 'job_blocked',
      title: 'Daily scan is blocked',
      severity: 'blocking',
      primaryActionJson: {
        type: 'open_talk_settings',
        talkId,
        jobId: 'job_123',
      },
    });

    const result = await listHomeInboxRoute({
      auth: auth(),
      workspaceId,
    });

    expect(result.body.ok).toBe(true);
    if (!result.body.ok) throw new Error('expected ok');
    expect(result.body.data.items[0].primaryAction).toEqual({
      type: 'open_talk_settings',
      payload: { talkId, jobId: 'job_123' },
    });
  });

  it('returns hero and then-maybe recommendations from deterministic active rows only', async () => {
    const { workspaceId, talkId } = await createWorkspaceFixture();
    const other = await createWorkspaceFixture(OTHER_USER_ID);
    const archivedTalkId = await seedTalk({
      ownerId: USER_ID,
      topicTitle: 'Archived recommendation',
    });
    const heroId = await seedRecommendation({
      workspaceId,
      talkId,
      kind: 'failed-run',
      title: 'Retry Researcher',
      priority: 'decide',
      score: 83,
      rank: 2,
    });
    await seedRecommendation({
      workspaceId,
      talkId,
      kind: 'synthesis',
      title: 'Synthesize pricing round',
      priority: 'improve',
      score: 82,
      rank: 1,
    });
    await seedRecommendation({
      workspaceId,
      talkId,
      kind: 'archive-cleanup',
      title: 'Archive stale talk',
      priority: 'tidy',
      score: 99,
      actionType: 'archive_talk',
    });
    await seedRecommendation({
      workspaceId,
      talkId: archivedTalkId,
      kind: 'failed-run',
      title: 'Archived talk recommendation',
      priority: 'decide',
      score: 100,
      rank: 0,
      actionPayload: { talkId: archivedTalkId },
      provenance: { talkId: archivedTalkId },
    });
    await seedRecommendation({
      workspaceId,
      talkId: archivedTalkId,
      kind: 'failed-run',
      title: 'Archived top-level action recommendation',
      priority: 'decide',
      score: 101,
      rank: -1,
      actionJson: { type: 'open_talk', talkId: archivedTalkId },
    });
    await seedRecommendation({
      workspaceId,
      talkId: archivedTalkId,
      kind: 'failed-run',
      title: 'Archived override action recommendation',
      priority: 'decide',
      score: 102,
      rank: -2,
      actionJson: {
        type: 'open_talk',
        payload: { talkId },
        talkId: archivedTalkId,
      },
      provenance: { talkId },
    });
    await seedRecommendation({
      workspaceId,
      talkId: archivedTalkId,
      kind: 'cross-link',
      title: 'Archived nested target recommendation',
      priority: 'improve',
      score: 103,
      rank: -3,
      actionJson: {
        type: 'add_context',
        payload: {
          talkId,
          target: { talkId: archivedTalkId },
        },
      },
      provenance: { talkId },
    });
    await seedRecommendation({
      workspaceId,
      talkId: archivedTalkId,
      kind: 'cross-link',
      title: 'Archived talkIds array recommendation',
      priority: 'improve',
      score: 104,
      rank: -4,
      actionJson: {
        type: 'add_context',
        payload: {
          talkId,
          talkIds: [archivedTalkId],
        },
      },
      provenance: { talkId },
    });
    await archiveTalk({ workspaceId, talkId: archivedTalkId });
    await seedRecommendation({
      workspaceId,
      talkId,
      kind: 'failed-run',
      title: 'Deleted candidate should stay hidden',
      priority: 'decide',
      score: 100,
      rank: 0,
    });
    await deleteRecommendationCandidate({
      workspaceId,
      kind: 'failed-run',
      title: 'Deleted candidate should stay hidden',
    });
    await seedRecommendation({
      workspaceId,
      talkId,
      kind: 'recap',
      title: 'Expired recap',
      priority: 'tidy',
      score: 90,
      expiresAt: '2020-01-01T00:00:00Z',
    });
    await seedRecommendation({
      workspaceId: other.workspaceId,
      talkId: other.talkId,
      kind: 'failed-run',
      title: 'Other workspace recommendation',
      priority: 'decide',
      score: 100,
    });

    const result = await listHomeRecommendationsRoute({
      auth: auth(),
      workspaceId,
    });

    expect(result.body.ok).toBe(true);
    if (!result.body.ok) throw new Error('expected ok');
    expect(result.body.data.hero).toMatchObject({
      id: heroId,
      kind: 'failed-run',
      title: 'Retry Researcher',
      action: { type: 'open_talk' },
      provenance: { talkId },
    });
    expect(result.body.data.hero).not.toHaveProperty('features');
    expect(result.body.data.thenMaybe.map((item) => item.title)).toEqual([
      'Synthesize pricing round',
    ]);
    expect(result.body.data.items.map((item) => item.title)).toContain(
      'Archive stale talk',
    );
    expect(result.body.data.thenMaybe.map((item) => item.title)).not.toContain(
      'Archive stale talk',
    );
    expect(result.body.data.items.map((item) => item.title)).not.toContain(
      'Archived talk recommendation',
    );
    expect(result.body.data.items.map((item) => item.title)).not.toContain(
      'Archived top-level action recommendation',
    );
    expect(result.body.data.items.map((item) => item.title)).not.toContain(
      'Archived override action recommendation',
    );
    expect(result.body.data.items.map((item) => item.title)).not.toContain(
      'Archived nested target recommendation',
    );
    expect(result.body.data.items.map((item) => item.title)).not.toContain(
      'Archived talkIds array recommendation',
    );
    expect(result.body.data.items.map((item) => item.title)).not.toContain(
      'Expired recap',
    );
    expect(result.body.data.items.map((item) => item.title)).not.toContain(
      'Deleted candidate should stay hidden',
    );
    expect(result.body.data.items.map((item) => item.title)).not.toContain(
      'Other workspace recommendation',
    );
  });

  it('keeps cleanup recommendations out of the Hero while leaving them in normal recommendations', async () => {
    const { workspaceId, talkId } = await createWorkspaceFixture();
    await seedRecommendation({
      workspaceId,
      talkId,
      kind: 'archive-cleanup',
      title: 'Move stale Talk',
      priority: 'tidy',
      score: 100,
      rank: 0,
      actionType: 'move_to_folder',
    });

    const result = await listHomeRecommendationsRoute({
      auth: auth(),
      workspaceId,
    });

    expect(result.body.ok).toBe(true);
    if (!result.body.ok) throw new Error('expected ok');
    expect(result.body.data.hero).toBeNull();
    expect(result.body.data.items.map((item) => item.title)).toContain(
      'Move stale Talk',
    );
    expect(result.body.data.thenMaybe.map((item) => item.title)).toContain(
      'Move stale Talk',
    );
  });

  it('does not treat descriptive talkIdentifier fields as liveness Talk IDs', async () => {
    const { workspaceId, talkId } = await createWorkspaceFixture();
    await seedRecommendation({
      workspaceId,
      talkId,
      kind: 'doc',
      title: 'Identifier label should remain visible',
      priority: 'improve',
      score: 70,
      actionJson: {
        type: 'open_talk',
        payload: {
          talkId,
          talkIdentifier: 'pricing-v2-label',
        },
      },
      provenance: {
        talkId,
        talkIdentifier: 'pricing-v2-label',
      },
    });

    const result = await listHomeRecommendationsRoute({
      auth: auth(),
      workspaceId,
    });

    expect(result.body.ok).toBe(true);
    if (!result.body.ok) throw new Error('expected ok');
    expect(result.body.data.items.map((item) => item.title)).toContain(
      'Identifier label should remain visible',
    );
  });

  it('filters recommendations without structured actions', async () => {
    const { workspaceId, talkId } = await createWorkspaceFixture();
    await seedRecommendation({
      workspaceId,
      talkId,
      kind: 'failed-run',
      title: 'Malformed action should stay hidden',
      priority: 'decide',
      score: 100,
      rank: 0,
      actionJson: { payload: { talkId } },
    });
    await seedRecommendation({
      workspaceId,
      talkId,
      kind: 'failed-run',
      title: 'Numeric action type should stay hidden',
      priority: 'decide',
      score: 99,
      rank: 1,
      actionJson: { type: 123, payload: { talkId } },
    });
    await seedRecommendation({
      workspaceId,
      talkId,
      kind: 'failed-run',
      title: 'String payload action should stay hidden',
      priority: 'decide',
      score: 98,
      rank: 2,
      actionJson: { type: 'open_talk', payload: talkId },
    });
    await seedRecommendation({
      workspaceId,
      talkId,
      kind: 'synthesis',
      title: 'Valid action remains',
      priority: 'improve',
      score: 90,
      rank: 3,
    });

    const result = await listHomeRecommendationsRoute({
      auth: auth(),
      workspaceId,
    });

    expect(result.body.ok).toBe(true);
    if (!result.body.ok) throw new Error('expected ok');
    expect(result.body.data.items.map((item) => item.title)).not.toContain(
      'Malformed action should stay hidden',
    );
    expect(result.body.data.items.map((item) => item.title)).not.toContain(
      'Numeric action type should stay hidden',
    );
    expect(result.body.data.items.map((item) => item.title)).not.toContain(
      'String payload action should stay hidden',
    );
    expect(result.body.data.hero).toMatchObject({
      title: 'Valid action remains',
    });

    const summary = await getHomeSummaryRoute({
      auth: auth(),
      workspaceId,
    });
    expect(summary.body.ok).toBe(true);
    if (!summary.body.ok) throw new Error('expected ok');
    expect(summary.body.data.counts.recommendations).toBe(1);
  });

  it('caps Then Maybe recommendations by Talk and kind', async () => {
    const { workspaceId, talkId } = await createWorkspaceFixture();
    await seedRecommendation({
      workspaceId,
      talkId,
      kind: 'synthesis',
      title: 'Primary Hero',
      priority: 'decide',
      score: 95,
      rank: 0,
    });
    await seedRecommendation({
      workspaceId,
      talkId,
      kind: 'synthesis',
      title: 'Same Talk first',
      priority: 'improve',
      score: 90,
      rank: 1,
    });
    await seedRecommendation({
      workspaceId,
      talkId,
      kind: 'synthesis',
      title: 'Same Talk second',
      priority: 'improve',
      score: 89,
      rank: 2,
    });
    await seedRecommendation({
      workspaceId,
      talkId,
      kind: 'synthesis',
      title: 'Same Talk third skipped',
      priority: 'improve',
      score: 88,
      rank: 3,
    });
    const otherTalkId = await seedTalk({
      ownerId: USER_ID,
      topicTitle: 'Packaging',
    });
    await seedRecommendation({
      workspaceId,
      talkId: otherTalkId,
      kind: 'failed-run',
      title: 'Other Talk fallback',
      priority: 'improve',
      score: 70,
      rank: 4,
    });

    const result = await listHomeRecommendationsRoute({
      auth: auth(),
      workspaceId,
    });

    expect(result.body.ok).toBe(true);
    if (!result.body.ok) throw new Error('expected ok');
    expect(result.body.data.thenMaybe.map((item) => item.title)).toEqual([
      'Same Talk first',
      'Same Talk second',
      'Other Talk fallback',
    ]);
  });

  it('builds Then Maybe from candidates beyond the public recommendations page', async () => {
    const { workspaceId, talkId } = await createWorkspaceFixture();
    await seedRecommendation({
      workspaceId,
      talkId,
      kind: 'failed-run',
      title: 'Primary Hero',
      priority: 'decide',
      score: 95,
      rank: 0,
    });
    for (let index = 0; index < 12; index += 1) {
      await seedRecommendation({
        workspaceId,
        talkId,
        kind: 'synthesis',
        title: `Same Talk visible ${index}`,
        priority: 'improve',
        score: 90 - index,
        rank: index + 1,
      });
    }
    const otherTalkId = await seedTalk({
      ownerId: USER_ID,
      topicTitle: 'Expansion',
    });
    await seedRecommendation({
      workspaceId,
      talkId: otherTalkId,
      kind: 'failed-run',
      title: 'Beyond public page',
      priority: 'improve',
      score: 70,
      rank: 13,
    });

    const result = await listHomeRecommendationsRoute({
      auth: auth(),
      workspaceId,
      limit: 12,
    });

    expect(result.body.ok).toBe(true);
    if (!result.body.ok) throw new Error('expected ok');
    expect(result.body.data.items.map((item) => item.title)).not.toContain(
      'Beyond public page',
    );
    expect(result.body.data.thenMaybe.map((item) => item.title)).toEqual([
      'Same Talk visible 0',
      'Same Talk visible 1',
      'Beyond public page',
    ]);
  });

  it('uses the Hero as active work when suppressing optional setup and tidy Then Maybe cards', async () => {
    const { workspaceId, talkId } = await createWorkspaceFixture();
    await seedRecommendation({
      workspaceId,
      talkId,
      kind: 'failed-run',
      title: 'Retry blocking run',
      priority: 'decide',
      score: 95,
      rank: 0,
    });
    await seedRecommendation({
      workspaceId,
      talkId,
      kind: 'setup',
      title: 'Optional setup',
      priority: 'improve',
      score: 90,
      rank: 1,
      featuresJson: { setupRequired: false },
    });
    await seedRecommendation({
      workspaceId,
      talkId,
      kind: 'archive-cleanup',
      title: 'Clean stale Talk',
      priority: 'tidy',
      score: 89,
      rank: 2,
    });
    await seedRecommendation({
      workspaceId,
      talkId,
      kind: 'synthesis',
      title: 'Active follow-up',
      priority: 'improve',
      score: 70,
      rank: 3,
    });

    const result = await listHomeRecommendationsRoute({
      auth: auth(),
      workspaceId,
    });

    expect(result.body.ok).toBe(true);
    if (!result.body.ok) throw new Error('expected ok');
    expect(result.body.data.hero).toMatchObject({
      title: 'Retry blocking run',
    });
    expect(result.body.data.thenMaybe.map((item) => item.title)).toEqual([
      'Active follow-up',
    ]);
  });

  it('does not let optional setup win Hero through the high-value branch', async () => {
    const { workspaceId, talkId } = await createWorkspaceFixture();
    await seedRecommendation({
      workspaceId,
      talkId,
      kind: 'setup',
      title: 'Optional setup should not be Hero',
      priority: 'improve',
      score: 100,
      rank: 0,
      featuresJson: { setupRequired: false },
    });
    await seedRecommendation({
      workspaceId,
      talkId,
      kind: 'synthesis',
      title: 'Active high-value work',
      priority: 'improve',
      score: 90,
      rank: 1,
    });

    const result = await listHomeRecommendationsRoute({
      auth: auth(),
      workspaceId,
    });

    expect(result.body.ok).toBe(true);
    if (!result.body.ok) throw new Error('expected ok');
    expect(result.body.data.hero).toMatchObject({
      title: 'Active high-value work',
    });
  });

  it('does not let optional setup win Hero through the blocking branch', async () => {
    const { workspaceId, talkId } = await createWorkspaceFixture();
    await seedRecommendation({
      workspaceId,
      talkId,
      kind: 'setup',
      title: 'Optional decide setup should not be Hero',
      priority: 'decide',
      score: 100,
      rank: 0,
      featuresJson: { setupRequired: false },
    });
    await seedRecommendation({
      workspaceId,
      talkId,
      kind: 'synthesis',
      title: 'Active work beats optional setup',
      priority: 'improve',
      score: 90,
      rank: 1,
    });

    const result = await listHomeRecommendationsRoute({
      auth: auth(),
      workspaceId,
    });

    expect(result.body.ok).toBe(true);
    if (!result.body.ok) throw new Error('expected ok');
    expect(result.body.data.hero).toMatchObject({
      title: 'Active work beats optional setup',
    });
  });

  it('uses an off-page Hero as active work when recommendation limit excludes it from items', async () => {
    const { workspaceId, talkId } = await createWorkspaceFixture();
    await seedRecommendation({
      workspaceId,
      talkId,
      kind: 'setup',
      title: 'Optional setup before work',
      priority: 'improve',
      score: 90,
      rank: 0,
      featuresJson: { setupRequired: false },
    });
    await seedRecommendation({
      workspaceId,
      talkId,
      kind: 'failed-run',
      title: 'Retry hidden Hero',
      priority: 'decide',
      score: 85,
      rank: 1,
    });

    const result = await listHomeRecommendationsRoute({
      auth: auth(),
      workspaceId,
      limit: 1,
    });

    expect(result.body.ok).toBe(true);
    if (!result.body.ok) throw new Error('expected ok');
    expect(result.body.data.items.map((item) => item.title)).toEqual([
      'Optional setup before work',
    ]);
    expect(result.body.data.hero).toMatchObject({
      title: 'Retry hidden Hero',
    });
    expect(result.body.data.thenMaybe).toEqual([]);
  });

  it('keeps required setup eligible for the Hero even when the public list limit excludes it', async () => {
    const { workspaceId, talkId } = await createWorkspaceFixture();
    for (let index = 0; index < 9; index += 1) {
      await seedRecommendation({
        workspaceId,
        talkId,
        kind: 'synthesis',
        title: `High value ${index}`,
        priority: 'improve',
        score: 100 - index,
        rank: index,
      });
    }
    await seedRecommendation({
      workspaceId,
      talkId,
      kind: 'setup',
      title: 'Connect Anthropic',
      priority: 'decide',
      score: 10,
      rank: 0,
      featuresJson: { setupRequired: true },
      confidence: null,
    });

    const result = await listHomeRecommendationsRoute({
      auth: auth(),
      workspaceId,
      limit: 1,
    });

    expect(result.body.ok).toBe(true);
    if (!result.body.ok) throw new Error('expected ok');
    expect(result.body.data.items.map((item) => item.title)).toEqual([
      'High value 0',
    ]);
    expect(result.body.data.hero).toMatchObject({
      kind: 'setup',
      title: 'Connect Anthropic',
      confidence: 0,
    });

    const summary = await getHomeSummaryRoute({
      auth: auth(),
      workspaceId,
    });
    expect(summary.body.ok).toBe(true);
    if (!summary.body.ok) throw new Error('expected ok');
    expect(summary.body.data.curator).toMatchObject({
      kind: 'recommendation',
      title: 'Connect Anthropic',
    });
  });

  it('lists News through active workspace matches and ignores unmatched shared news items', async () => {
    const { workspaceId, talkId } = await createWorkspaceFixture();
    const other = await createWorkspaceFixture(OTHER_USER_ID);
    const archivedTalkId = await seedTalk({
      ownerId: USER_ID,
      topicTitle: 'Archived pricing',
    });
    await seedNewsMatch({
      workspaceId,
      talkId,
      title: 'Acme changes pricing',
      score: 88,
      publishedAt: '2026-01-03T00:00:00Z',
    });
    await seedNewsMatch({
      workspaceId,
      talkId,
      title: 'Background pricing essay',
      status: 'not_relevant',
      score: 99,
    });
    await seedNewsMatch({
      workspaceId,
      talkId: archivedTalkId,
      title: 'Archived talk update',
      score: 95,
    });
    await archiveTalk({ workspaceId, talkId: archivedTalkId });
    await seedNewsMatch({
      workspaceId: other.workspaceId,
      talkId: other.talkId,
      title: 'Other workspace news',
      score: 100,
    });
    await getDbPg()`
      insert into public.home_news_items (
        canonical_url, title, source, source_domain, content_hash
      )
      values (
        'https://news.example/global-only',
        'Global pool only',
        'Example News',
        'news.example',
        'home-test:global-only'
      )
      on conflict (content_hash) do nothing
    `;

    const result = await listHomeNewsRoute({
      auth: auth(),
      workspaceId,
      limit: 10,
    });

    expect(result.body.ok).toBe(true);
    if (!result.body.ok) throw new Error('expected ok');
    expect(result.body.data.items).toHaveLength(1);
    expect(result.body.data.items[0]).toMatchObject({
      headline: 'Acme changes pricing',
      source: 'Example News',
      talkId,
      talkTitle: 'Pricing v2',
      matchedOn: ['pricing'],
      whyItMatters: 'Acme changes pricing matters',
    });
  });

  it('summarizes the deterministic Home priority and denies another workspace', async () => {
    const { workspaceId, talkId } = await createWorkspaceFixture();
    const other = await createWorkspaceFixture(OTHER_USER_ID);
    await seedInboxItem({
      workspaceId,
      talkId,
      type: 'run_failed',
      title: 'Blocking item',
      severity: 'blocking',
      score: 120,
    });
    await seedNewsMatch({
      workspaceId,
      talkId,
      title: 'Pricing changed outside',
      score: 90,
    });
    const archivedTalkId = await seedTalk({
      ownerId: USER_ID,
      topicTitle: 'Archived summary news',
    });
    await seedNewsMatch({
      workspaceId,
      talkId: archivedTalkId,
      title: 'Archived summary update',
      score: 95,
    });
    await archiveTalk({ workspaceId, talkId: archivedTalkId });
    await seedRecommendation({
      workspaceId,
      talkId,
      kind: 'failed-run',
      title: 'Retry first',
      priority: 'decide',
      score: 85,
      actionPayload: { runId: 'run_summary' },
      provenance: { talkId, runId: 'run_summary' },
    });
    await seedRecommendation({
      workspaceId,
      talkId: archivedTalkId,
      kind: 'failed-run',
      title: 'Archived summary recommendation',
      priority: 'decide',
      score: 100,
      actionPayload: { talkId: archivedTalkId },
      provenance: { talkId: archivedTalkId },
    });
    await seedRecommendation({
      workspaceId,
      talkId: archivedTalkId,
      kind: 'failed-run',
      title: 'Archived summary override recommendation',
      priority: 'decide',
      score: 101,
      actionJson: {
        type: 'open_talk',
        payload: { talkId },
        talkId: archivedTalkId,
      },
      provenance: { talkId },
    });
    await seedRecommendation({
      workspaceId,
      talkId: archivedTalkId,
      kind: 'cross-link',
      title: 'Archived source Talk summary recommendation',
      priority: 'improve',
      score: 102,
      actionJson: {
        type: 'add_context',
        payload: { talkId, sourceTalkId: archivedTalkId },
      },
      provenance: { talkId },
    });
    await seedRecommendation({
      workspaceId,
      talkId,
      kind: 'failed-run',
      title: 'Deleted candidate summary',
      priority: 'decide',
      score: 100,
    });
    await deleteRecommendationCandidate({
      workspaceId,
      kind: 'failed-run',
      title: 'Deleted candidate summary',
    });

    const result = await getHomeSummaryRoute({
      auth: auth(),
      workspaceId,
    });

    expect(result.body.ok).toBe(true);
    if (!result.body.ok) throw new Error('expected ok');
    expect(result.body.data.curator).toMatchObject({
      kind: 'recommendation',
      title: 'Retry first',
      target: { kind: 'talk', talkId, runId: 'run_summary' },
    });
    expect(result.body.data.stats).toMatchObject({
      talks: 1,
      prompts: 0,
      tokens: 0,
      words: 0,
    });
    expect(result.body.data.counts).toEqual({
      inbox: { unread: 1, blocking: 1, action: 0, info: 0 },
      recommendations: 1,
      news: 1,
    });

    const denied = await getHomeSummaryRoute({
      auth: auth(),
      workspaceId: other.workspaceId,
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.body).toMatchObject({
      ok: false,
      error: { code: 'workspace_forbidden' },
    });

    const deniedInbox = await listHomeInboxRoute({
      auth: auth(),
      workspaceId: other.workspaceId,
    });
    expect(deniedInbox.statusCode).toBe(403);
    expect(deniedInbox.body).toMatchObject({
      ok: false,
      error: { code: 'workspace_forbidden' },
    });

    const deniedRecommendations = await listHomeRecommendationsRoute({
      auth: auth(),
      workspaceId: other.workspaceId,
    });
    expect(deniedRecommendations.statusCode).toBe(403);
    expect(deniedRecommendations.body).toMatchObject({
      ok: false,
      error: { code: 'workspace_forbidden' },
    });

    const deniedNews = await listHomeNewsRoute({
      auth: auth(),
      workspaceId: other.workspaceId,
    });
    expect(deniedNews.statusCode).toBe(403);
    expect(deniedNews.body).toMatchObject({
      ok: false,
      error: { code: 'workspace_forbidden' },
    });
  });

  it('uses a severe Inbox item for the summary curator even when an info item sorts first', async () => {
    const { workspaceId, talkId } = await createWorkspaceFixture();
    const archivedTalkId = await seedTalk({
      ownerId: USER_ID,
      topicTitle: 'Archived severe inbox',
    });
    await seedInboxItem({
      workspaceId,
      talkId,
      type: 'round_completed',
      title: 'High score info',
      severity: 'info',
      score: 999,
    });
    await seedInboxItem({
      workspaceId,
      talkId,
      type: 'run_failed',
      title: 'Low score blocker',
      severity: 'blocking',
      score: 1,
    });
    await seedInboxItem({
      workspaceId,
      talkId: archivedTalkId,
      type: 'run_failed',
      title: 'Archived high score blocker',
      severity: 'blocking',
      score: 1000,
    });
    await seedInboxItem({
      workspaceId,
      talkId,
      type: 'run_failed',
      title: 'Archived raw-target high score blocker',
      severity: 'blocking',
      score: 1001,
      targetJson: { kind: 'talk', talkId: archivedTalkId },
    });
    await archiveTalk({ workspaceId, talkId: archivedTalkId });

    const result = await getHomeSummaryRoute({
      auth: auth(),
      workspaceId,
    });

    expect(result.body.ok).toBe(true);
    if (!result.body.ok) throw new Error('expected ok');
    expect(result.body.data.curator).toMatchObject({
      kind: 'inbox',
      title: 'Low score blocker',
    });
    expect(result.body.data.counts.inbox).toEqual({
      unread: 2,
      blocking: 1,
      action: 0,
      info: 1,
    });
  });

  it('mounts read-only /api/v1/home routes behind auth', async () => {
    const { workspaceId } = await createWorkspaceFixture(DEV_USER_ID);
    const app = getWorkerApp();
    const noAuth = await app.request(
      new Request('https://app.test/api/v1/home/inbox'),
    );
    expect(noAuth.status).toBe(401);

    vi.stubEnv('CLAWTALK_DEV_STUB_ENABLED', 'true');
    const authed = await app.request(
      new Request('https://app.test/api/v1/home/inbox', {
        headers: { 'x-workspace-id': workspaceId },
      }),
    );
    expect(authed.status).toBe(200);
    const body = (await authed.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

const RANDOM_UUID = '11111111-2222-3333-4444-555555555555';

function dataOf<T>(result: { body: unknown }): T {
  const body = result.body as { ok?: boolean; data?: T };
  if (!body.ok || body.data === undefined) {
    throw new Error(`expected ok result, got ${JSON.stringify(result.body)}`);
  }
  return body.data;
}

async function inboxIds(workspaceId: string): Promise<string[]> {
  const result = await listHomeInboxRoute({ auth: auth(), workspaceId });
  return dataOf<{ items: Array<{ id: string }> }>(result).items.map(
    (i) => i.id,
  );
}

async function recommendationIds(workspaceId: string): Promise<string[]> {
  const result = await listHomeRecommendationsRoute({
    auth: auth(),
    workspaceId,
  });
  return dataOf<{ items: Array<{ id: string }> }>(result).items.map(
    (i) => i.id,
  );
}

describe('Home write routes', () => {
  it('dismisses an Inbox item and removes it from the Inbox list', async () => {
    const { workspaceId, talkId } = await createWorkspaceFixture();
    const itemId = await seedInboxItem({
      workspaceId,
      talkId,
      type: 'agent_replied',
      title: 'Agent replied',
      severity: 'action',
    });
    expect(await inboxIds(workspaceId)).toContain(itemId);

    const result = await dismissHomeInboxRoute({
      auth: auth(),
      workspaceId,
      itemId,
    });
    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      data: { id: itemId, status: 'dismissed' },
    });
    expect(await inboxIds(workspaceId)).not.toContain(itemId);
  });

  it('treats a repeat dismiss as idempotent', async () => {
    const { workspaceId, talkId } = await createWorkspaceFixture();
    const itemId = await seedInboxItem({
      workspaceId,
      talkId,
      type: 'agent_replied',
      title: 'Agent replied',
      severity: 'action',
    });
    await dismissHomeInboxRoute({ auth: auth(), workspaceId, itemId });
    const again = await dismissHomeInboxRoute({
      auth: auth(),
      workspaceId,
      itemId,
    });
    expect(again.statusCode).toBe(200);
    expect(again.body).toMatchObject({
      ok: true,
      data: { id: itemId, status: 'dismissed' },
    });
  });

  it('returns 404 dismissing an unknown Inbox item', async () => {
    const { workspaceId } = await createWorkspaceFixture();
    const result = await dismissHomeInboxRoute({
      auth: auth(),
      workspaceId,
      itemId: RANDOM_UUID,
    });
    expect(result.statusCode).toBe(404);
    expect(result.body).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
  });

  it('rejects a non-UUID Inbox item id', async () => {
    const { workspaceId } = await createWorkspaceFixture();
    const result = await dismissHomeInboxRoute({
      auth: auth(),
      workspaceId,
      itemId: 'not-a-uuid',
    });
    expect(result.statusCode).toBe(400);
    expect(result.body).toMatchObject({
      ok: false,
      error: { code: 'invalid_item_id' },
    });
  });

  it('does not let another workspace dismiss an item', async () => {
    const { workspaceId, talkId } = await createWorkspaceFixture();
    const itemId = await seedInboxItem({
      workspaceId,
      talkId,
      type: 'agent_replied',
      title: 'Agent replied',
      severity: 'action',
    });
    // OTHER_USER has their own workspace but is not a member of this one.
    const result = await dismissHomeInboxRoute({
      auth: auth(OTHER_USER_ID),
      workspaceId,
      itemId,
    });
    expect(result.statusCode).toBe(403);
    expect(result.body).toMatchObject({
      ok: false,
      error: { code: 'workspace_forbidden' },
    });
    // The item is untouched and still visible to its owner.
    expect(await inboxIds(workspaceId)).toContain(itemId);
  });

  it('snoozes an Inbox item out of the active list until it is due', async () => {
    const { workspaceId, talkId } = await createWorkspaceFixture();
    const itemId = await seedInboxItem({
      workspaceId,
      talkId,
      type: 'agent_replied',
      title: 'Agent replied',
      severity: 'action',
    });
    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const result = await snoozeHomeInboxRoute({
      auth: auth(),
      workspaceId,
      itemId,
      until,
    });
    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      data: { id: itemId, status: 'snoozed' },
    });
    expect(await inboxIds(workspaceId)).not.toContain(itemId);

    // Once the snooze elapses, the read query re-surfaces the item.
    await getDbPg()`
      update public.home_inbox_items
      set snoozed_until = now() - interval '1 minute'
      where id = ${itemId}::uuid
    `;
    expect(await inboxIds(workspaceId)).toContain(itemId);
  });

  it('rejects a snooze without a future timestamp', async () => {
    const { workspaceId, talkId } = await createWorkspaceFixture();
    const itemId = await seedInboxItem({
      workspaceId,
      talkId,
      type: 'agent_replied',
      title: 'Agent replied',
      severity: 'action',
    });
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    const result = await snoozeHomeInboxRoute({
      auth: auth(),
      workspaceId,
      itemId,
      until: past,
    });
    expect(result.statusCode).toBe(400);
    expect(result.body).toMatchObject({
      ok: false,
      error: { code: 'invalid_until' },
    });

    const missing = await snoozeHomeInboxRoute({
      auth: auth(),
      workspaceId,
      itemId,
      until: undefined,
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.body).toMatchObject({
      ok: false,
      error: { code: 'invalid_until' },
    });

    // A future but non-ISO datetime (date-only) is rejected, not silently
    // coerced — the contract is an ISO-8601 timestamp.
    const dateOnly = await snoozeHomeInboxRoute({
      auth: auth(),
      workspaceId,
      itemId,
      until: '2099-01-01',
    });
    expect(dateOnly.statusCode).toBe(400);
    expect(dateOnly.body).toMatchObject({
      ok: false,
      error: { code: 'invalid_until' },
    });
  });

  it('dismisses a recommendation and removes it from the list', async () => {
    const { workspaceId, talkId } = await createWorkspaceFixture();
    const recId = await seedRecommendation({
      workspaceId,
      talkId,
      kind: 'unresolved',
      title: 'Resolve the open question',
      priority: 'decide',
      score: 90,
    });
    expect(await recommendationIds(workspaceId)).toContain(recId);

    const result = await dismissHomeRecommendationRoute({
      auth: auth(),
      workspaceId,
      recommendationId: recId,
    });
    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      data: { id: recId, status: 'dismissed' },
    });
    expect(await recommendationIds(workspaceId)).not.toContain(recId);
  });

  it('returns 404 dismissing an unknown recommendation', async () => {
    const { workspaceId } = await createWorkspaceFixture();
    const result = await dismissHomeRecommendationRoute({
      auth: auth(),
      workspaceId,
      recommendationId: RANDOM_UUID,
    });
    expect(result.statusCode).toBe(404);
    expect(result.body).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
  });

  it('rejects a non-UUID recommendation id', async () => {
    const { workspaceId } = await createWorkspaceFixture();
    const result = await dismissHomeRecommendationRoute({
      auth: auth(),
      workspaceId,
      recommendationId: 'nope',
    });
    expect(result.statusCode).toBe(400);
    expect(result.body).toMatchObject({
      ok: false,
      error: { code: 'invalid_recommendation_id' },
    });
  });
});
