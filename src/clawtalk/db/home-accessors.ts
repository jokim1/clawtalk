import { getDbPg, withTrustedDbWrites, type Sql } from '../../db.js';

export const HOME_READ_ALGORITHM_VERSION = 'home_read_v1';

export type HomeInboxType =
  | 'agent_replied'
  | 'round_completed'
  | 'agent_asks_user'
  | 'run_failed'
  | 'doc_edits_ready'
  | 'connector_needs_auth'
  | 'news_context_added'
  | 'long_running_run'
  | 'system_limit_reached'
  | 'forge_run_needs_review'
  | 'job_output_ready'
  | 'job_blocked';

export type HomeInboxSeverity = 'info' | 'action' | 'blocking';
export type HomeInboxStatus =
  | 'unread'
  | 'read'
  | 'resolved'
  | 'dismissed'
  | 'snoozed'
  | 'expired';

export type HomeRecommendationKind =
  | 'setup'
  | 'failed-run'
  | 'unresolved'
  | 'synthesis'
  | 'pending-edit'
  | 'doc'
  | 'cross-link'
  | 'tool'
  | 'news-context'
  | 'agent-change'
  | 'recap'
  | 'archive-cleanup'
  | 'forge-suggestion'
  | 'job'
  | 'prompt-suggestion';

export type HomeRecommendationPriority = 'decide' | 'improve' | 'tidy';
export type HomeRecommendationStatus =
  | 'active'
  | 'dismissed'
  | 'completed'
  | 'expired'
  | 'snoozed';

export type HomeNewsImpact =
  | 'changes_assumption'
  | 'adds_evidence'
  | 'updates_competitor'
  | 'introduces_risk'
  | 'provides_tactic'
  | 'topic_update'
  | 'community_signal'
  | 'background_only';

export type HomeNewsStatus =
  | 'active'
  | 'snoozed'
  | 'added_to_context'
  | 'not_relevant'
  | 'expired';

export type HomeAction = {
  type: string;
  label?: string;
  payload: Record<string, unknown>;
};

export type HomeInboxTarget = {
  kind: string;
  id?: string;
  talkId?: string;
  documentId?: string;
  runId?: string;
  tabId?: string;
  newsItemId?: string;
  connectorId?: string;
  jobId?: string;
};

export type HomeInboxItem = {
  id: string;
  type: HomeInboxType;
  title: string;
  summary: string | null;
  reason: string | null;
  severity: HomeInboxSeverity;
  status: HomeInboxStatus;
  target: HomeInboxTarget;
  primaryAction: HomeAction | null;
  secondaryActions: HomeAction[];
  score: number;
  createdAt: string;
  algorithmVersion: string;
};

export type HomeInboxCounts = {
  unread: number;
  blocking: number;
  action: number;
  info: number;
};

export type HomeInboxPayload = {
  items: HomeInboxItem[];
  counts: HomeInboxCounts;
  nextCursor: string | null;
  algorithmVersion: string;
};

export type HomeRecommendation = {
  id: string;
  kind: HomeRecommendationKind;
  title: string;
  why: string | null;
  priority: HomeRecommendationPriority;
  score: number;
  confidence: number;
  provenance: Record<string, unknown>;
  action: HomeAction;
  status: HomeRecommendationStatus;
  stateFingerprint: string | null;
  rank: number | null;
  algorithmVersion: string;
  createdAt: string;
  expiresAt: string | null;
};

type InternalHomeRecommendation = HomeRecommendation & {
  features: Record<string, unknown>;
};

export type HomeRecommendationsPayload = {
  items: HomeRecommendation[];
  hero: HomeRecommendation | null;
  thenMaybe: HomeRecommendation[];
  algorithmVersion: string;
};

export type HomeNewsItem = {
  id: string;
  headline: string;
  source: string | null;
  favicon: string | null;
  age: string | null;
  excerpt: string | null;
  url: string;
  talkId: string;
  talkTitle: string;
  matchedOn: string[];
  whyItMatters: string | null;
  impact: HomeNewsImpact;
  score: number;
  publishedAt: string | null;
  algorithmVersion: string;
};

export type HomeNewsPayload = {
  items: HomeNewsItem[];
  nextCursor: string | null;
  algorithmVersion: string;
};

export type HomeSummaryPayload = {
  workspaceId: string;
  curator: {
    kind: 'talk' | 'recommendation' | 'inbox' | 'news' | 'idle';
    title: string;
    summary: string | null;
    itemId: string | null;
    target: Record<string, unknown> | null;
  };
  stats: {
    talks: number;
    prompts: number;
    tokens: number;
    words: number;
  };
  counts: {
    inbox: HomeInboxCounts;
    recommendations: number;
    news: number;
  };
  algorithmVersions: {
    inbox: string;
    recommendations: string;
    news: string;
  };
};

type LimitInput = {
  limit?: number | null;
  cursor?: string | null;
};

type HomeStatsRow = {
  talks: number | string | null;
  prompts: number | string | null;
  tokens: number | string | null;
  words: number | string | null;
};

type HomeInboxRow = {
  id: string;
  type: HomeInboxType;
  target_kind: string | null;
  target_json: unknown;
  talk_id: string | null;
  document_id: string | null;
  run_id: string | null;
  tab_id: string | null;
  news_item_id: string | null;
  connector_id: string | null;
  job_id: string | null;
  severity: HomeInboxSeverity;
  status: HomeInboxStatus;
  title: string;
  summary: string | null;
  reason: string | null;
  primary_action_json: unknown;
  secondary_actions_json: unknown;
  effective_score: number | string | null;
  algorithm_version: string | null;
  created_at: string;
};

type HomeRecommendationRow = {
  id: string;
  kind: HomeRecommendationKind;
  title: string;
  why: string | null;
  priority: HomeRecommendationPriority;
  effective_score: number | string | null;
  status: HomeRecommendationStatus;
  rank: number | null;
  algorithm_version: string | null;
  created_at: string;
  expires_at: string | null;
  state_fingerprint: string | null;
  provenance_json: unknown;
  action_json: unknown;
  features_json: unknown;
  confidence: number | string | null;
};

type HomeNewsRow = {
  id: string;
  canonical_url: string;
  title: string;
  source: string | null;
  published_at: string | null;
  excerpt: string | null;
  talk_id: string;
  talk_title: string;
  matched_on_json: unknown;
  impact: HomeNewsImpact;
  why_it_matters: string | null;
  effective_score: number | string | null;
  algorithm_version: string | null;
};

function clampLimit(
  value: number | null | undefined,
  fallback: number,
): number {
  if (!Number.isFinite(value ?? NaN)) return fallback;
  return Math.max(1, Math.min(50, Math.trunc(value as number)));
}

