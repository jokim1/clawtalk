import { randomUUID } from 'node:crypto';

import { getDbPg, withTrustedDbWrites, type Sql } from '../../db.js';

export type GreenfieldContextSourceKind =
  | 'document'
  | 'url'
  | 'file'
  | 'past_talk'
  | 'rule'
  | 'news';

export type GreenfieldContextSourceType = 'url' | 'file' | 'text';
export type GreenfieldContextSourceStatus = 'pending' | 'ready' | 'failed';
export type GreenfieldContextSourceFetchStrategy =
  | 'http'
  | 'browser'
  | 'managed';

export interface GreenfieldContextRuleSnapshot {
  id: string;
  ruleText: string;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GreenfieldGoalSnapshot {
  goalText: string;
  updatedAt: string;
  updatedBy: string | null;
}

export interface GreenfieldContextSourceSnapshot {
  id: string;
  sourceRef: string;
  sourceType: GreenfieldContextSourceType;
  title: string;
  titleSlug: string | null;
  note: string | null;
  sortOrder: number;
  status: GreenfieldContextSourceStatus;
  sourceUrl: string | null;
  fileName: string | null;
  fileSize: number | null;
  mimeType: string | null;
  extractedTextLength: number | null;
  extractedAt: string | null;
  lastFetchedAt: string | null;
  extractionError: string | null;
  fetchStrategy: GreenfieldContextSourceFetchStrategy | null;
  isTruncated: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  expectedPageCount: number | null;
  pageImageCount: number;
  pageSetComplete: boolean;
}

export interface GreenfieldContextSourceWithContent extends GreenfieldContextSourceSnapshot {
  extractedText: string | null;
  storageKey: string | null;
}

export interface GreenfieldTalkContextSnapshot {
  goal: GreenfieldGoalSnapshot | null;
  rules: GreenfieldContextRuleSnapshot[];
  sources: GreenfieldContextSourceSnapshot[];
}

export interface GreenfieldContextSourceRow {
  id: string;
  workspace_id: string;
  talk_id: string;
  kind: GreenfieldContextSourceKind;
  name: string;
  source_document_id: string | null;
  source_talk_id: string | null;
  payload_ref: string | null;
  extracted_text: string | null;
  summary: string | null;
  meta_json: unknown;
  expected_page_count: number | null;
  include_in_prompt: boolean;
  sort_order: number | null;
  added_by_user_id: string | null;
  created_at: string;
  updated_at: string;
  page_image_count?: number;
}

const MAX_CONTEXT_SOURCES_PER_TALK = 50;
const MAX_ACTIVE_RULES_PER_TALK = 8;
const MAX_SOURCE_TEXT_CHARS = 50_000;

async function withExistingOrNewTransaction<T>(
  db: Sql,
  fn: (txSql: Sql) => Promise<T>,
): Promise<T> {
  const maybeTransaction = db as Sql & { savepoint?: unknown };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function meta(row: Pick<GreenfieldContextSourceRow, 'meta_json'>) {
  return isRecord(row.meta_json) ? row.meta_json : {};
}

function metaString(
  row: Pick<GreenfieldContextSourceRow, 'meta_json'>,
  key: string,
): string | null {
  const value = meta(row)[key];
  return typeof value === 'string' ? value : null;
}

function metaNumber(
  row: Pick<GreenfieldContextSourceRow, 'meta_json'>,
  key: string,
): number | null {
  const value = meta(row)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function metaBoolean(
  row: Pick<GreenfieldContextSourceRow, 'meta_json'>,
  key: string,
): boolean | null {
  const value = meta(row)[key];
  return typeof value === 'boolean' ? value : null;
}

function normalizeStatus(
  value: string | null,
): GreenfieldContextSourceStatus | null {
  return value === 'pending' || value === 'ready' || value === 'failed'
    ? value
    : null;
}

function normalizeFetchStrategy(
  value: string | null,
): GreenfieldContextSourceFetchStrategy | null {
  return value === 'http' || value === 'browser' || value === 'managed'
    ? value
    : null;
}

function normalizeSourceType(
  row: GreenfieldContextSourceRow,
): GreenfieldContextSourceType {
  const sourceType = metaString(row, 'sourceType');
  if (sourceType === 'url' || sourceType === 'file' || sourceType === 'text') {
    return sourceType;
  }
  if (row.kind === 'url') return 'url';
  if (row.kind === 'file') return 'file';
  return 'text';
}

function slugify(title: string): string | null {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : null;
}

function truncatableText(input: string | null | undefined): {
  text: string | null;
  isTruncated: boolean;
} {
  if (input === undefined || input === null) {
    return { text: null, isTruncated: false };
  }
  if (input.length <= MAX_SOURCE_TEXT_CHARS) {
    return { text: input, isTruncated: false };
  }
  return { text: input.slice(0, MAX_SOURCE_TEXT_CHARS), isTruncated: true };
}

function titleFromText(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= 80) return oneLine || 'Rule';
  return `${oneLine.slice(0, 77).trimEnd()}...`;
}

function sourceStatus(row: GreenfieldContextSourceRow) {
  const explicit = normalizeStatus(metaString(row, 'status'));
  if (explicit) return explicit;
  const extractionError = metaString(row, 'extractionError');
  if (extractionError && !row.extracted_text) return 'failed';
  if (row.kind === 'url' && !row.extracted_text) return 'pending';
  return 'ready';
}

function sourceRef(row: GreenfieldContextSourceRow, index = 0): string {
  return (
    metaString(row, 'sourceRef') ??
    (row.sort_order !== null ? `S${row.sort_order + 1}` : `S${index + 1}`)
  );
}

function toRuleSnapshot(
  row: GreenfieldContextSourceRow,
): GreenfieldContextRuleSnapshot {
  return {
    id: row.id,
    ruleText: row.extracted_text ?? row.name,
    sortOrder: row.sort_order ?? 0,
    isActive: row.include_in_prompt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSourceSnapshot(
  row: GreenfieldContextSourceRow,
  index = 0,
): GreenfieldContextSourceSnapshot {
  const expectedPageCount = row.expected_page_count ?? null;
  const pageImageCount = row.page_image_count ?? 0;
  const sourceType = normalizeSourceType(row);
  const sourceUrl =
    sourceType === 'url'
      ? (metaString(row, 'sourceUrl') ?? row.payload_ref)
      : null;
  const fileName = sourceType === 'file' ? metaString(row, 'fileName') : null;
  const pageSetComplete =
    expectedPageCount !== null &&
    expectedPageCount > 0 &&
    pageImageCount === expectedPageCount;

  return {
    id: row.id,
    sourceRef: sourceRef(row, index),
    sourceType,
    title: row.name,
    titleSlug: slugify(row.name),
    note: metaString(row, 'note'),
    sortOrder: row.sort_order ?? index,
    status: sourceStatus(row),
    sourceUrl,
    fileName,
    fileSize: metaNumber(row, 'fileSize'),
    mimeType: metaString(row, 'mimeType'),
    extractedTextLength: row.extracted_text?.length ?? null,
    extractedAt: metaString(row, 'extractedAt'),
    lastFetchedAt: metaString(row, 'lastFetchedAt'),
    extractionError: metaString(row, 'extractionError'),
    fetchStrategy: normalizeFetchStrategy(metaString(row, 'fetchStrategy')),
    isTruncated: metaBoolean(row, 'isTruncated') ?? false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.added_by_user_id,
    expectedPageCount,
    pageImageCount,
    pageSetComplete,
  };
}

function rowSelectSql() {
  return `
    cs.id,
    cs.workspace_id,
    cs.talk_id,
    cs.kind,
    cs.name,
    cs.source_document_id,
    cs.source_talk_id,
    cs.payload_ref,
    cs.extracted_text,
    cs.summary,
    cs.meta_json,
    cs.expected_page_count,
    cs.include_in_prompt,
    cs.sort_order,
    cs.added_by_user_id,
    cs.created_at,
    cs.updated_at,
    coalesce(count(csp.source_id), 0)::int as page_image_count
  `;
}

async function nextSortOrderOnSql(
  sql: Sql,
  input: {
    workspaceId: string;
    talkId: string;
    kind: 'source' | 'rule';
  },
): Promise<number> {
  const rows = await sql<{ max_order: number }[]>`
    select coalesce(max(sort_order), -1)::int as max_order
    from public.context_sources
    where workspace_id = ${input.workspaceId}::uuid
      and talk_id = ${input.talkId}::uuid
      and (
        ${
          input.kind === 'rule'
        }::boolean and kind = 'rule' and coalesce(meta_json->>'compatKind', 'rule') <> 'goal'
        or ${input.kind === 'source'}::boolean and kind <> 'rule'
      )
  `;
  return (rows[0]?.max_order ?? -1) + 1;
}

async function nextSortOrder(input: {
  workspaceId: string;
  talkId: string;
  kind: 'source' | 'rule';
}): Promise<number> {
  const db = getDbPg();
  return nextSortOrderOnSql(db, input);
}

async function nextSourceRefOnSql(
  sql: Sql,
  input: {
    workspaceId: string;
    talkId: string;
  },
): Promise<string> {
  const rows = await sql<{ max_ref: number }[]>`
    select greatest(
      coalesce(
        max((substring(meta_json->>'sourceRef' from '^S([0-9]+)$'))::int),
        0
      ),
      count(*)
    )::int as max_ref
    from public.context_sources
    where workspace_id = ${input.workspaceId}::uuid
      and talk_id = ${input.talkId}::uuid
      and kind <> 'rule'
  `;
  return `S${(rows[0]?.max_ref ?? 0) + 1}`;
}

async function lockGreenfieldTalkContextOnSql(
  sql: Sql,
  input: {
    workspaceId: string;
    talkId: string;
  },
): Promise<void> {
  await sql`
    select pg_advisory_xact_lock(
      hashtextextended(
        ${`greenfield-context:${input.workspaceId}:${input.talkId}`},
        0
      )
    )
  `;
}

async function lockGreenfieldTalkContext(input: {
  workspaceId: string;
  talkId: string;
}): Promise<void> {
  const db = getDbPg();
  // Context mutation routes run inside withUserContext's transaction; this
  // keeps per-talk source refs, sort allocation, and active-count checks
  // serialized without taking heavyweight table locks.
  await lockGreenfieldTalkContextOnSql(db, input);
}

export async function listGreenfieldContextRules(input: {
  workspaceId: string;
  talkId: string;
}): Promise<GreenfieldContextRuleSnapshot[]> {
  const db = getDbPg();
  const rows = await db<GreenfieldContextSourceRow[]>`
    select ${db.unsafe(rowSelectSql())}
    from public.context_sources cs
    left join public.context_source_pages csp
      on csp.workspace_id = cs.workspace_id
     and csp.source_id = cs.id
    where cs.workspace_id = ${input.workspaceId}::uuid
      and cs.talk_id = ${input.talkId}::uuid
      and cs.kind = 'rule'
      and coalesce(cs.meta_json->>'compatKind', 'rule') <> 'goal'
    group by cs.id
    order by cs.sort_order asc nulls last, cs.created_at asc, cs.id asc
  `;
  return rows.map(toRuleSnapshot);
}

export async function getGreenfieldContextGoal(input: {
  workspaceId: string;
  talkId: string;
}): Promise<GreenfieldGoalSnapshot | null> {
  const db = getDbPg();
  const rows = await db<GreenfieldContextSourceRow[]>`
    select ${db.unsafe(rowSelectSql())}
    from public.context_sources cs
    left join public.context_source_pages csp
      on csp.workspace_id = cs.workspace_id
     and csp.source_id = cs.id
    where cs.workspace_id = ${input.workspaceId}::uuid
      and cs.talk_id = ${input.talkId}::uuid
      and cs.kind = 'rule'
      and cs.meta_json->>'compatKind' = 'goal'
    group by cs.id
    order by cs.created_at asc, cs.id asc
    limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    goalText: row.extracted_text ?? '',
    updatedAt: row.updated_at,
    updatedBy: metaString(row, 'updatedBy'),
  };
}

export async function setGreenfieldContextGoal(input: {
  workspaceId: string;
  talkId: string;
  goalText: string;
  updatedBy: string;
}): Promise<GreenfieldGoalSnapshot | null> {
  const db = getDbPg();
  await lockGreenfieldTalkContext(input);
  if (input.goalText.trim().length === 0) {
    await withTrustedDbWrites(async () => {
      await db`
        delete from public.context_sources
        where workspace_id = ${input.workspaceId}::uuid
          and talk_id = ${input.talkId}::uuid
          and kind = 'rule'
          and meta_json->>'compatKind' = 'goal'
      `;
    });
    return null;
  }

  const patch = db.json({
    compatKind: 'goal',
    updatedBy: input.updatedBy,
  } as never);
  const rows = await withTrustedDbWrites(
    () => db<GreenfieldContextSourceRow[]>`
      with existing as (
        select id
        from public.context_sources
        where workspace_id = ${input.workspaceId}::uuid
          and talk_id = ${input.talkId}::uuid
          and kind = 'rule'
          and meta_json->>'compatKind' = 'goal'
        order by created_at asc, id asc
        limit 1
      ),
      updated as (
        update public.context_sources
        set name = 'Goal',
            extracted_text = ${input.goalText},
            meta_json = meta_json || ${patch},
            include_in_prompt = ${input.goalText.trim().length > 0},
            updated_at = now()
        where id in (select id from existing)
        returning *
      ),
      inserted as (
        insert into public.context_sources (
          workspace_id, talk_id, kind, name, extracted_text, meta_json,
          include_in_prompt, sort_order, added_by_user_id
        )
        select
          ${input.workspaceId}::uuid,
          ${input.talkId}::uuid,
          'rule',
          'Goal',
          ${input.goalText},
          ${patch},
          ${input.goalText.trim().length > 0},
          -2000,
          ${input.updatedBy}::uuid
        where not exists (select 1 from existing)
        returning *
      )
      select ${db.unsafe(rowSelectSql())}
      from (
        select * from updated
        union all
        select * from inserted
      ) cs
      left join public.context_source_pages csp
        on csp.workspace_id = cs.workspace_id
       and csp.source_id = cs.id
      group by cs.id, cs.workspace_id, cs.talk_id, cs.kind, cs.name,
        cs.source_document_id, cs.source_talk_id, cs.payload_ref,
        cs.extracted_text, cs.summary, cs.meta_json, cs.expected_page_count,
        cs.include_in_prompt, cs.sort_order, cs.added_by_user_id,
        cs.created_at, cs.updated_at
      limit 1
    `,
  );
  const row = rows[0];
  return {
    goalText: row?.extracted_text ?? input.goalText,
    updatedAt: row?.updated_at ?? new Date().toISOString(),
    updatedBy: input.updatedBy,
  };
}

export async function createGreenfieldContextRule(input: {
  workspaceId: string;
  talkId: string;
  ruleText: string;
  createdBy: string;
}): Promise<GreenfieldContextRuleSnapshot> {
  const db = getDbPg();
  const rows = await withTrustedDbWrites(() =>
    withExistingOrNewTransaction(db, async (txSql) => {
      await lockGreenfieldTalkContextOnSql(txSql, input);
      const active = await txSql<{ count: number }[]>`
        select count(*)::int as count
        from public.context_sources
        where workspace_id = ${input.workspaceId}::uuid
          and talk_id = ${input.talkId}::uuid
          and kind = 'rule'
          and coalesce(meta_json->>'compatKind', 'rule') <> 'goal'
          and include_in_prompt = true
      `;
      if ((active[0]?.count ?? 0) >= MAX_ACTIVE_RULES_PER_TALK) {
        throw new Error('Maximum 8 active rules per talk');
      }

      const sortOrder = await nextSortOrderOnSql(txSql, {
        workspaceId: input.workspaceId,
        talkId: input.talkId,
        kind: 'rule',
      });
      return txSql<GreenfieldContextSourceRow[]>`
        insert into public.context_sources (
          workspace_id, talk_id, kind, name, extracted_text, meta_json,
          include_in_prompt, sort_order, added_by_user_id
        )
        values (
          ${input.workspaceId}::uuid,
          ${input.talkId}::uuid,
          'rule',
          ${titleFromText(input.ruleText)},
          ${input.ruleText},
          ${txSql.json({ compatKind: 'rule' } as never)},
          true,
          ${sortOrder},
          ${input.createdBy}::uuid
        )
        returning *
      `;
    }),
  );
  return toRuleSnapshot(rows[0]!);
}

export async function patchGreenfieldContextRule(input: {
  workspaceId: string;
  talkId: string;
  ruleId: string;
  ruleText?: string;
  isActive?: boolean;
  sortOrder?: number;
}): Promise<GreenfieldContextRuleSnapshot | undefined> {
  const db = getDbPg();
  const rows = await withTrustedDbWrites(() =>
    withExistingOrNewTransaction(db, async (txSql) => {
      await lockGreenfieldTalkContextOnSql(txSql, input);
      if (input.isActive === true) {
        const active = await txSql<{ count: number }[]>`
          select count(*)::int as count
          from public.context_sources
          where workspace_id = ${input.workspaceId}::uuid
            and talk_id = ${input.talkId}::uuid
            and kind = 'rule'
            and coalesce(meta_json->>'compatKind', 'rule') <> 'goal'
            and include_in_prompt = true
            and id <> ${input.ruleId}::uuid
        `;
        if ((active[0]?.count ?? 0) >= MAX_ACTIVE_RULES_PER_TALK) {
          throw new Error('Maximum 8 active rules per talk');
        }
      }

      return txSql<GreenfieldContextSourceRow[]>`
        update public.context_sources
        set
          name = coalesce(${input.ruleText ? titleFromText(input.ruleText) : null}, name),
          extracted_text = coalesce(${input.ruleText ?? null}, extracted_text),
          include_in_prompt = coalesce(${input.isActive ?? null}, include_in_prompt),
          sort_order = coalesce(${input.sortOrder !== undefined ? input.sortOrder : null}, sort_order),
          meta_json = meta_json || ${txSql.json({ compatKind: 'rule' } as never)},
          updated_at = now()
        where workspace_id = ${input.workspaceId}::uuid
          and talk_id = ${input.talkId}::uuid
          and id = ${input.ruleId}::uuid
          and kind = 'rule'
          and coalesce(meta_json->>'compatKind', 'rule') <> 'goal'
        returning *
      `;
    }),
  );
  return rows[0] ? toRuleSnapshot(rows[0]) : undefined;
}

export async function deleteGreenfieldContextRule(input: {
  workspaceId: string;
  talkId: string;
  ruleId: string;
}): Promise<boolean> {
  const db = getDbPg();
  const rows = await withTrustedDbWrites(
    () => db<{ id: string }[]>`
      delete from public.context_sources
      where workspace_id = ${input.workspaceId}::uuid
        and talk_id = ${input.talkId}::uuid
        and id = ${input.ruleId}::uuid
        and kind = 'rule'
        and coalesce(meta_json->>'compatKind', 'rule') <> 'goal'
      returning id
    `,
  );
  return rows.length > 0;
}

export async function listGreenfieldContextSources(input: {
  workspaceId: string;
  talkId: string;
}): Promise<GreenfieldContextSourceSnapshot[]> {
  const db = getDbPg();
  const rows = await db<GreenfieldContextSourceRow[]>`
    select ${db.unsafe(rowSelectSql())}
    from public.context_sources cs
    left join public.context_source_pages csp
      on csp.workspace_id = cs.workspace_id
     and csp.source_id = cs.id
    where cs.workspace_id = ${input.workspaceId}::uuid
      and cs.talk_id = ${input.talkId}::uuid
      and cs.kind <> 'rule'
    group by cs.id
    order by cs.sort_order asc nulls last, cs.created_at asc, cs.id asc
  `;
  return rows.map(toSourceSnapshot);
}

export async function getGreenfieldContextSourceCount(input: {
  workspaceId: string;
  talkId: string;
}): Promise<number> {
  const db = getDbPg();
  return getGreenfieldContextSourceCountOnSql(db, input);
}

async function getGreenfieldContextSourceCountOnSql(
  sql: Sql,
  input: {
    workspaceId: string;
    talkId: string;
  },
): Promise<number> {
  const rows = await sql<{ count: number }[]>`
    select count(*)::int as count
    from public.context_sources
    where workspace_id = ${input.workspaceId}::uuid
      and talk_id = ${input.talkId}::uuid
      and kind <> 'rule'
  `;
  return rows[0]?.count ?? 0;
}

export async function getGreenfieldContextSourceById(input: {
  workspaceId: string;
  talkId: string;
  sourceId: string;
}): Promise<GreenfieldContextSourceWithContent | undefined> {
  const db = getDbPg();
  const rows = await db<GreenfieldContextSourceRow[]>`
    select ${db.unsafe(rowSelectSql())}
    from public.context_sources cs
    left join public.context_source_pages csp
      on csp.workspace_id = cs.workspace_id
     and csp.source_id = cs.id
    where cs.workspace_id = ${input.workspaceId}::uuid
      and cs.talk_id = ${input.talkId}::uuid
      and cs.id = ${input.sourceId}::uuid
      and cs.kind <> 'rule'
    group by cs.id
    limit 1
  `;
  const row = rows[0];
  if (!row) return undefined;
  return {
    ...toSourceSnapshot(row),
    extractedText: row.extracted_text,
    storageKey: normalizeSourceType(row) === 'file' ? row.payload_ref : null,
  };
}

export async function getGreenfieldTalkContext(input: {
  workspaceId: string;
  talkId: string;
}): Promise<GreenfieldTalkContextSnapshot> {
  const [goal, rules, sources] = await Promise.all([
    getGreenfieldContextGoal(input),
    listGreenfieldContextRules(input),
    listGreenfieldContextSources(input),
  ]);
  return { goal, rules, sources };
}

export async function createGreenfieldContextSource(input: {
  id?: string;
  workspaceId: string;
  talkId: string;
  sourceType: GreenfieldContextSourceType;
  title: string;
  note?: string | null;
  sourceUrl?: string | null;
  fileName?: string | null;
  fileSize?: number | null;
  mimeType?: string | null;
  storageKey?: string | null;
  extractedText?: string | null;
  extractionError?: string | null;
  createdBy: string;
}): Promise<GreenfieldContextSourceSnapshot> {
  const title = input.title.trim();
  if (!title) throw new Error('Source title is required');
  const now = new Date().toISOString();
  const { text: extractedText, isTruncated } = truncatableText(
    input.extractedText,
  );
  const hasExtractedText =
    extractedText !== null && extractedText.trim().length > 0;
  const isImageFile = input.mimeType?.startsWith('image/') === true;
  const extractionError =
    input.extractionError ??
    (input.sourceType === 'file' && !isImageFile && !hasExtractedText
      ? 'No extracted text returned.'
      : null);

  let status: GreenfieldContextSourceStatus = 'pending';
  let extractedAt: string | null = null;
  if (input.sourceType === 'text') {
    status = 'ready';
    extractedAt = now;
  } else if (input.sourceType === 'file') {
    status = extractionError && !hasExtractedText ? 'failed' : 'ready';
    extractedAt = hasExtractedText ? now : null;
  }

  const kind: GreenfieldContextSourceKind =
    input.sourceType === 'url' ? 'url' : 'file';
  const payloadRef =
    input.sourceType === 'url'
      ? (input.sourceUrl ?? null)
      : (input.storageKey ?? null);
  const sourceId = input.id ?? randomUUID();
  const db = getDbPg();
  const rows = await withTrustedDbWrites(() =>
    withExistingOrNewTransaction(db, async (txSql) => {
      await lockGreenfieldTalkContextOnSql(txSql, input);
      const count = await getGreenfieldContextSourceCountOnSql(txSql, {
        workspaceId: input.workspaceId,
        talkId: input.talkId,
      });
      if (count >= MAX_CONTEXT_SOURCES_PER_TALK) {
        throw new Error('Maximum 50 saved sources per talk');
      }

      const sortOrder = await nextSortOrderOnSql(txSql, {
        workspaceId: input.workspaceId,
        talkId: input.talkId,
        kind: 'source',
      });
      const sourceRef = await nextSourceRefOnSql(txSql, {
        workspaceId: input.workspaceId,
        talkId: input.talkId,
      });
      const metaJson = {
        compatKind: 'source',
        sourceRef,
        sourceType: input.sourceType,
        note: input.note?.trim() || null,
        sourceUrl:
          input.sourceType === 'url' ? (input.sourceUrl ?? null) : null,
        fileName: input.fileName ?? null,
        fileSize: input.fileSize ?? null,
        mimeType: input.mimeType ?? null,
        status,
        extractedAt,
        extractionError,
        fetchStrategy: null,
        lastFetchedAt: null,
        isTruncated,
      };

      return txSql<GreenfieldContextSourceRow[]>`
        insert into public.context_sources (
          id, workspace_id, talk_id, kind, name, payload_ref, extracted_text,
          meta_json, include_in_prompt, sort_order, added_by_user_id
        )
        values (
          ${sourceId}::uuid,
          ${input.workspaceId}::uuid,
          ${input.talkId}::uuid,
          ${kind},
          ${title},
          ${payloadRef},
          ${extractedText},
          ${txSql.json(metaJson as never)},
          true,
          ${sortOrder},
          ${input.createdBy}::uuid
        )
        returning *
      `;
    }),
  );
  return toSourceSnapshot(rows[0]!);
}

export async function patchGreenfieldContextSource(input: {
  workspaceId: string;
  talkId: string;
  sourceId: string;
  title?: string;
  note?: string | null;
  sortOrder?: number;
  extractedText?: string | null;
}): Promise<GreenfieldContextSourceSnapshot | undefined> {
  await lockGreenfieldTalkContext(input);
  const existing = await getGreenfieldContextSourceById(input);
  if (!existing) return undefined;

  const db = getDbPg();
  const title = input.title !== undefined ? input.title.trim() : existing.title;
  if (!title) throw new Error('Source title is required');
  if (input.extractedText !== undefined && existing.sourceType !== 'text') {
    throw new Error('Only text sources can update extracted text via patch');
  }
  const metaPatch: Record<string, unknown> = {
    note: input.note !== undefined ? input.note?.trim() || null : existing.note,
  };
  let extractedText: string | null = null;
  const shouldUpdateExtractedText =
    input.extractedText !== undefined && existing.sourceType === 'text';
  if (shouldUpdateExtractedText) {
    const truncated = truncatableText(input.extractedText);
    extractedText = truncated.text;
    metaPatch.status = 'ready';
    metaPatch.extractedAt = new Date().toISOString();
    metaPatch.extractionError = null;
    metaPatch.isTruncated = truncated.isTruncated;
  }

  const rows = await withTrustedDbWrites(
    () => db<GreenfieldContextSourceRow[]>`
      update public.context_sources
      set
        name = ${title},
        sort_order = coalesce(${input.sortOrder !== undefined ? input.sortOrder : null}, sort_order),
        extracted_text = case
          when ${shouldUpdateExtractedText}::boolean then ${extractedText}
          else extracted_text
        end,
        meta_json = meta_json || ${db.json(metaPatch as never)},
        updated_at = now()
      where workspace_id = ${input.workspaceId}::uuid
        and talk_id = ${input.talkId}::uuid
        and id = ${input.sourceId}::uuid
        and kind <> 'rule'
      returning *
    `,
  );
  return rows[0]
    ? await getGreenfieldContextSourceById({
        workspaceId: input.workspaceId,
        talkId: input.talkId,
        sourceId: input.sourceId,
      })
    : undefined;
}

export async function markGreenfieldContextSourcePending(input: {
  workspaceId: string;
  talkId: string;
  sourceId: string;
}): Promise<GreenfieldContextSourceSnapshot | undefined> {
  const db = getDbPg();
  const rows = await withTrustedDbWrites(
    () => db<GreenfieldContextSourceRow[]>`
      update public.context_sources
      set
        meta_json = meta_json || ${db.json({
          status: 'pending',
          extractionError: null,
        } as never)},
        updated_at = now()
      where workspace_id = ${input.workspaceId}::uuid
        and talk_id = ${input.talkId}::uuid
        and id = ${input.sourceId}::uuid
        and kind = 'url'
      returning *
    `,
  );
  return rows[0]
    ? await getGreenfieldContextSourceById({
        workspaceId: input.workspaceId,
        talkId: input.talkId,
        sourceId: input.sourceId,
      })
    : undefined;
}

export async function updateGreenfieldContextSourceExtraction(input: {
  workspaceId: string;
  talkId: string;
  sourceId: string;
  extractedText: string | null;
  extractionError: string | null;
  mimeType?: string | null;
  fetchStrategy?: GreenfieldContextSourceFetchStrategy | null;
  fetchedAt?: string | null;
}): Promise<void> {
  const db = getDbPg();
  const fetchedAt = input.fetchedAt ?? new Date().toISOString();
  const extractionError =
    input.extractionError ??
    (input.extractedText === null || input.extractedText.trim().length === 0
      ? 'No extracted text returned.'
      : null);
  if (extractionError) {
    await withTrustedDbWrites(async () => {
      await db`
        update public.context_sources
        set
          meta_json = meta_json || jsonb_build_object(
            'status',
            case when extracted_text is not null then 'ready' else 'failed' end,
            'extractionError', ${extractionError}::text,
            'mimeType', coalesce(${input.mimeType ?? null}::text, meta_json->>'mimeType'),
            'fetchStrategy', coalesce(${input.fetchStrategy ?? null}::text, meta_json->>'fetchStrategy'),
            'lastFetchedAt', ${fetchedAt}::text
          ),
          updated_at = now()
        where id = ${input.sourceId}::uuid
          and workspace_id = ${input.workspaceId}::uuid
          and talk_id = ${input.talkId}::uuid
          and kind <> 'rule'
      `;
    });
    return;
  }

  const truncated = truncatableText(input.extractedText);
  await withTrustedDbWrites(async () => {
    await db`
      update public.context_sources
      set
        extracted_text = ${truncated.text},
        meta_json = meta_json || jsonb_build_object(
          'status', 'ready',
          'extractionError', null,
          'mimeType', coalesce(${input.mimeType ?? null}::text, meta_json->>'mimeType'),
          'fetchStrategy', coalesce(${input.fetchStrategy ?? null}::text, meta_json->>'fetchStrategy'),
          'lastFetchedAt', ${fetchedAt}::text,
          'extractedAt', ${fetchedAt}::text,
          'isTruncated', ${truncated.isTruncated}
        ),
        updated_at = now()
      where id = ${input.sourceId}::uuid
        and workspace_id = ${input.workspaceId}::uuid
        and talk_id = ${input.talkId}::uuid
        and kind <> 'rule'
    `;
  });
}

export async function deleteGreenfieldContextSource(input: {
  workspaceId: string;
  talkId: string;
  sourceId: string;
}): Promise<boolean> {
  const db = getDbPg();
  const rows = await withTrustedDbWrites(
    () => db<{ id: string }[]>`
      delete from public.context_sources
      where workspace_id = ${input.workspaceId}::uuid
        and talk_id = ${input.talkId}::uuid
        and id = ${input.sourceId}::uuid
        and kind <> 'rule'
      returning id
    `,
  );
  return rows.length > 0;
}

export async function setGreenfieldSourceExpectedPageCount(input: {
  workspaceId: string;
  talkId: string;
  sourceId: string;
  expectedPageCount: number;
}): Promise<boolean> {
  const db = getDbPg();
  const rows = await withTrustedDbWrites(
    () => db<{ id: string }[]>`
      update public.context_sources
      set expected_page_count = ${input.expectedPageCount}
      where workspace_id = ${input.workspaceId}::uuid
        and talk_id = ${input.talkId}::uuid
        and id = ${input.sourceId}::uuid
        and (
          expected_page_count is null
          or expected_page_count = ${input.expectedPageCount}
        )
      returning id
    `,
  );
  return rows.length > 0;
}

export async function insertGreenfieldSourcePageImage(input: {
  workspaceId: string;
  sourceId: string;
  pageIndex: number;
  byteSize: number;
  payloadRef: string;
}): Promise<void> {
  const db = getDbPg();
  await withTrustedDbWrites(async () => {
    await db`
      insert into public.context_source_pages (
        workspace_id, source_id, page_index, byte_size, payload_ref
      )
      values (
        ${input.workspaceId}::uuid,
        ${input.sourceId}::uuid,
        ${input.pageIndex},
        ${input.byteSize},
        ${input.payloadRef}
      )
      on conflict (source_id, page_index) do update
        set byte_size = excluded.byte_size,
            payload_ref = excluded.payload_ref
    `;
  });
}

export async function countGreenfieldSourcePageImages(input: {
  workspaceId: string;
  sourceId: string;
}): Promise<number> {
  const db = getDbPg();
  const rows = await db<{ count: number }[]>`
    select count(*)::int as count
    from public.context_source_pages
    where workspace_id = ${input.workspaceId}::uuid
      and source_id = ${input.sourceId}::uuid
  `;
  return rows[0]?.count ?? 0;
}

export async function listGreenfieldSourcePageIndices(input: {
  workspaceId: string;
  sourceId: string;
}): Promise<number[]> {
  const db = getDbPg();
  const rows = await db<{ page_index: number }[]>`
    select page_index
    from public.context_source_pages
    where workspace_id = ${input.workspaceId}::uuid
      and source_id = ${input.sourceId}::uuid
    order by page_index asc
  `;
  return rows.map((row) => row.page_index);
}