function cursorOffset(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function nextCursor(input: {
  rowsReturned: number;
  limit: number;
  offset: number;
}): string | null {
  return input.rowsReturned > input.limit
    ? String(input.offset + input.limit)
    : null;
}

function numberOrZero(value: number | string | null | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringFromRecord(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function normalizeAction(value: unknown): HomeAction | null {
  if (!isRecord(value)) return null;
  const type = stringFromRecord(value, 'type');
  if (!type) return null;
  const hasPayload = Object.prototype.hasOwnProperty.call(value, 'payload');
  if (hasPayload && !isRecord(value.payload)) return null;
  const payload =
    hasPayload && isRecord(value.payload) ? { ...value.payload } : {};
  for (const [key, item] of Object.entries(value)) {
    if (key !== 'type' && key !== 'label' && key !== 'payload') {
      payload[key] = item;
    }
  }
  return {
    type,
    ...(typeof value.label === 'string' ? { label: value.label } : {}),
    payload,
  };
}

function normalizeActionList(value: unknown): HomeAction[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const action = normalizeAction(candidate);
    return action ? [action] : [];
  });
}

function normalizeTarget(row: HomeInboxRow): HomeInboxTarget {
  const raw = isRecord(row.target_json) ? row.target_json : {};
  const rawId = stringFromRecord(raw, 'id');
  const talkId = row.talk_id ?? stringFromRecord(raw, 'talkId');
  const documentId = row.document_id ?? stringFromRecord(raw, 'documentId');
  const runId = row.run_id ?? stringFromRecord(raw, 'runId');
  const tabId = row.tab_id ?? stringFromRecord(raw, 'tabId');
  const newsItemId = row.news_item_id ?? stringFromRecord(raw, 'newsItemId');
  const connectorId = row.connector_id ?? stringFromRecord(raw, 'connectorId');
  const jobId = row.job_id ?? stringFromRecord(raw, 'jobId');
  return {
    kind: row.target_kind ?? stringFromRecord(raw, 'kind') ?? 'system',
    ...(rawId ? { id: rawId } : {}),
    ...(talkId ? { talkId } : {}),
    ...(documentId ? { documentId } : {}),
    ...(runId ? { runId } : {}),
    ...(tabId ? { tabId } : {}),
    ...(newsItemId ? { newsItemId } : {}),
    ...(connectorId ? { connectorId } : {}),
    ...(jobId ? { jobId } : {}),
  };
}

function normalizeMatchedOn(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  if (!isRecord(value)) return [];
  const labels: string[] = [];
  for (const entry of Object.values(value)) {
    if (typeof entry === 'string') labels.push(entry);
    if (Array.isArray(entry)) {
      for (const item of entry) {
        if (typeof item === 'string') labels.push(item);
      }
    }
  }
  return Array.from(new Set(labels));
}

function relativeAge(publishedAt: string | null): string | null {
  if (!publishedAt) return null;
  const published = Date.parse(publishedAt);
  if (!Number.isFinite(published)) return null;
  const hours = Math.max(0, Math.floor((Date.now() - published) / 3_600_000));
  if (hours < 1) return 'now';
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function mapInboxRow(row: HomeInboxRow): HomeInboxItem {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    summary: row.summary,
    reason: row.reason,
    severity: row.severity,
    status: row.status,
    target: normalizeTarget(row),
    primaryAction: normalizeAction(row.primary_action_json),
    secondaryActions: normalizeActionList(row.secondary_actions_json),
    score: numberOrZero(row.effective_score),
    createdAt: row.created_at,
    algorithmVersion: row.algorithm_version ?? HOME_READ_ALGORITHM_VERSION,
  };
}

function mapRecommendationRow(
  row: HomeRecommendationRow,
): InternalHomeRecommendation | null {
  const action = normalizeAction(row.action_json);
  if (!action) return null;
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    why: row.why,
    priority: row.priority,
    score: numberOrZero(row.effective_score),
    confidence: numberOrZero(row.confidence),
    provenance: isRecord(row.provenance_json) ? row.provenance_json : {},
    action,
    features: isRecord(row.features_json) ? row.features_json : {},
    status: row.status,
    stateFingerprint: row.state_fingerprint,
    rank: row.rank,
    algorithmVersion: row.algorithm_version ?? HOME_READ_ALGORITHM_VERSION,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function mapNewsRow(row: HomeNewsRow): HomeNewsItem {
  return {
    id: row.id,
    headline: row.title,
    source: row.source,
    favicon: null,
    age: relativeAge(row.published_at),
    excerpt: row.excerpt,
    url: row.canonical_url,
    talkId: row.talk_id,
    talkTitle: row.talk_title,
    matchedOn: normalizeMatchedOn(row.matched_on_json),
    whyItMatters: row.why_it_matters,
    impact: row.impact,
    score: numberOrZero(row.effective_score),
    publishedAt: row.published_at,
    algorithmVersion: row.algorithm_version ?? HOME_READ_ALGORITHM_VERSION,
  };
}

function priorityWeight(priority: HomeRecommendationPriority): number {
  switch (priority) {
    case 'decide':
      return 3;
    case 'improve':
      return 2;
    case 'tidy':
      return 1;
  }
}

function isSafeHero(candidate: InternalHomeRecommendation): boolean {
  if (candidate.kind === 'archive-cleanup') return false;
  if (candidate.action.type === 'archive_talk') return false;
  if (
    candidate.kind === 'agent-change' &&
    candidate.action.payload.changeType === 'remove_agent'
  ) {
    return false;
  }
  return candidate.confidence >= 0.65;
}

function sortRecommendations(
  left: InternalHomeRecommendation,
  right: InternalHomeRecommendation,
): number {
  const leftRank = left.rank ?? Number.MAX_SAFE_INTEGER;
  const rightRank = right.rank ?? Number.MAX_SAFE_INTEGER;
  return (
    leftRank - rightRank ||
    right.score - left.score ||
    priorityWeight(right.priority) - priorityWeight(left.priority) ||
    Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

function toPublicRecommendation(
  item: InternalHomeRecommendation,
): HomeRecommendation {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    why: item.why,
    priority: item.priority,
    score: item.score,
    confidence: item.confidence,
    provenance: item.provenance,
    action: item.action,
    status: item.status,
    stateFingerprint: item.stateFingerprint,
    rank: item.rank,
    algorithmVersion: item.algorithmVersion,
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
  };
}

function targetFromRecord(
  record: Record<string, unknown>,
): Record<string, unknown> | null {
  const talkId = stringFromRecord(record, 'talkId');
  const documentId = stringFromRecord(record, 'documentId');
  const runId = stringFromRecord(record, 'runId');
  const tabId = stringFromRecord(record, 'tabId');
  const newsItemId = stringFromRecord(record, 'newsItemId');
  const connectorId = stringFromRecord(record, 'connectorId');
  const jobId = stringFromRecord(record, 'jobId');
  if (jobId) return { kind: 'job', jobId, ...(talkId ? { talkId } : {}) };
  if (connectorId) return { kind: 'connector', connectorId };
  if (newsItemId) {
    return { kind: 'news', newsItemId, ...(talkId ? { talkId } : {}) };
  }
  if (documentId) {
    return {
      kind: 'document',
      documentId,
      ...(tabId ? { tabId } : {}),
      ...(talkId ? { talkId } : {}),
    };
  }
  if (talkId || runId) {
    return {
      kind: 'talk',
      ...(talkId ? { talkId } : {}),
      ...(runId ? { runId } : {}),
    };
  }
  return null;
}

function recommendationTarget(
  item: HomeRecommendation,
): Record<string, unknown> {
  const mergedTarget = {
    ...item.provenance,
    ...item.action.payload,
  };
  return (
    targetFromRecord(mergedTarget) ?? {
      kind: 'recommendation',
      recommendationId: item.id,
    }
  );
}

function recommendationTalkId(
  item: InternalHomeRecommendation,
): string | undefined {
  return (
    stringFromRecord(item.action.payload, 'talkId') ??
    stringFromRecord(item.provenance, 'talkId')
  );
}

function isRequiredSetup(item: InternalHomeRecommendation): boolean {
  return item.kind === 'setup' && item.features.setupRequired === true;
}

function pickThenMaybe(input: {
  items: InternalHomeRecommendation[];
  hero: InternalHomeRecommendation | null;
}): InternalHomeRecommendation[] {
  const predicateItems =
    input.hero && !input.items.some((item) => item.id === input.hero?.id)
      ? [input.hero, ...input.items]
      : input.items;
  const hasDecideOrImprove = predicateItems.some(
    (item) => item.priority === 'decide' || item.priority === 'improve',
  );
  const hasActiveWork = predicateItems.some(
    (item) => item.kind !== 'setup' && item.priority !== 'tidy',
  );
  const sorted = input.items
    .filter((item) => item.id !== input.hero?.id)
    .sort(sortRecommendations);
  const kindCounts = new Map<HomeRecommendationKind, number>();
  const talkCounts = new Map<string, number>();
  const selected: InternalHomeRecommendation[] = [];
  const kindLimit = (kind: HomeRecommendationKind): number => {
    switch (kind) {
      case 'agent-change':
      case 'archive-cleanup':
      case 'job':
        return 1;
      default:
        return 2;
    }
  };

  for (const item of sorted) {
    if (selected.length >= 3) break;
    if (hasDecideOrImprove && item.priority === 'tidy') continue;
    if (hasActiveWork && item.kind === 'setup' && !isRequiredSetup(item)) {
      continue;
    }
    const currentKindCount = kindCounts.get(item.kind) ?? 0;
    if (currentKindCount >= kindLimit(item.kind)) continue;
    const talkId = recommendationTalkId(item);
    if (talkId && (talkCounts.get(talkId) ?? 0) >= 2) continue;

    selected.push(item);
    kindCounts.set(item.kind, currentKindCount + 1);
    if (talkId) talkCounts.set(talkId, (talkCounts.get(talkId) ?? 0) + 1);
  }

  return selected;
}

function pickHero(input: {
  items: InternalHomeRecommendation[];
  activeTalkCount: number;
}): InternalHomeRecommendation | null {
  const requiredSetup = input.items
    .filter((item) => item.kind === 'setup')
    .filter((item) => item.features.setupRequired === true)
    .sort(sortRecommendations)[0];
  if (requiredSetup) return requiredSetup;

  const blocking = input.items
    .filter((item) => item.priority === 'decide')
    .filter((item) => item.score >= 70)
    .filter((item) => item.kind !== 'setup')
    .filter(isSafeHero)
    .sort(sortRecommendations)[0];
  if (blocking) return blocking;

  const highValue = input.items
    .filter((item) => item.score >= 72)
    .filter((item) => item.kind !== 'setup')
    .filter(isSafeHero)
    .sort(sortRecommendations)[0];
  if (highValue) return highValue;

  const optionalSetup = input.items
    .filter((item) => item.kind === 'setup')
    .filter((item) => item.score >= 65)
    .filter(isSafeHero)
    .sort(sortRecommendations)[0];
  if (optionalSetup && input.activeTalkCount === 0) return optionalSetup;

  return null;
}

async function activeTalkCount(input: {
  db: Sql;
  workspaceId: string;
}): Promise<number> {
  const rows = await input.db<Array<{ count: number }>>`
    select count(*)::int as count
    from public.talks
    where workspace_id = ${input.workspaceId}::uuid
      and archived_at is null
  `;
  return rows[0]?.count ?? 0;
}

export async function listHomeInboxItems(
  input: {
    workspaceId: string;
  } & LimitInput,
): Promise<HomeInboxPayload> {
  const db = getDbPg();
  const limit = clampLimit(input.limit, 20);
  const offset = cursorOffset(input.cursor);
  const rows = await db<HomeInboxRow[]>`
    select
      id,
      type,
      target_kind,
      target_json,
      talk_id,
      document_id,
      run_id,
      tab_id,
      news_item_id,
      connector_id,
      job_id,
      severity,
      status,
      title,
      summary,
      reason,
      primary_action_json,
      secondary_actions_json,
      coalesce(
        score,
        case severity
          when 'blocking' then 120
          when 'action' then 80
          else 35
        end
        + case type
          when 'agent_asks_user' then 35
          when 'run_failed' then 30
          when 'job_blocked' then 30
          when 'doc_edits_ready' then 20
          when 'round_completed' then 18
          when 'news_context_added' then 8
          when 'long_running_run' then 12
          else 0
        end
        + case
          when created_at >= now() - interval '1 hour' then 35
          when created_at >= now() - interval '6 hours' then 28
          when created_at >= now() - interval '24 hours' then 20
          when created_at >= now() - interval '72 hours' then 10
          else 2
        end
      ) as effective_score,
      algorithm_version,
      created_at
    from public.home_inbox_items i
    where i.workspace_id = ${input.workspaceId}::uuid
      and (
        i.status in ('unread', 'read')
        or (i.status = 'snoozed' and i.snoozed_until <= now())
      )
      and (i.expires_at is null or i.expires_at > now())
      and not exists (
        select 1
        from (
          values
            (nullif(i.talk_id::text, '')),
            (nullif(i.target_json ->> 'talkId', ''))
        ) as inbox_target(talk_id)
        where inbox_target.talk_id is not null
          and not exists (
            select 1
            from public.talks t
            where t.workspace_id = i.workspace_id
              and t.id::text = inbox_target.talk_id
              and t.archived_at is null
          )
      )
    order by
      effective_score desc,
      case severity when 'blocking' then 3 when 'action' then 2 else 1 end desc,
      created_at desc,
      title asc,
      id asc
    limit ${limit + 1}
    offset ${offset}
  `;
  const countsRows = await db<Array<HomeInboxCounts>>`
    select
      count(*) filter (where status = 'unread')::int as unread,
      count(*) filter (where severity = 'blocking')::int as blocking,
      count(*) filter (where severity = 'action')::int as action,
      count(*) filter (where severity = 'info')::int as info
    from public.home_inbox_items i
    where i.workspace_id = ${input.workspaceId}::uuid
      and (
        i.status in ('unread', 'read')
        or (i.status = 'snoozed' and i.snoozed_until <= now())
      )
      and (i.expires_at is null or i.expires_at > now())
      and not exists (
        select 1
        from (
          values
            (nullif(i.talk_id::text, '')),
            (nullif(i.target_json ->> 'talkId', ''))
        ) as inbox_target(talk_id)
        where inbox_target.talk_id is not null
          and not exists (
            select 1
            from public.talks t
            where t.workspace_id = i.workspace_id
              and t.id::text = inbox_target.talk_id
              and t.archived_at is null
          )
      )
  `;
  const pageRows = rows.slice(0, limit);
  return {
    items: pageRows.map(mapInboxRow),
    counts: countsRows[0] ?? { unread: 0, blocking: 0, action: 0, info: 0 },
    nextCursor: nextCursor({ rowsReturned: rows.length, limit, offset }),
    algorithmVersion:
      pageRows[0]?.algorithm_version ?? HOME_READ_ALGORITHM_VERSION,
  };
}

export async function listHomeRecommendations(input: {
  workspaceId: string;
  limit?: number | null;
}): Promise<HomeRecommendationsPayload> {
  const db = getDbPg();
  const limit = clampLimit(input.limit, 12);
  const recommendationPoolLimit = 200;
  const rows = await db<HomeRecommendationRow[]>`
    select
      r.id,
      r.kind,
      r.title,
      r.why,
      r.priority,
      coalesce(r.score, 0) as effective_score,
      r.status,
      r.rank,
      r.algorithm_version,
      r.created_at,
      r.expires_at,
      c.state_fingerprint,
      c.provenance_json,
      c.action_json,
      c.features_json,
      c.confidence
    from public.home_recommendations r
    join public.home_recommendation_candidates c
      on c.workspace_id = r.workspace_id
     and c.id = r.candidate_id
    where r.workspace_id = ${input.workspaceId}::uuid
      and r.surface = 'recommendations'
      and r.status = 'active'
      and (r.expires_at is null or r.expires_at > now())
      and (c.expires_at is null or c.expires_at > now())
      and jsonb_typeof(c.action_json) = 'object'
      and jsonb_typeof(c.action_json -> 'type') = 'string'
      and nullif(c.action_json ->> 'type', '') is not null
      and (
        not (c.action_json ? 'payload')
        or jsonb_typeof(c.action_json -> 'payload') = 'object'
      )
      and not exists (
        with recursive recommendation_json(key, value) as (
          select *
          from (
            values
              (null::text, c.action_json),
              (null::text, c.provenance_json)
          ) as roots(key, value)
          union all
          select next_child.key, next_child.value
          from recommendation_json parent
          cross join lateral (
            select object_child.key, object_child.value
            from jsonb_each(
              case
                when jsonb_typeof(parent.value) = 'object' then parent.value
                else '{}'::jsonb
              end
            ) as object_child(key, value)
            union all
            select parent.key, array_child.value
            from jsonb_array_elements(
              case
                when jsonb_typeof(parent.value) = 'array' then parent.value
                else '[]'::jsonb
              end
            ) as array_child(value)
          ) as next_child(key, value)
        )
        select 1
        from recommendation_json candidate_target
        where candidate_target.key is not null
          and regexp_replace(lower(candidate_target.key), '[^a-z0-9]', '', 'g') ~ 'talkids?$'
          and jsonb_typeof(candidate_target.value) = 'string'
          and nullif(candidate_target.value #>> '{}', '') is not null
          and not exists (
            select 1
            from public.talks t
            where t.workspace_id = r.workspace_id
              and t.id::text = nullif(candidate_target.value #>> '{}', '')
              and t.archived_at is null
          )
      )
    order by
      coalesce(r.rank, 2147483647) asc,
      coalesce(r.score, 0) desc,
      case r.priority when 'decide' then 3 when 'improve' then 2 else 1 end desc,
      r.created_at desc,
      r.id asc
    limit ${recommendationPoolLimit}
  `;
  const heroCandidateRows = await db<HomeRecommendationRow[]>`
    select
      r.id,
      r.kind,
      r.title,
      r.why,
      r.priority,
      coalesce(r.score, 0) as effective_score,
      r.status,
      r.rank,
      r.algorithm_version,
      r.created_at,
      r.expires_at,
      c.state_fingerprint,
      c.provenance_json,
      c.action_json,
      c.features_json,
      c.confidence
    from public.home_recommendations r
    join public.home_recommendation_candidates c
      on c.workspace_id = r.workspace_id
     and c.id = r.candidate_id
    where r.workspace_id = ${input.workspaceId}::uuid
      and r.surface = 'recommendations'
      and r.status = 'active'
      and (r.expires_at is null or r.expires_at > now())
      and (c.expires_at is null or c.expires_at > now())
      and jsonb_typeof(c.action_json) = 'object'
      and jsonb_typeof(c.action_json -> 'type') = 'string'
      and nullif(c.action_json ->> 'type', '') is not null
      and (
        not (c.action_json ? 'payload')
        or jsonb_typeof(c.action_json -> 'payload') = 'object'
      )
      and (
        (r.kind = 'setup' and c.features_json ->> 'setupRequired' = 'true')
        or (r.kind = 'setup' and coalesce(r.score, 0) >= 65)
        or (
          (
            (r.priority = 'decide' and coalesce(r.score, 0) >= 70)
            or coalesce(r.score, 0) >= 72
          )
          and r.kind <> 'archive-cleanup'
          and coalesce(c.action_json ->> 'type', '') <> 'archive_talk'
          and not (
            r.kind = 'agent-change'
            and coalesce(
              c.action_json #>> '{payload,changeType}',
              c.action_json ->> 'changeType',
              ''
            ) = 'remove_agent'
          )
          and coalesce(c.confidence, 0) >= 0.65
        )
      )
      and not exists (
        with recursive recommendation_json(key, value) as (
          select *
          from (
            values
              (null::text, c.action_json),
              (null::text, c.provenance_json)
          ) as roots(key, value)
          union all
          select next_child.key, next_child.value
          from recommendation_json parent
          cross join lateral (
            select object_child.key, object_child.value
            from jsonb_each(
              case
                when jsonb_typeof(parent.value) = 'object' then parent.value
                else '{}'::jsonb
              end
            ) as object_child(key, value)
            union all
            select parent.key, array_child.value
            from jsonb_array_elements(
              case
                when jsonb_typeof(parent.value) = 'array' then parent.value
                else '[]'::jsonb
              end
            ) as array_child(value)
          ) as next_child(key, value)
        )
        select 1
        from recommendation_json candidate_target
        where candidate_target.key is not null
          and regexp_replace(lower(candidate_target.key), '[^a-z0-9]', '', 'g') ~ 'talkids?$'
          and jsonb_typeof(candidate_target.value) = 'string'
          and nullif(candidate_target.value #>> '{}', '') is not null
          and not exists (
            select 1
            from public.talks t
            where t.workspace_id = r.workspace_id
              and t.id::text = nullif(candidate_target.value #>> '{}', '')
              and t.archived_at is null
          )
      )
    order by
      case
        when r.kind = 'setup' and c.features_json ->> 'setupRequired' = 'true' then 0
        when r.priority = 'decide' and coalesce(r.score, 0) >= 70 then 1
        when coalesce(r.score, 0) >= 72 then 2
        when r.kind = 'setup' and coalesce(r.score, 0) >= 65 then 3
        else 4
      end asc,
      coalesce(r.rank, 2147483647) asc,
      coalesce(r.score, 0) desc,
      case r.priority when 'decide' then 3 when 'improve' then 2 else 1 end desc,
      r.created_at desc,
      r.id asc
    limit 50
  `;
  const internalCandidates = rows
    .flatMap((row) => {
      const item = mapRecommendationRow(row);
      return item ? [item] : [];
    })
    .sort(sortRecommendations);
  const internalItems = internalCandidates.slice(0, limit);
  const heroCandidates = heroCandidateRows
    .flatMap((row) => {
      const item = mapRecommendationRow(row);
      return item ? [item] : [];
    })
    .sort(sortRecommendations);
  const currentActiveTalkCount = await activeTalkCount({
    db,
    workspaceId: input.workspaceId,
  });
  const hero = pickHero({
    items: heroCandidates,
    activeTalkCount: currentActiveTalkCount,
  });
  const thenMaybe = pickThenMaybe({ items: internalCandidates, hero });
  return {
    items: internalItems.map(toPublicRecommendation),
    hero: hero ? toPublicRecommendation(hero) : null,
    thenMaybe: thenMaybe.map(toPublicRecommendation),
    algorithmVersion:
      internalItems[0]?.algorithmVersion ??
      hero?.algorithmVersion ??
      HOME_READ_ALGORITHM_VERSION,
  };
}

export async function listHomeNews(
  input: {
    workspaceId: string;
  } & LimitInput,
): Promise<HomeNewsPayload> {
  const db = getDbPg();
  const limit = clampLimit(input.limit, 6);
  const offset = cursorOffset(input.cursor);
  const rows = await db<HomeNewsRow[]>`
    select
      m.id,
      i.canonical_url,
      i.title,
      i.source,
      i.published_at,
      i.excerpt,
      m.talk_id,
      t.title as talk_title,
      m.matched_on_json,
      m.impact,
      m.why_it_matters,
      coalesce(
        m.score,
        case m.impact
          when 'changes_assumption' then 85
          when 'introduces_risk' then 82
          when 'updates_competitor' then 76
          when 'adds_evidence' then 72
          when 'provides_tactic' then 66
          when 'topic_update' then 60
          when 'community_signal' then 58
          else 35
        end
        + case
          when i.published_at is null then 0
          when i.published_at >= now() - interval '1 day' then 12
          when i.published_at >= now() - interval '3 days' then 8
          when i.published_at >= now() - interval '14 days' then 4
          else 0
        end
      ) as effective_score,
      m.algorithm_version
    from public.home_news_matches m
    join public.home_news_items i
      on i.id = m.news_item_id
    join public.talks t
      on t.workspace_id = m.workspace_id
     and t.id = m.talk_id
     and t.archived_at is null
    where m.workspace_id = ${input.workspaceId}::uuid
      and m.status = 'active'
    order by
      effective_score desc,
      i.published_at desc nulls last,
      m.created_at desc,
      m.id asc
    limit ${limit + 1}
    offset ${offset}
  `;
  const pageRows = rows.slice(0, limit);
  return {
    items: pageRows.map(mapNewsRow),
    nextCursor: nextCursor({ rowsReturned: rows.length, limit, offset }),
    algorithmVersion:
      pageRows[0]?.algorithm_version ?? HOME_READ_ALGORITHM_VERSION,
  };
}

async function homeCounts(input: {
  db: Sql;
  workspaceId: string;
}): Promise<{ recommendations: number; news: number }> {
  const rows = await input.db<Array<{ recommendations: number; news: number }>>`
    select
      (
        select count(*)::int
        from public.home_recommendations r
        join public.home_recommendation_candidates c
          on c.workspace_id = r.workspace_id
         and c.id = r.candidate_id
        where r.workspace_id = ${input.workspaceId}::uuid
          and r.surface = 'recommendations'
          and r.status = 'active'
          and (r.expires_at is null or r.expires_at > now())
          and (c.expires_at is null or c.expires_at > now())
          and jsonb_typeof(c.action_json) = 'object'
          and jsonb_typeof(c.action_json -> 'type') = 'string'
          and nullif(c.action_json ->> 'type', '') is not null
          and (
            not (c.action_json ? 'payload')
            or jsonb_typeof(c.action_json -> 'payload') = 'object'
          )
          and not exists (
            with recursive recommendation_json(key, value) as (
              select *
              from (
                values
                  (null::text, c.action_json),
                  (null::text, c.provenance_json)
              ) as roots(key, value)
              union all
              select next_child.key, next_child.value
              from recommendation_json parent
              cross join lateral (
                select object_child.key, object_child.value
                from jsonb_each(
                  case
                    when jsonb_typeof(parent.value) = 'object' then parent.value
                    else '{}'::jsonb
                  end
                ) as object_child(key, value)
                union all
                select parent.key, array_child.value
                from jsonb_array_elements(
                  case
                    when jsonb_typeof(parent.value) = 'array' then parent.value
                    else '[]'::jsonb
                  end
                ) as array_child(value)
              ) as next_child(key, value)
            )
            select 1
            from recommendation_json candidate_target
            where candidate_target.key is not null
              and regexp_replace(lower(candidate_target.key), '[^a-z0-9]', '', 'g') ~ 'talkids?$'
              and jsonb_typeof(candidate_target.value) = 'string'
              and nullif(candidate_target.value #>> '{}', '') is not null
              and not exists (
                select 1
                from public.talks t
                where t.workspace_id = r.workspace_id
                  and t.id::text = nullif(candidate_target.value #>> '{}', '')
                  and t.archived_at is null
              )
          )
      ) as recommendations,
      (
        select count(*)::int
        from public.home_news_matches m
        join public.home_news_items i
          on i.id = m.news_item_id
        join public.talks t
          on t.workspace_id = m.workspace_id
         and t.id = m.talk_id
         and t.archived_at is null
        where m.workspace_id = ${input.workspaceId}::uuid
          and m.status = 'active'
      ) as news
  `;
  return rows[0] ?? { recommendations: 0, news: 0 };
}

async function homeStats(input: {
  db: Sql;
  workspaceId: string;
}): Promise<HomeSummaryPayload['stats']> {
  const rows = await input.db<HomeStatsRow[]>`
    select
      (
        select count(*)::bigint
        from public.talks
        where workspace_id = ${input.workspaceId}::uuid
          and archived_at is null
      ) as talks,
      (
        select count(*)::bigint
        from public.messages
        where workspace_id = ${input.workspaceId}::uuid
          and author_kind = 'user'
      ) as prompts,
      (
        select coalesce(sum(coalesce(tokens_in, 0)::bigint + coalesce(tokens_out, 0)::bigint), 0)::bigint
        from public.runs
        where workspace_id = ${input.workspaceId}::uuid
      ) as tokens,
      (
        select coalesce(sum(word_count::bigint), 0)::bigint
        from public.documents
        where workspace_id = ${input.workspaceId}::uuid
      ) as words
  `;
  const row = rows[0];
  return row
    ? {
        talks: numberOrZero(row.talks),
        prompts: numberOrZero(row.prompts),
        tokens: numberOrZero(row.tokens),
        words: numberOrZero(row.words),
      }
    : { talks: 0, prompts: 0, tokens: 0, words: 0 };
}

async function runningTalkCurator(input: {
  db: Sql;
  workspaceId: string;
}): Promise<HomeSummaryPayload['curator'] | null> {
  const rows = await input.db<
    Array<{ id: string; title: string; active_runs: number }>
  >`
    select t.id, t.title, count(r.id)::int as active_runs
    from public.talks t
    join public.runs r
      on r.workspace_id = t.workspace_id
     and r.talk_id = t.id
     and r.status in ('queued', 'running', 'awaiting')
    where t.workspace_id = ${input.workspaceId}::uuid
      and t.archived_at is null
    group by t.id, t.title, t.last_activity_at
    order by t.last_activity_at desc, t.id asc
    limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    kind: 'talk',
    title: row.title,
    summary: `${row.active_runs} active run${row.active_runs === 1 ? '' : 's'}`,
    itemId: row.id,
    target: { kind: 'talk', talkId: row.id },
  };
}

async function topSevereInboxItem(input: {
  db: Sql;
  workspaceId: string;
}): Promise<HomeInboxItem | null> {
  const rows = await input.db<HomeInboxRow[]>`
    select
      id,
      type,
      target_kind,
      target_json,
      talk_id,
      document_id,
      run_id,
      tab_id,
      news_item_id,
      connector_id,
      job_id,
      severity,
      status,
      title,
      summary,
      reason,
      primary_action_json,
      secondary_actions_json,
      coalesce(score, 0) as effective_score,
      algorithm_version,
      created_at
    from public.home_inbox_items i
    where i.workspace_id = ${input.workspaceId}::uuid
      and i.severity in ('blocking', 'action')
      and (
        i.status in ('unread', 'read')
        or (i.status = 'snoozed' and i.snoozed_until <= now())
      )
      and (i.expires_at is null or i.expires_at > now())
      and not exists (
        select 1
        from (
          values
            (nullif(i.talk_id::text, '')),
            (nullif(i.target_json ->> 'talkId', ''))
        ) as inbox_target(talk_id)
        where inbox_target.talk_id is not null
          and not exists (
            select 1
            from public.talks t
            where t.workspace_id = i.workspace_id
              and t.id::text = inbox_target.talk_id
              and t.archived_at is null
          )
      )
    order by
      case severity when 'blocking' then 2 else 1 end desc,
      coalesce(score, 0) desc,
      created_at desc,
      title asc,
      id asc
    limit 1
  `;
  return rows[0] ? mapInboxRow(rows[0]) : null;
}

function buildCurator(input: {
  runningTalk: HomeSummaryPayload['curator'] | null;
  recommendations: HomeRecommendationsPayload;
  severeInbox: HomeInboxItem | null;
  news: HomeNewsPayload;
}): HomeSummaryPayload['curator'] {
  if (input.runningTalk) return input.runningTalk;
  if (input.recommendations.hero) {
    return {
      kind: 'recommendation',
      title: input.recommendations.hero.title,
      summary: input.recommendations.hero.why,
      itemId: input.recommendations.hero.id,
      target: recommendationTarget(input.recommendations.hero),
    };
  }
  const severeInbox = input.severeInbox;
  if (severeInbox) {
    return {
      kind: 'inbox',
      title: severeInbox.title,
      summary: severeInbox.summary,
      itemId: severeInbox.id,
      target: severeInbox.target,
    };
  }
  const topNews = input.news.items[0];
  if (topNews) {
    return {
      kind: 'news',
      title: topNews.headline,
      summary: topNews.whyItMatters,
      itemId: topNews.id,
      target: { kind: 'news', talkId: topNews.talkId },
    };
  }
  return {
    kind: 'idle',
    title: 'Start a Talk',
    summary:
      'Create a Talk to bring agents, sources, and follow-up work together.',
    itemId: null,
    target: null,
  };
}

export async function getHomeSummary(input: {
  workspaceId: string;
}): Promise<HomeSummaryPayload> {
  const db = getDbPg();
  const [
    stats,
    inbox,
    recommendations,
    news,
    counts,
    runningTalk,
    severeInbox,
  ] = await Promise.all([
    homeStats({ db, workspaceId: input.workspaceId }),
    listHomeInboxItems({ workspaceId: input.workspaceId, limit: 1 }),
    listHomeRecommendations({ workspaceId: input.workspaceId, limit: 8 }),
    listHomeNews({ workspaceId: input.workspaceId, limit: 1 }),
    homeCounts({ db, workspaceId: input.workspaceId }),
    runningTalkCurator({ db, workspaceId: input.workspaceId }),
    topSevereInboxItem({ db, workspaceId: input.workspaceId }),
  ]);

  return {
    workspaceId: input.workspaceId,
    curator: buildCurator({
      runningTalk,
      recommendations,
      severeInbox,
      news,
    }),
    stats,
    counts: {
      inbox: inbox.counts,
      recommendations: counts.recommendations,
      news: counts.news,
    },
    algorithmVersions: {
      inbox: inbox.algorithmVersion,
      recommendations: recommendations.algorithmVersion,
      news: news.algorithmVersion,
    },
  };
}

// ── Write / lifecycle accessors ───────────────────────────────────────────
//
// These run inside the per-request `withUserContext` set by the Home route, so
// the `member_write` RLS policy on each table (see the greenfield migration
// `member_write_tables` loop) scopes every UPDATE to the caller's workspace.
// The explicit `workspace_id` predicate is belt-and-braces with that policy and
// keeps the statements readable. Each returns the affected row's `{ id, status }`
// or `null` when nothing matched (unknown id, foreign workspace, or a status the
// transition does not apply to) so the route can answer 404.

export type HomeInboxMutationResult = {
  id: string;
  status: HomeInboxStatus;
};

export type HomeRecommendationMutationResult = {
  id: string;
  status: HomeRecommendationStatus;
};

export type HomeNewsMutationResult = {
  id: string;
  status: HomeNewsStatus;
  sourceId: string | null;
};

async function withExistingOrNewTransaction<T>(
  db: Sql,
  fn: (txSql: Sql) => Promise<T>,
): Promise<T> {
  const maybeTransaction = db as Sql & { begin?: unknown; savepoint?: unknown };
  if (
    typeof maybeTransaction.savepoint === 'function' ||
    typeof maybeTransaction.begin !== 'function'
  ) {
    return fn(db);
  }
  return (await maybeTransaction.begin(async (tx) =>
    fn(tx as unknown as Sql),
  )) as T;
}

async function lockHomeNewsContextOnSql(
  sql: Sql,
  input: {
    workspaceId: string;
    talkId: string;
  },
): Promise<void> {
  await sql`
    select pg_advisory_xact_lock(
      hashtextextended(
        ${`home-news-context:${input.workspaceId}:${input.talkId}`},
        0
      )
    )
  `;
}

async function nextContextSourceSortOrderOnSql(
  sql: Sql,
  input: {
    workspaceId: string;
    talkId: string;
  },
): Promise<number> {
  const rows = await sql<Array<{ max_order: number }>>`
    select coalesce(max(sort_order), -1)::int as max_order
    from public.context_sources
    where workspace_id = ${input.workspaceId}::uuid
      and talk_id = ${input.talkId}::uuid
      and kind <> 'rule'
  `;
  return (rows[0]?.max_order ?? -1) + 1;
}

/**
 * Dismiss an Inbox item (status → `dismissed`). Idempotent: re-dismissing an
 * already-dismissed item is a no-op that still returns the row. Resolved /
 * expired items are left untouched (returns null) so dismissal never resurrects
 * or rewrites a terminal item.
 */
export async function dismissHomeInboxItem(input: {
  workspaceId: string;
  itemId: string;
}): Promise<HomeInboxMutationResult | null> {
  const db = getDbPg();
  const rows = await db<HomeInboxMutationResult[]>`
    update public.home_inbox_items
       set status = 'dismissed'
     where id = ${input.itemId}::uuid
       and workspace_id = ${input.workspaceId}::uuid
       and status in ('unread', 'read', 'snoozed', 'dismissed')
    returning id, status
  `;
  return rows[0] ?? null;
}

/**
 * Mark an Inbox item read without removing it from the active list. Idempotent
 * over already-read rows; terminal rows return null.
 */
export async function markHomeInboxItemRead(input: {
  workspaceId: string;
  itemId: string;
}): Promise<HomeInboxMutationResult | null> {
  const db = getDbPg();
  const rows = await db<HomeInboxMutationResult[]>`
    update public.home_inbox_items
       set status = 'read'
     where id = ${input.itemId}::uuid
       and workspace_id = ${input.workspaceId}::uuid
       and status in ('unread', 'read')
    returning id, status
  `;
  return rows[0] ?? null;
}

/**
 * Resolve an Inbox item (status → `resolved`). Idempotent over already-resolved
 * rows and stamps `resolved_at` on the first transition.
 */
export async function resolveHomeInboxItem(input: {
  workspaceId: string;
  itemId: string;
}): Promise<HomeInboxMutationResult | null> {
  const db = getDbPg();
  const rows = await db<HomeInboxMutationResult[]>`
    update public.home_inbox_items
       set status = 'resolved',
           resolved_at = coalesce(resolved_at, now())
     where id = ${input.itemId}::uuid
       and workspace_id = ${input.workspaceId}::uuid
       and status in ('unread', 'read', 'snoozed', 'resolved')
    returning id, status
  `;
  return rows[0] ?? null;
}

/**
 * Snooze an Inbox item until `until` (status → `snoozed`). The read query
 * re-surfaces snoozed items once `snoozed_until <= now()`. Only applies to
 * actionable items; terminal items return null.
 */
export async function snoozeHomeInboxItem(input: {
  workspaceId: string;
  itemId: string;
  until: string;
}): Promise<HomeInboxMutationResult | null> {
  const db = getDbPg();
  const rows = await db<HomeInboxMutationResult[]>`
    update public.home_inbox_items
       set status = 'snoozed',
           snoozed_until = ${input.until}::timestamptz
     where id = ${input.itemId}::uuid
       and workspace_id = ${input.workspaceId}::uuid
       and status in ('unread', 'read', 'snoozed')
    returning id, status
  `;
  return rows[0] ?? null;
}

type HomeNewsContextRow = {
  id: string;
  status: HomeNewsStatus;
  news_item_id: string;
  talk_id: string;
  algorithm_version: string | null;
  canonical_url: string;
  title: string;
  source: string | null;
  published_at: string | null;
  excerpt: string | null;
  matched_on_json: unknown;
  impact: HomeNewsImpact;
  why_it_matters: string | null;
};

/**
 * Add a matched news item to its Talk context as a native `kind='news'`
 * context source, then mark the match terminal. Idempotent: a repeat call
 * returns the first source created for this Home news match instead of creating
 * duplicate context rows.
 */
export async function addHomeNewsToContext(input: {
  workspaceId: string;
  matchId: string;
  userId: string;
}): Promise<HomeNewsMutationResult | null> {
  const db = getDbPg();
  return withTrustedDbWrites(() =>
    withExistingOrNewTransaction(db, async (txSql) => {
      const rows = await txSql<HomeNewsContextRow[]>`
        select
          m.id,
          m.status,
          m.news_item_id,
          m.talk_id,
          m.algorithm_version,
          i.canonical_url,
          i.title,
          i.source,
          i.published_at,
          i.excerpt,
          m.matched_on_json,
          m.impact,
          m.why_it_matters
        from public.home_news_matches m
        join public.home_news_items i
          on i.id = m.news_item_id
        join public.talks t
          on t.workspace_id = m.workspace_id
         and t.id = m.talk_id
         and t.archived_at is null
        where m.id = ${input.matchId}::uuid
          and m.workspace_id = ${input.workspaceId}::uuid
          and m.status in ('active', 'added_to_context')
        for update of m
      `;
      const match = rows[0];
      if (!match) return null;

      await lockHomeNewsContextOnSql(txSql, {
        workspaceId: input.workspaceId,
        talkId: match.talk_id,
      });

      const existing = await txSql<Array<{ id: string }>>`
        select id
        from public.context_sources
        where workspace_id = ${input.workspaceId}::uuid
          and talk_id = ${match.talk_id}::uuid
          and kind = 'news'
          and meta_json->>'homeNewsMatchId' = ${match.id}
        order by created_at asc, id asc
        limit 1
      `;
      let sourceId = existing[0]?.id ?? null;

      if (!sourceId) {
        const countRows = await txSql<Array<{ count: number }>>`
          select count(*)::int as count
          from public.context_sources
          where workspace_id = ${input.workspaceId}::uuid
            and talk_id = ${match.talk_id}::uuid
            and kind <> 'rule'
        `;
        if ((countRows[0]?.count ?? 0) >= 50) {
          throw new Error('Maximum 50 saved sources per talk');
        }

        const sortOrder = await nextContextSourceSortOrderOnSql(txSql, {
          workspaceId: input.workspaceId,
          talkId: match.talk_id,
        });
        const now = new Date().toISOString();
        const extractedText = [
          match.title,
          match.excerpt,
          match.why_it_matters ? `Why it matters: ${match.why_it_matters}` : '',
          `Source: ${match.canonical_url}`,
        ]
          .filter((part) => part && part.trim().length > 0)
          .join('\n\n');
        const created = await txSql<Array<{ id: string }>>`
          insert into public.context_sources (
            workspace_id,
            talk_id,
            kind,
            name,
            payload_ref,
            extracted_text,
            summary,
            meta_json,
            include_in_prompt,
            sort_order,
            added_by_user_id
          )
          values (
            ${input.workspaceId}::uuid,
            ${match.talk_id}::uuid,
            'news',
            ${match.title},
            ${match.canonical_url},
            ${extractedText},
            ${match.why_it_matters},
            ${txSql.json({
              sourceType: 'url',
              sourceUrl: match.canonical_url,
              status: 'ready',
              extractedAt: now,
              extractionError: null,
              fetchStrategy: 'managed',
              lastFetchedAt: now,
              homeNewsMatchId: match.id,
              homeNewsItemId: match.news_item_id,
              impact: match.impact,
              source: match.source,
              publishedAt: match.published_at,
              matchedOn: normalizeMatchedOn(match.matched_on_json),
            } as never)},
            true,
            ${sortOrder},
            ${input.userId}::uuid
          )
          returning id
        `;
        sourceId = created[0]?.id ?? null;
      }

      const updated = await txSql<HomeNewsMutationResult[]>`
        update public.home_news_matches
           set status = 'added_to_context'
         where id = ${match.id}::uuid
           and workspace_id = ${input.workspaceId}::uuid
           and status in ('active', 'added_to_context')
        returning id, status, ${sourceId}::uuid as "sourceId"
      `;

      await txSql`
        update public.home_inbox_items
           set status = 'resolved',
               resolved_at = coalesce(resolved_at, now())
         where workspace_id = ${input.workspaceId}::uuid
           and news_item_id = ${match.news_item_id}::uuid
           and status in ('unread', 'read', 'snoozed')
      `;
      await txSql`
        insert into public.home_interaction_events (
          workspace_id, surface, item_id, event_type, algorithm_version,
          metadata_json
        )
        values (
          ${input.workspaceId}::uuid,
          'news',
          ${match.id}::uuid,
          'home.news_added_to_context',
          ${match.algorithm_version ?? HOME_READ_ALGORITHM_VERSION},
          ${txSql.json({
            talkId: match.talk_id,
            newsItemId: match.news_item_id,
            sourceId,
          } as never)}
        )
      `;

      return updated[0] ?? null;
    }),
  );
}

/**
 * Mark a news match not relevant. Idempotent over already-not-relevant rows;
 * added / expired rows are left untouched.
 */
export async function markHomeNewsNotRelevant(input: {
  workspaceId: string;
  matchId: string;
}): Promise<HomeNewsMutationResult | null> {
  const db = getDbPg();
  const rows = await db<HomeNewsMutationResult[]>`
    update public.home_news_matches
       set status = 'not_relevant'
     where id = ${input.matchId}::uuid
       and workspace_id = ${input.workspaceId}::uuid
       and status in ('active', 'not_relevant')
    returning id, status, null::uuid as "sourceId"
  `;
  const result = rows[0] ?? null;
  if (result) {
    await db`
      insert into public.home_interaction_events (
        workspace_id, surface, item_id, event_type, metadata_json
      )
      values (
        ${input.workspaceId}::uuid,
        'news',
        ${input.matchId}::uuid,
        'home.news_not_relevant',
        '{}'::jsonb
      )
    `;
  }
  return result;
}

/**
 * Dismiss a recommendation (status → `dismissed`). Idempotent over an already
 * dismissed row; completed / expired / snoozed recommendations are left as-is
 * (returns null).
 */
export async function dismissHomeRecommendation(input: {
  workspaceId: string;
  recommendationId: string;
}): Promise<HomeRecommendationMutationResult | null> {
  const db = getDbPg();
  const rows = await db<HomeRecommendationMutationResult[]>`
    update public.home_recommendations
       set status = 'dismissed'
     where id = ${input.recommendationId}::uuid
       and workspace_id = ${input.workspaceId}::uuid
       and status in ('active', 'dismissed')
    returning id, status
  `;
  return rows[0] ?? null;
}
