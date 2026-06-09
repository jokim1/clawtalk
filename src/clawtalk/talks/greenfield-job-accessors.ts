import { randomUUID } from 'node:crypto';

import { getDbPg, type Sql, withTrustedDbWrites } from '../../db.js';
import { logger } from '../../logger.js';
import {
  buildEffectiveToolsFromTalkToolRows,
  normalizeTalkToolFamiliesFromRows,
  TALK_TOOL_IDS_BY_FAMILY,
  TALK_RUNTIME_TOOLS_BY_TOOL_ID,
  type RegisteredAgentRecord,
  type UserToolPermission,
  type UserToolPermissionRecord,
} from '../db/agent-accessors.js';
import { resolveCredentialKindSnapshot } from '../agents/execution-resolver.js';
import {
  expandImpliedScopes,
  normalizeGoogleScopeAliases,
} from '../identity/google-scopes.js';
import { emitOutboxEventOnSql, enqueueOutboxNotify } from './outbox-emit.js';
import { buildOwnerEmailWorkspaceFilter } from './scheduler-owner-filter.js';

export type GreenfieldJobStatus = 'active' | 'paused' | 'blocked';
export type GreenfieldJobWeekday =
  | 'sun'
  | 'mon'
  | 'tue'
  | 'wed'
  | 'thu'
  | 'fri'
  | 'sat';

export type GreenfieldJobApiSchedule =
  | { kind: 'hourly_interval'; everyHours: number }
  | { kind: 'interval'; everyHours: number }
  | { kind: 'daily'; hour: number; minute: number }
  | {
      kind: 'weekly';
      weekdays: GreenfieldJobWeekday[];
      hour: number;
      minute: number;
    };

type StoredGreenfieldJobSchedule =
  | { kind: 'interval'; every_hours: number }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekly'; weekdays: number[]; hour: number; minute: number };

export interface GreenfieldJobScope {
  toolIds: string[];
  allowWeb: boolean;
}

type StoredGreenfieldJobScope = {
  allow_web?: unknown;
  allowWeb?: unknown;
  tool_ids?: unknown;
  toolIds?: unknown;
};

type TalkToolStateRow = { tool_id: string; enabled: boolean };

interface PendingOutboxNotify {
  topic: string;
  eventId: number;
  ownerIds: string[];
}

function uniqueOwnerIds(
  rows: Array<{ user_id: string }>,
  fallbackUserId: string,
): string[] {
  const ids = new Set(rows.map((row) => row.user_id).filter(Boolean));
  ids.add(fallbackUserId);
  return Array.from(ids);
}

async function listWorkspaceNotifyOwnerIdsOnSql(input: {
  sql: Sql;
  workspaceId: string;
  fallbackUserId: string;
}): Promise<string[]> {
  const rows = await withTrustedDbWrites(
    () => input.sql<Array<{ user_id: string }>>`
      select user_id::text as user_id
      from public.workspace_members
      where workspace_id = ${input.workspaceId}::uuid
      order by created_at asc, user_id asc
    `,
  );
  return uniqueOwnerIds(rows, input.fallbackUserId);
}

const WORKSPACE_CONNECTOR_SERVICE_BY_TOOL_ID: Record<string, string> = {
  linear: 'linear',
  'github-read': 'github',
  'notion-read': 'notion',
  messaging: 'slack',
};

const GOOGLE_TOOL_CONNECTOR_SERVICE_BY_TOOL_ID: Record<string, string> = {
  'gdrive-read': 'gdrive',
  'gdrive-write': 'gdrive',
  'gmail-read': 'gmail',
  'gmail-send': 'gmail',
};

const REQUIRED_CONNECTOR_SERVICE_BY_TOOL_ID: Record<string, string> = {
  ...WORKSPACE_CONNECTOR_SERVICE_BY_TOOL_ID,
  ...GOOGLE_TOOL_CONNECTOR_SERVICE_BY_TOOL_ID,
};

const GOOGLE_TOOL_CONNECTOR_SERVICES = new Set(
  Object.values(GOOGLE_TOOL_CONNECTOR_SERVICE_BY_TOOL_ID),
);

const GOOGLE_TOOL_REQUIRED_SCOPE_ALIASES_BY_TOOL_ID: Record<string, string[]> =
  {
    'gdrive-read': [
      'drive.readonly',
      'documents.readonly',
      'spreadsheets.readonly',
    ],
    'gdrive-write': ['documents', 'spreadsheets'],
    'gmail-read': ['gmail.readonly'],
    'gmail-send': ['gmail.send'],
  };

const MUTATING_JOB_TOOL_IDS = new Set([
  'gdrive-write',
  'gmail-send',
  'messaging',
]);

const UNSUPPORTED_JOB_TOOL_IDS = new Set(['gmail-read', 'gmail-send']);
const GREENFIELD_WEB_JOB_TOOL_ID = 'web-search';

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

export function googleToolCredentialHasRequiredScopes(input: {
  scopes: unknown;
  toolId: string;
}): boolean {
  const requiredScopes =
    GOOGLE_TOOL_REQUIRED_SCOPE_ALIASES_BY_TOOL_ID[input.toolId] ?? [];
  if (requiredScopes.length === 0) return true;
  const expandedGrantedScopes = new Set(
    expandImpliedScopes(
      normalizeGoogleScopeAliases(readStringArray(input.scopes)),
    ),
  );
  return normalizeGoogleScopeAliases(requiredScopes).every((scope) =>
    expandedGrantedScopes.has(scope),
  );
}

interface GreenfieldJobRow {
  id: string;
  workspace_id: string;
  talk_id: string;
  created_by: string;
  title: string;
  prompt: string;
  agent_id: string | null;
  agent_name: string | null;
  status: GreenfieldJobStatus;
  block_reason: string | null;
  schedule_json: unknown;
  timezone: string;
  source_scope_json: unknown;
  emit_talk_message: boolean;
  emit_document_append: boolean;
  catch_up: 'skip' | 'run_once';
  next_due_at: string | null;
  last_run_at: string | null;
  last_run_status: string | null;
  run_count: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

interface GreenfieldJobRosterAgentRecord {
  id: string;
  role_key: string;
  name: string;
  handle: string;
  initials: string;
  accent: string;
  accent_dark: string | null;
  model_id: string;
  provider_id: string | null;
  temperature: string | number;
  persona: string | null;
  focus: string | null;
  method: string[];
  sort_order: number;
  created_from_template_version: number | null;
  credential_mode: 'api_key' | 'subscription' | null;
}

export interface GreenfieldJob {
  id: string;
  talkId: string;
  ownerId: string;
  title: string;
  prompt: string;
  targetAgentId: string | null;
  targetAgentNickname: string | null;
  status: GreenfieldJobStatus;
  blockReason: string | null;
  schedule: GreenfieldJobApiSchedule;
  timezone: string;
  sourceScope: GreenfieldJobScope;
  threadId: string;
  emitTalkMessage: boolean;
  emitDocumentAppend: boolean;
  catchUp: 'skip' | 'run_once';
  lastRunAt: string | null;
  lastRunStatus: string | null;
  nextDueAt: string | null;
  runCount: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

export interface GreenfieldJobRunSummary {
  id: string;
  threadId: string;
  status:
    | 'queued'
    | 'running'
    | 'awaiting_confirmation'
    | 'cancelled'
    | 'completed'
    | 'failed';
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  triggerMessageId: string | null;
  responseExcerpt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  cancelReason: string | null;
  executorAlias: string | null;
  executorModel: string | null;
  providerId: string | null;
}

export type GreenfieldJobDependencyIssue = {
  code:
    | 'agent_missing'
    | 'model_disabled'
    | 'no_primary_document'
    | 'tool_not_enabled'
    | 'connector_not_authorized';
  message: string;
};

export type CreateGreenfieldJobRunNowResult =
  | { status: 'enqueued'; job: GreenfieldJob; runId: string }
  | { status: 'not_found' }
  | { status: 'forbidden'; job: GreenfieldJob }
  | { status: 'archived'; job: GreenfieldJob }
  | {
      status: 'blocked';
      job: GreenfieldJob;
      issue: GreenfieldJobDependencyIssue;
    }
  | { status: 'job_busy'; job: GreenfieldJob }
  | { status: 'talk_busy'; job: GreenfieldJob };

export interface ClaimDueGreenfieldJobRunsResult {
  enqueuedRunIds: string[];
  blockedJobIds: string[];
  skippedJobIds: string[];
  busyJobIds: string[];
  failedJobIds: string[];
}

const WEEKDAY_TO_NUMBER: Record<GreenfieldJobWeekday, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};
const NUMBER_TO_WEEKDAY: Record<number, GreenfieldJobWeekday> = {
  0: 'sun',
  1: 'mon',
  2: 'tue',
  3: 'wed',
  4: 'thu',
  5: 'fri',
  6: 'sat',
};

type GreenfieldJobLocalDateParts = {
  year: number;
  month: number;
  day: number;
  weekday: number;
  hour: number;
  minute: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeTitle(title: string): string {
  const normalized = title.trim();
  if (!normalized) throw new Error('Job title is required');
  return normalized;
}

function normalizePrompt(prompt: string): string {
  const normalized = prompt.trim();
  if (!normalized) throw new Error('Job prompt is required');
  return normalized;
}

function normalizeIntegerInRange(
  value: unknown,
  min: number,
  max: number,
  label: string,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function validateTimezone(timezone: string): string {
  const normalized = timezone.trim();
  if (!normalized) throw new Error('Timezone is required');
  try {
    Intl.DateTimeFormat('en-US', { timeZone: normalized }).format(new Date());
    return normalized;
  } catch {
    throw new Error('Timezone is invalid');
  }
}

function normalizeWeekdayNumber(value: unknown): number | null {
  if (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 6
  ) {
    return value;
  }
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized in WEEKDAY_TO_NUMBER) {
    return WEEKDAY_TO_NUMBER[normalized as GreenfieldJobWeekday];
  }
  return null;
}

function normalizeWeekdayNumbers(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Weekly schedules require at least one weekday');
  }
  const weekdays = Array.from(
    new Set(
      value
        .map(normalizeWeekdayNumber)
        .filter((entry): entry is number => entry !== null),
    ),
  );
  if (weekdays.length === 0) {
    throw new Error('Weekly schedules require valid weekdays');
  }
  return weekdays.sort((a, b) => a - b);
}

function toApiWeekdays(value: number[]): GreenfieldJobWeekday[] {
  return value
    .map((entry) => NUMBER_TO_WEEKDAY[entry])
    .filter((entry): entry is GreenfieldJobWeekday => Boolean(entry));
}

function normalizeStoredSchedule(raw: unknown): StoredGreenfieldJobSchedule {
  if (!isRecord(raw)) throw new Error('Schedule is required');
  if (raw.kind === 'hourly_interval' || raw.kind === 'interval') {
    return {
      kind: 'interval',
      every_hours: normalizeIntegerInRange(
        raw.everyHours ?? raw.every_hours,
        1,
        24,
        'everyHours',
      ),
    };
  }
  if (raw.kind === 'daily') {
    return {
      kind: 'daily',
      hour: normalizeIntegerInRange(raw.hour, 0, 23, 'hour'),
      minute: normalizeIntegerInRange(raw.minute, 0, 59, 'minute'),
    };
  }
  if (raw.kind === 'weekly') {
    return {
      kind: 'weekly',
      weekdays: normalizeWeekdayNumbers(raw.weekdays),
      hour: normalizeIntegerInRange(raw.hour, 0, 23, 'hour'),
      minute: normalizeIntegerInRange(raw.minute, 0, 59, 'minute'),
    };
  }
  throw new Error(
    'Schedule kind must be interval, hourly_interval, daily, or weekly',
  );
}

function toApiSchedule(raw: unknown): GreenfieldJobApiSchedule {
  const stored = normalizeStoredSchedule(raw);
  if (stored.kind === 'interval') {
    return { kind: 'hourly_interval', everyHours: stored.every_hours };
  }
  if (stored.kind === 'daily') {
    return { kind: 'daily', hour: stored.hour, minute: stored.minute };
  }
  return {
    kind: 'weekly',
    weekdays: toApiWeekdays(stored.weekdays),
    hour: stored.hour,
    minute: stored.minute,
  };
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter(Boolean),
    ),
  );
}

function normalizeStoredScope(raw: unknown): {
  stored: { allow_web: boolean; tool_ids: string[] };
  api: GreenfieldJobScope;
} {
  const source = isRecord(raw) ? (raw as StoredGreenfieldJobScope) : {};
  const toolIds = normalizeStringList(source.tool_ids ?? source.toolIds);
  const api = {
    toolIds,
    allowWeb: source.allow_web === true || source.allowWeb === true,
  };
  return {
    stored: { allow_web: api.allowWeb, tool_ids: toolIds },
    api,
  };
}

function readScopeField(
  source: StoredGreenfieldJobScope,
  snakeKey: keyof StoredGreenfieldJobScope,
  camelKey: keyof StoredGreenfieldJobScope,
  fallback: unknown,
): unknown {
  if (source[snakeKey] !== undefined) return source[snakeKey];
  if (source[camelKey] !== undefined) return source[camelKey];
  return fallback;
}

function mergeScopePatch(current: GreenfieldJobScope, patch: unknown): unknown {
  if (!isRecord(patch)) return patch;
  const source = patch as StoredGreenfieldJobScope;
  return {
    toolIds: readScopeField(source, 'tool_ids', 'toolIds', current.toolIds),
    allowWeb: readScopeField(source, 'allow_web', 'allowWeb', current.allowWeb),
  };
}

function unsupportedSourceScopeIssue(
  sourceScope: GreenfieldJobScope,
): GreenfieldJobDependencyIssue | null {
  const unsupportedToolId = sourceScope.toolIds.find((toolId) =>
    UNSUPPORTED_JOB_TOOL_IDS.has(toolId),
  );
  if (unsupportedToolId) {
    return {
      code: 'tool_not_enabled',
      message: `Tool ${unsupportedToolId} is not supported by the greenfield jobs runtime yet.`,
    };
  }
  return null;
}

function assertSupportedJobSourceScope(sourceScope: GreenfieldJobScope): void {
  const issue = unsupportedSourceScopeIssue(sourceScope);
  if (issue) throw new Error(issue.message);
}

function filterTalkToolRowsForJobScope(
  rows: TalkToolStateRow[],
  sourceScope: { allow_web: boolean; tool_ids: string[] },
): TalkToolStateRow[] {
  const allowedToolIds = new Set(sourceScope.tool_ids);
  if (sourceScope.allow_web) {
    allowedToolIds.add(GREENFIELD_WEB_JOB_TOOL_ID);
  }
  return rows.filter(
    (row) =>
      row.enabled &&
      allowedToolIds.has(row.tool_id) &&
      !MUTATING_JOB_TOOL_IDS.has(row.tool_id),
  );
}

async function listUserToolPermissionsForUserOnSql(
  sql: Sql,
  userId: string,
): Promise<UserToolPermission[]> {
  const existsRows = await sql<{ exists: boolean }[]>`
    select to_regclass('public.user_tool_permissions') is not null as exists
  `;
  if (existsRows[0]?.exists !== true) return [];
  const rows = await sql<UserToolPermissionRecord[]>`
    select user_id, tool_id, allowed, requires_approval, updated_at
    from public.user_tool_permissions
    where user_id = ${userId}::uuid
    order by tool_id asc
  `;
  return rows.map((row) => ({
    toolId: row.tool_id,
    allowed: row.allowed,
    requiresApproval: row.requires_approval,
  }));
}

function getMutatingJobToolId(sourceScope: {
  tool_ids: string[];
}): string | null {
  return (
    sourceScope.tool_ids.find((toolId) => MUTATING_JOB_TOOL_IDS.has(toolId)) ??
    null
  );
}

function assertReadOnlyJobToolScope(sourceScope: { tool_ids: string[] }): void {
  const toolId = getMutatingJobToolId(sourceScope);
  if (!toolId) return;
  throw new Error(`Tool ${toolId} is not available for read-only jobs.`);
}

async function getJobToolPermissionIssue(input: {
  sql: Sql;
  workspaceId: string;
  talkId: string;
  createdBy: string;
  sourceScope: { allow_web: boolean; tool_ids: string[] };
}): Promise<GreenfieldJobDependencyIssue | null> {
  const requiredToolIds = new Set(input.sourceScope.tool_ids);
  if (input.sourceScope.allow_web) {
    requiredToolIds.add(GREENFIELD_WEB_JOB_TOOL_ID);
  }
  if (requiredToolIds.size === 0) return null;

  const toolRows = await input.sql<TalkToolStateRow[]>`
    select tool_id, enabled
    from public.talk_tools
    where workspace_id = ${input.workspaceId}::uuid
      and talk_id = ${input.talkId}::uuid
  `;
  const scopedToolRows = filterTalkToolRowsForJobScope(
    toolRows,
    input.sourceScope,
  );
  const userToolPermissions = await listUserToolPermissionsForUserOnSql(
    input.sql,
    input.createdBy,
  );
  const enabledRuntimeTools = new Set(
    buildEffectiveToolsFromTalkToolRows(scopedToolRows, userToolPermissions)
      .filter((tool) => tool.enabled)
      .flatMap((tool) => tool.runtimeTools),
  );

  for (const toolId of requiredToolIds) {
    const runtimeTools = TALK_RUNTIME_TOOLS_BY_TOOL_ID[toolId] ?? [];
    const missingRuntimeTool = runtimeTools.find(
      (runtimeTool) => !enabledRuntimeTools.has(runtimeTool),
    );
    if (missingRuntimeTool) {
      return {
        code: 'tool_not_enabled',
        message: `Tool ${toolId} is disabled by the job creator's tool permissions.`,
      };
    }
  }
  return null;
}

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

function normalizeCatchUp(value: unknown): 'skip' | 'run_once' {
  return value === 'run_once' ? 'run_once' : 'skip';
}

const localDateFormatters = new Map<string, Intl.DateTimeFormat>();
const BUSY_JOB_RETRY_DELAY_MS = 2 * 60 * 1000;

function getLocalDateFormatter(timezone: string): Intl.DateTimeFormat {
  const existing = localDateFormatters.get(timezone);
  if (existing) return existing;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    calendar: 'iso8601',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  localDateFormatters.set(timezone, formatter);
  return formatter;
}

function getLocalDateParts(
  date: Date,
  timezone: string,
): GreenfieldJobLocalDateParts {
  const parts = getLocalDateFormatter(timezone).formatToParts(date);
  const get = (type: string): string =>
    parts.find((part) => part.type === type)?.value || '';
  const weekdayRaw = get('weekday').slice(0, 3).toLowerCase();
  const hour = Number.parseInt(get('hour'), 10);
  return {
    year: Number.parseInt(get('year'), 10),
    month: Number.parseInt(get('month'), 10),
    day: Number.parseInt(get('day'), 10),
    weekday:
      WEEKDAY_TO_NUMBER[weekdayRaw as GreenfieldJobWeekday] ??
      WEEKDAY_TO_NUMBER.sun,
    hour: hour === 24 ? 0 : hour,
    minute: Number.parseInt(get('minute'), 10),
  };
}

function getLocalDateKey(parts: GreenfieldJobLocalDateParts): string {
  return [
    parts.year.toString().padStart(4, '0'),
    parts.month.toString().padStart(2, '0'),
    parts.day.toString().padStart(2, '0'),
  ].join('-');
}

function getScheduleLocalSlotKey(
  schedule: Extract<StoredGreenfieldJobSchedule, { kind: 'daily' | 'weekly' }>,
  parts: GreenfieldJobLocalDateParts,
): string | null {
  if (
    schedule.kind === 'weekly' &&
    !schedule.weekdays.includes(parts.weekday)
  ) {
    return null;
  }
  if (parts.hour !== schedule.hour || parts.minute !== schedule.minute) {
    return null;
  }
  return `${getLocalDateKey(parts)}:${schedule.hour}:${schedule.minute}`;
}

function collectElapsedWallClockSlotKeys(input: {
  schedule: Extract<StoredGreenfieldJobSchedule, { kind: 'daily' | 'weekly' }>;
  timezone: string;
  through: Date;
}): Set<string> {
  const keys = new Set<string>();
  const endMs = input.through.getTime();
  const startMs = endMs - 36 * 60 * 60 * 1000;
  for (let ts = startMs; ts <= endMs; ts += 60_000) {
    const key = getScheduleLocalSlotKey(
      input.schedule,
      getLocalDateParts(new Date(ts), input.timezone),
    );
    if (key) keys.add(key);
  }
  return keys;
}

export function computeNextGreenfieldJobDueAt(input: {
  schedule: StoredGreenfieldJobSchedule;
  timezone: string;
  from?: string | Date;
}): string {
  const fromDate =
    input.from instanceof Date
      ? input.from
      : input.from
        ? new Date(input.from)
        : new Date();
  if (input.schedule.kind === 'interval') {
    return new Date(
      fromDate.getTime() + input.schedule.every_hours * 60 * 60 * 1000,
    ).toISOString();
  }

  const elapsedSlotKeys = collectElapsedWallClockSlotKeys({
    schedule: input.schedule,
    timezone: input.timezone,
    through: fromDate,
  });
  const startMs = fromDate.getTime() + 60_000;
  const endMs = startMs + 8 * 24 * 60 * 60 * 1000;
  for (let ts = startMs; ts <= endMs; ts += 60_000) {
    const parts = getLocalDateParts(new Date(ts), input.timezone);
    const slotKey = getScheduleLocalSlotKey(input.schedule, parts);
    if (slotKey && !elapsedSlotKeys.has(slotKey)) {
      return new Date(ts).toISOString();
    }
  }
  throw new Error('Could not compute next due time for schedule');
}

function computeNextGreenfieldJobDueAtAfter(input: {
  schedule: StoredGreenfieldJobSchedule;
  timezone: string;
  from: string | Date;
  after: string | Date;
}): string {
  if (input.schedule.kind === 'interval') {
    const fromDate =
      input.from instanceof Date ? input.from : new Date(input.from);
    const afterDate =
      input.after instanceof Date ? input.after : new Date(input.after);
    const intervalMs = input.schedule.every_hours * 60 * 60 * 1000;
    const steps = Math.floor(
      (afterDate.getTime() - fromDate.getTime()) / intervalMs,
    );
    return new Date(
      fromDate.getTime() + Math.max(steps + 1, 1) * intervalMs,
    ).toISOString();
  }

  const afterDate =
    input.after instanceof Date ? input.after : new Date(input.after);
  return computeNextGreenfieldJobDueAt({
    schedule: input.schedule,
    timezone: input.timezone,
    from: afterDate,
  });
}

function toJob(row: GreenfieldJobRow): GreenfieldJob {
  return {
    id: row.id,
    talkId: row.talk_id,
    ownerId: row.created_by,
    title: row.title,
    prompt: row.prompt,
    targetAgentId: row.agent_id,
    targetAgentNickname: row.agent_name,
    status: row.status,
    blockReason: row.block_reason,
    schedule: toApiSchedule(row.schedule_json),
    timezone: row.timezone,
    sourceScope: normalizeStoredScope(row.source_scope_json).api,
    threadId: row.talk_id,
    emitTalkMessage: row.emit_talk_message,
    emitDocumentAppend: row.emit_document_append,
    catchUp: row.catch_up,
    lastRunAt: row.last_run_at,
    lastRunStatus: row.last_run_status,
    nextDueAt: row.next_due_at,
    runCount: row.run_count,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
  };
}

const JOB_SELECT = `
  j.id,
  j.workspace_id,
  j.talk_id,
  j.created_by,
  j.title,
  j.prompt,
  j.agent_id,
  a.name as agent_name,
  j.status,
  j.block_reason,
  j.schedule_json,
  j.timezone,
  j.source_scope_json,
  j.emit_talk_message,
  j.emit_document_append,
  j.catch_up,
  j.next_due_at,
  j.last_run_at,
  j.last_run_status,
  j.run_count,
  j.archived_at,
  j.created_at,
  j.updated_at
`;

export async function listGreenfieldJobs(input: {
  workspaceId: string;
  talkId: string;
}): Promise<GreenfieldJob[]> {
  const db = getDbPg();
  const rows = await db<GreenfieldJobRow[]>`
    select ${db.unsafe(JOB_SELECT)}
    from public.jobs j
    left join public.agents a
      on a.workspace_id = j.workspace_id
     and a.id = j.agent_id
    where j.workspace_id = ${input.workspaceId}::uuid
      and j.talk_id = ${input.talkId}::uuid
      and j.archived_at is null
    order by
      case j.status when 'active' then 0 when 'paused' then 1 else 2 end asc,
      coalesce(j.next_due_at, j.updated_at) asc,
      j.created_at asc,
      j.id asc
  `;
  return rows.map(toJob);
}

export async function getGreenfieldJob(input: {
  workspaceId: string;
  talkId: string;
  jobId: string;
  includeArchived?: boolean;
}): Promise<GreenfieldJob | undefined> {
  const db = getDbPg();
  const rows = await db<GreenfieldJobRow[]>`
    select ${db.unsafe(JOB_SELECT)}
    from public.jobs j
    left join public.agents a
      on a.workspace_id = j.workspace_id
     and a.id = j.agent_id
    where j.workspace_id = ${input.workspaceId}::uuid
      and j.talk_id = ${input.talkId}::uuid
      and j.id = ${input.jobId}::uuid
      and (${input.includeArchived === true}::boolean or j.archived_at is null)
    limit 1
  `;
  return rows[0] ? toJob(rows[0]) : undefined;
}

async function getGreenfieldJobById(input: {
  workspaceId: string;
  jobId: string;
  includeArchived?: boolean;
}): Promise<GreenfieldJob | undefined> {
  const db = getDbPg();
  const rows = await db<GreenfieldJobRow[]>`
    select ${db.unsafe(JOB_SELECT)}
    from public.jobs j
    left join public.agents a
      on a.workspace_id = j.workspace_id
     and a.id = j.agent_id
    where j.workspace_id = ${input.workspaceId}::uuid
      and j.id = ${input.jobId}::uuid
      and (${input.includeArchived === true}::boolean or j.archived_at is null)
    limit 1
  `;
  return rows[0] ? toJob(rows[0]) : undefined;
}

async function loadRoster(input: {
  workspaceId: string;
  talkId: string;
  sql?: Sql;
}): Promise<GreenfieldJobRosterAgentRecord[]> {
  const db = input.sql ?? getDbPg();
  return await db<GreenfieldJobRosterAgentRecord[]>`
    select
      a.id,
      a.role_key,
      a.name,
      a.handle,
      a.initials,
      a.accent,
      a.accent_dark,
      a.model_id,
      lpm.provider_id,
      a.temperature,
      a.persona,
      a.focus,
      a.method,
      ta.sort_order,
      a.created_from_template_version,
      a.credential_mode
    from public.talk_agents ta
    join public.agents a
      on a.workspace_id = ta.workspace_id
     and a.id = ta.agent_id
    left join lateral (
      select lpm.provider_id
      from public.llm_provider_models lpm
      join public.llm_providers lp
        on lp.id = lpm.provider_id
       and lp.enabled = true
      where lpm.model_id = a.model_id
        and lpm.enabled = true
      order by lpm.provider_id asc
      limit 1
    ) lpm on true
    where ta.workspace_id = ${input.workspaceId}::uuid
      and ta.talk_id = ${input.talkId}::uuid
      and a.enabled = true
      and a.is_system = false
    order by ta.sort_order asc, a.name asc, a.id asc
  `;
}

function toCredentialSnapshotAgent(
  agent: GreenfieldJobRosterAgentRecord,
  ownerId: string,
): RegisteredAgentRecord {
  if (!agent.provider_id) {
    throw new Error(
      'Cannot snapshot credentials for an agent without provider',
    );
  }
  return {
    id: agent.id,
    owner_id: ownerId,
    name: agent.name,
    provider_id: agent.provider_id,
    model_id: agent.model_id,
    persona_role: agent.role_key,
    system_prompt: null,
    description: agent.focus,
    enabled: true,
    credential_mode: agent.credential_mode,
    model_auto_upgraded_from: null,
    model_auto_upgraded_at: null,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  };
}

async function getDependencyIssue(input: {
  workspaceId: string;
  talkId: string;
  createdBy: string;
  agentId: string | null;
  sourceScope: { allow_web: boolean; tool_ids: string[] };
  emitDocumentAppend: boolean;
  sql?: Sql;
}): Promise<GreenfieldJobDependencyIssue | null> {
  if (!input.agentId) {
    return {
      code: 'agent_missing',
      message: 'The selected Talk agent is no longer available on this talk.',
    };
  }
  const roster = await loadRoster(input);
  const target = roster.find((agent) => agent.id === input.agentId);
  if (!target) {
    return {
      code: 'agent_missing',
      message: 'The selected Talk agent is no longer available on this talk.',
    };
  }
  if (!target.provider_id) {
    return {
      code: 'model_disabled',
      message: 'The selected agent model or provider is not available.',
    };
  }
  const mutatingToolId = getMutatingJobToolId(input.sourceScope);
  if (mutatingToolId) {
    return {
      code: 'tool_not_enabled',
      message: `Tool ${mutatingToolId} is not available for read-only jobs.`,
    };
  }

  const db = input.sql ?? getDbPg();
  if (input.sourceScope.allow_web) {
    const webRows = await db<{ count: number }[]>`
      select count(*)::int as count
      from public.talk_tools
      where workspace_id = ${input.workspaceId}::uuid
        and talk_id = ${input.talkId}::uuid
        and tool_id = ${GREENFIELD_WEB_JOB_TOOL_ID}
        and enabled = true
    `;
    if ((webRows[0]?.count ?? 0) === 0) {
      return {
        code: 'tool_not_enabled',
        message: 'Web search is not enabled for this talk.',
      };
    }
  }

  if (input.emitDocumentAppend) {
    const docs = await db<{ id: string }[]>`
      select id
      from public.documents
      where workspace_id = ${input.workspaceId}::uuid
        and primary_talk_id = ${input.talkId}::uuid
      limit 1
    `;
    if (docs.length === 0) {
      return {
        code: 'no_primary_document',
        message: 'This job needs a primary document before it can run.',
      };
    }
  }

  for (const toolId of input.sourceScope.tool_ids) {
    const rows = await db<{ enabled: boolean }[]>`
      select enabled
      from public.talk_tools
      where workspace_id = ${input.workspaceId}::uuid
        and talk_id = ${input.talkId}::uuid
        and tool_id = ${toolId}
      limit 1
    `;
    if (!rows[0]?.enabled) {
      return {
        code: 'tool_not_enabled',
        message: `Tool ${toolId} is not enabled for this talk.`,
      };
    }
    const requiredService = REQUIRED_CONNECTOR_SERVICE_BY_TOOL_ID[toolId];
    if (requiredService) {
      const requiresGoogleToolCredential =
        GOOGLE_TOOL_CONNECTOR_SERVICES.has(requiredService);
      const connectorQuery = () => db<Array<{ id: string; scopes: unknown }>>`
        select id,
               coalesce(config_json->'scopes', '[]'::jsonb) as scopes
        from public.connectors
        where workspace_id = ${input.workspaceId}::uuid
          and service = ${requiredService}
          and authorized = true
          and (${requiresGoogleToolCredential}::boolean = false or (
            secret_ref is not null
            and config_json->>'compatSurface' = 'google_tools'
            and config_json->>'authorizedByUserId' = ${input.createdBy}
          ))
      `;
      // Google tool credentials are private to the authorizing user under RLS,
      // but job dependency checks are intentionally keyed to jobs.created_by.
      // After the route/accessor has established job edit/run access, perform
      // this existence-only read without the requester user's RLS visibility.
      const connectorRows = requiresGoogleToolCredential
        ? await withTrustedDbWrites(connectorQuery)
        : await connectorQuery();
      const connectors = requiresGoogleToolCredential
        ? connectorRows.filter((row) =>
            googleToolCredentialHasRequiredScopes({
              scopes: row.scopes,
              toolId,
            }),
          )
        : connectorRows;
      if (connectors.length === 0) {
        return {
          code: 'connector_not_authorized',
          message: `Connector ${requiredService} is not authorized for this workspace.`,
        };
      }
    }
  }

  const permissionIssue = await getJobToolPermissionIssue({
    sql: db,
    workspaceId: input.workspaceId,
    talkId: input.talkId,
    createdBy: input.createdBy,
    sourceScope: input.sourceScope,
  });
  if (permissionIssue) return permissionIssue;

  return null;
}

async function blockDueGreenfieldJobOnSql(input: {
  sql: Sql;
  workspaceId: string;
  talkId: string;
  jobId: string;
  jobTitle: string;
  issue: GreenfieldJobDependencyIssue;
}): Promise<void> {
  const title = `${input.jobTitle} is blocked`;
  const primaryAction = {
    type: 'open_talk_settings',
    talkId: input.talkId,
    jobId: input.jobId,
  };
  await markGreenfieldJobBlockedOnSql(input);
  await input.sql`
    insert into public.home_inbox_items (
      workspace_id,
      type,
      target_kind,
      target_json,
      talk_id,
      job_id,
      ref_id,
      severity,
      title,
      summary,
      reason,
      primary_action_json,
      group_key
    )
    values (
      ${input.workspaceId}::uuid,
      'job_blocked',
      'job',
      ${input.sql.json({
        jobId: input.jobId,
        talkId: input.talkId,
        blockReason: input.issue.code,
      } as never)},
      ${input.talkId}::uuid,
      ${input.jobId}::uuid,
      null,
      'blocking',
      ${title},
      ${input.issue.message},
      ${`block_reason=${input.issue.code}`},
      ${input.sql.json(primaryAction as never)},
      ${`job:${input.jobId}:blocked`}
    )
  `;
}

async function deferBusyGreenfieldJobOnSql(input: {
  sql: Sql;
  workspaceId: string;
  talkId: string;
  jobId: string;
  now: string;
}): Promise<void> {
  await withTrustedDbWrites(async () => {
    await input.sql`
      update public.jobs
      set claimed_at = ${input.now}::timestamptz,
          updated_at = now()
      where workspace_id = ${input.workspaceId}::uuid
        and talk_id = ${input.talkId}::uuid
        and id = ${input.jobId}::uuid
        and status = 'active'
        and archived_at is null
    `;
  });
}

async function deferFailedGreenfieldJobClaim(input: {
  sql: Sql;
  workspaceId: string;
  talkId: string;
  jobId: string;
  now: string;
}): Promise<void> {
  await deferBusyGreenfieldJobOnSql(input);
}

async function markGreenfieldJobBlockedOnSql(input: {
  sql: Sql;
  workspaceId: string;
  talkId: string;
  jobId: string;
  issue: GreenfieldJobDependencyIssue;
}): Promise<void> {
  await withTrustedDbWrites(async () => {
    await input.sql`
      update public.jobs
      set status = 'blocked',
          block_reason = ${input.issue.code},
          next_due_at = null,
          claimed_at = null,
          updated_at = now()
      where workspace_id = ${input.workspaceId}::uuid
        and talk_id = ${input.talkId}::uuid
        and id = ${input.jobId}::uuid
    `;
  });
}

export async function createGreenfieldJob(input: {
  workspaceId: string;
  talkId: string;
  title: string;
  prompt: string;
  agentId: string;
  schedule: unknown;
  timezone: string;
  sourceScope?: unknown;
  emitTalkMessage?: boolean;
  emitDocumentAppend?: boolean;
  catchUp?: unknown;
  createdBy: string;
}): Promise<GreenfieldJob> {
  const title = normalizeTitle(input.title);
  const prompt = normalizePrompt(input.prompt);
  const schedule = normalizeStoredSchedule(input.schedule);
  const timezone = validateTimezone(input.timezone);
  const normalizedScope = normalizeStoredScope(input.sourceScope);
  assertSupportedJobSourceScope(normalizedScope.api);
  const sourceScope = normalizedScope.stored;
  const emitTalkMessage = input.emitTalkMessage !== false;
  const emitDocumentAppend = input.emitDocumentAppend === true;
  assertReadOnlyJobToolScope(sourceScope);
  if (!emitTalkMessage && !emitDocumentAppend) {
    throw new Error('A job must emit a Talk message or a Document append');
  }
  const agentId = input.agentId.trim();
  if (!agentId) throw new Error('Job target agent is required');

  const issue = await getDependencyIssue({
    workspaceId: input.workspaceId,
    talkId: input.talkId,
    createdBy: input.createdBy,
    agentId,
    sourceScope,
    emitDocumentAppend,
  });
  if (issue) throw new Error(issue.message);

  const now = new Date().toISOString();
  const nextDueAt = computeNextGreenfieldJobDueAt({
    schedule,
    timezone,
    from: now,
  });
  const db = getDbPg();
  const rows = await withTrustedDbWrites(async () => {
    const inserted = await db<{ id: string }[]>`
      insert into public.jobs (
        workspace_id,
        talk_id,
        created_by,
        title,
        prompt,
        agent_id,
        schedule_json,
        timezone,
        emit_talk_message,
        emit_document_append,
        source_scope_json,
        catch_up,
        status,
        next_due_at,
        created_at,
        updated_at
      )
      values (
        ${input.workspaceId}::uuid,
        ${input.talkId}::uuid,
        ${input.createdBy}::uuid,
        ${title},
        ${prompt},
        ${agentId}::uuid,
        ${db.json(schedule as never)},
        ${timezone},
        ${emitTalkMessage},
        ${emitDocumentAppend},
        ${db.json(sourceScope as never)},
        ${normalizeCatchUp(input.catchUp)},
        'active',
        ${nextDueAt}::timestamptz,
        ${now}::timestamptz,
        ${now}::timestamptz
      )
      returning id
    `;
    await db`
      update public.talks
      set updated_at = now(), last_activity_at = now()
      where workspace_id = ${input.workspaceId}::uuid
        and id = ${input.talkId}::uuid
    `;
    return inserted;
  });
  return (await getGreenfieldJob({
    workspaceId: input.workspaceId,
    talkId: input.talkId,
    jobId: rows[0]!.id,
  }))!;
}

export async function patchGreenfieldJob(input: {
  workspaceId: string;
  talkId: string;
  jobId: string;
  title?: string;
  prompt?: string;
  agentId?: string;
  schedule?: unknown;
  timezone?: string;
  sourceScope?: unknown;
  emitTalkMessage?: boolean;
  emitDocumentAppend?: boolean;
  catchUp?: unknown;
}): Promise<GreenfieldJob | undefined> {
  const db = getDbPg();
  const patched = await withTrustedDbWrites(() =>
    withExistingOrNewTransaction(db, async (txSql) => {
      const currentRows = await txSql<GreenfieldJobRow[]>`
        select ${txSql.unsafe(JOB_SELECT)}
        from public.jobs j
        left join public.agents a
          on a.workspace_id = j.workspace_id
         and a.id = j.agent_id
        where j.workspace_id = ${input.workspaceId}::uuid
          and j.talk_id = ${input.talkId}::uuid
          and j.id = ${input.jobId}::uuid
          and j.archived_at is null
        limit 1
        for update of j
      `;
      const current = currentRows[0] ? toJob(currentRows[0]) : undefined;
      if (!current) return false;

      const title =
        input.title !== undefined ? normalizeTitle(input.title) : current.title;
      const prompt =
        input.prompt !== undefined
          ? normalizePrompt(input.prompt)
          : current.prompt;
      const agentId =
        input.agentId !== undefined
          ? input.agentId.trim()
          : current.targetAgentId;
      if (!agentId) throw new Error('Job target agent is required');
      const schedule =
        input.schedule !== undefined
          ? normalizeStoredSchedule(input.schedule)
          : normalizeStoredSchedule(current.schedule);
      const timezone =
        input.timezone !== undefined
          ? validateTimezone(input.timezone)
          : current.timezone;
      const sourceScope =
        input.sourceScope !== undefined
          ? normalizeStoredScope(
              mergeScopePatch(current.sourceScope, input.sourceScope),
            )
          : normalizeStoredScope(current.sourceScope);
      assertSupportedJobSourceScope(sourceScope.api);
      const storedSourceScope = sourceScope.stored;
      assertReadOnlyJobToolScope(storedSourceScope);
      const emitTalkMessage =
        input.emitTalkMessage !== undefined
          ? input.emitTalkMessage
          : current.emitTalkMessage;
      const emitDocumentAppend =
        input.emitDocumentAppend !== undefined
          ? input.emitDocumentAppend
          : current.emitDocumentAppend;
      if (!emitTalkMessage && !emitDocumentAppend) {
        throw new Error('A job must emit a Talk message or a Document append');
      }

      const issue = await getDependencyIssue({
        workspaceId: input.workspaceId,
        talkId: input.talkId,
        createdBy: current.createdBy,
        agentId,
        sourceScope: storedSourceScope,
        emitDocumentAppend,
        sql: txSql,
      });
      const nextDueAt =
        current.status === 'paused' || issue
          ? null
          : computeNextGreenfieldJobDueAt({ schedule, timezone });
      const status = issue
        ? 'blocked'
        : current.status === 'blocked'
          ? 'active'
          : current.status;

      const rows = await txSql<{ id: string }[]>`
        update public.jobs
        set title = ${title},
            prompt = ${prompt},
            agent_id = ${agentId}::uuid,
            schedule_json = ${txSql.json(schedule as never)},
            timezone = ${timezone},
            source_scope_json = ${txSql.json(storedSourceScope as never)},
            emit_talk_message = ${emitTalkMessage},
            emit_document_append = ${emitDocumentAppend},
            catch_up = ${normalizeCatchUp(input.catchUp ?? current.catchUp)},
            status = ${status},
            block_reason = ${issue?.code ?? null},
            next_due_at = ${nextDueAt}::timestamptz,
            claimed_at = null,
            updated_at = now()
        where workspace_id = ${input.workspaceId}::uuid
          and talk_id = ${input.talkId}::uuid
          and id = ${input.jobId}::uuid
          and archived_at is null
        returning id
      `;
      if (rows.length !== 1) return false;

      await txSql`
        update public.talks
        set updated_at = now(), last_activity_at = now()
        where workspace_id = ${input.workspaceId}::uuid
          and id = ${input.talkId}::uuid
      `;
      return true;
    }),
  );
  if (!patched) return undefined;
  return await getGreenfieldJob(input);
}

export async function archiveGreenfieldJob(input: {
  workspaceId: string;
  talkId: string;
  jobId: string;
}): Promise<boolean> {
  const db = getDbPg();
  const rows = await withTrustedDbWrites(
    () => db<{ id: string }[]>`
      update public.jobs
      set archived_at = now(),
          next_due_at = null,
          claimed_at = null,
          updated_at = now()
      where workspace_id = ${input.workspaceId}::uuid
        and talk_id = ${input.talkId}::uuid
        and id = ${input.jobId}::uuid
        and archived_at is null
      returning id
    `,
  );
  return rows.length === 1;
}

async function updateGreenfieldJobStatus(input: {
  workspaceId: string;
  talkId: string;
  jobId: string;
  status: 'active' | 'paused';
  nextDueAt: string | null;
}): Promise<GreenfieldJob | undefined> {
  const db = getDbPg();
  const rows = await withTrustedDbWrites(
    () => db<{ id: string }[]>`
      update public.jobs
      set status = ${input.status},
          block_reason = null,
          next_due_at = ${input.nextDueAt}::timestamptz,
          claimed_at = null,
          updated_at = now()
      where workspace_id = ${input.workspaceId}::uuid
        and talk_id = ${input.talkId}::uuid
        and id = ${input.jobId}::uuid
        and archived_at is null
      returning id
    `,
  );
  if (rows.length !== 1) return undefined;
  return await getGreenfieldJob(input);
}

async function blockGreenfieldJobForIssue(input: {
  workspaceId: string;
  talkId: string;
  jobId: string;
  issue: GreenfieldJobDependencyIssue;
}): Promise<GreenfieldJob | undefined> {
  const db = getDbPg();
  const rows = await withTrustedDbWrites(
    () => db<{ id: string }[]>`
      update public.jobs
      set status = 'blocked',
          block_reason = ${input.issue.code},
          next_due_at = null,
          claimed_at = null,
          updated_at = now()
      where workspace_id = ${input.workspaceId}::uuid
        and talk_id = ${input.talkId}::uuid
        and id = ${input.jobId}::uuid
        and archived_at is null
      returning id
    `,
  );
  if (rows.length !== 1) return undefined;
  return await getGreenfieldJob(input);
}

export async function pauseGreenfieldJob(input: {
  workspaceId: string;
  talkId: string;
  jobId: string;
}): Promise<GreenfieldJob | undefined> {
  const current = await getGreenfieldJob(input);
  if (!current || current.status === 'blocked') return current;
  return await updateGreenfieldJobStatus({
    ...input,
    status: 'paused',
    nextDueAt: null,
  });
}

export async function resumeGreenfieldJob(input: {
  workspaceId: string;
  talkId: string;
  jobId: string;
}): Promise<GreenfieldJob | undefined | { blocked: GreenfieldJob }> {
  const current = await getGreenfieldJob(input);
  if (!current) return undefined;
  if (current.status === 'blocked') return { blocked: current };
  const normalizedScope = normalizeStoredScope(current.sourceScope);
  const unsupportedIssue = unsupportedSourceScopeIssue(normalizedScope.api);
  if (unsupportedIssue) {
    const blocked = await blockGreenfieldJobForIssue({
      ...input,
      issue: unsupportedIssue,
    });
    if (!blocked) return undefined;
    return { blocked };
  }
  const sourceScope = normalizedScope.stored;
  const issue = await getDependencyIssue({
    workspaceId: input.workspaceId,
    talkId: input.talkId,
    createdBy: current.createdBy,
    agentId: current.targetAgentId,
    sourceScope,
    emitDocumentAppend: current.emitDocumentAppend,
  });
  if (issue) {
    const blocked = await blockGreenfieldJobForIssue({ ...input, issue });
    if (!blocked) return undefined;
    return { blocked };
  }
  const schedule = normalizeStoredSchedule(current.schedule);
  const nextDueAt = computeNextGreenfieldJobDueAt({
    schedule,
    timezone: current.timezone,
  });
  return await updateGreenfieldJobStatus({
    ...input,
    status: 'active',
    nextDueAt,
  });
}

function buildResponseExcerpt(content: string | null): string | null {
  if (!content) return null;
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return normalized.length <= 180
    ? normalized
    : `${normalized.slice(0, 179).trimEnd()}...`;
}

function parseRunError(input: {
  status: GreenfieldJobRunSummary['status'];
  error_json: unknown;
}): { errorCode: string | null; errorMessage: string | null } {
  if (!isRecord(input.error_json))
    return { errorCode: null, errorMessage: null };
  return {
    errorCode:
      typeof input.error_json.code === 'string' ? input.error_json.code : null,
    errorMessage:
      typeof input.error_json.message === 'string'
        ? input.error_json.message
        : null,
  };
}

export async function listGreenfieldJobRuns(input: {
  workspaceId: string;
  talkId: string;
  jobId: string;
  limit?: number;
}): Promise<GreenfieldJobRunSummary[]> {
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 20)));
  const db = getDbPg();
  const rows = await db<
    Array<{
      id: string;
      status:
        | 'queued'
        | 'running'
        | 'awaiting'
        | 'completed'
        | 'failed'
        | 'cancelled';
      created_at: string;
      started_at: string | null;
      finished_at: string | null;
      trigger_message_id: string | null;
      error_json: unknown;
      provider_id: string;
      model_id: string;
      agent_name: string | null;
      response_content: string | null;
    }>
  >`
    select
      r.id,
      r.status,
      r.created_at,
      r.started_at,
      r.finished_at,
      r.trigger_message_id,
      r.error_json,
      tas.provider_id,
      tas.model_id,
      tas.name as agent_name,
      (
        select m.body
        from public.messages m
        where m.workspace_id = r.workspace_id
          and m.run_id = r.id
          and m.author_kind = 'agent'
        order by m.created_at desc, m.id desc
        limit 1
      ) as response_content
    from public.runs r
    join public.talk_agent_snapshots tas
      on tas.workspace_id = r.workspace_id
     and tas.talk_id = r.talk_id
     and tas.id = r.agent_snapshot_id
    where r.workspace_id = ${input.workspaceId}::uuid
      and r.talk_id = ${input.talkId}::uuid
      and r.job_id = ${input.jobId}::uuid
    order by r.created_at desc, r.id desc
    limit ${limit}
  `;
  return rows.map((row) => {
    const parsedError = parseRunError({
      status: row.status === 'awaiting' ? 'awaiting_confirmation' : row.status,
      error_json: row.error_json,
    });
    return {
      id: row.id,
      threadId: input.talkId,
      status: row.status === 'awaiting' ? 'awaiting_confirmation' : row.status,
      createdAt: row.created_at,
      startedAt: row.started_at,
      completedAt: row.finished_at,
      triggerMessageId: row.trigger_message_id,
      responseExcerpt: buildResponseExcerpt(row.response_content),
      errorCode: parsedError.errorCode,
      errorMessage: parsedError.errorMessage,
      cancelReason: null,
      executorAlias: row.agent_name,
      executorModel: row.model_id,
      providerId: row.provider_id,
    };
  });
}

type ClaimDueGreenfieldJobRunResult =
  | { status: 'enqueued'; jobId: string; runId: string }
  | { status: 'blocked'; jobId: string }
  | { status: 'skipped'; jobId: string }
  | { status: 'busy'; jobId: string; advancedNextDueAt: boolean }
  | { status: 'not_claimed'; jobId: string };

type DueGreenfieldJobCandidate = {
  workspace_id: string;
  talk_id: string;
  id: string;
  next_due_at: string;
  created_at: string;
};

export async function claimDueGreenfieldJobRuns(input?: {
  limit?: number;
  now?: string | Date;
  ownerEmailPattern?: string;
  onEnqueuedRun?: (runId: string) => Promise<void> | void;
}): Promise<ClaimDueGreenfieldJobRunsResult> {
  const limit = Math.max(1, Math.min(100, Math.floor(input?.limit ?? 10)));
  const maxScannedCount = limit * 10;
  const now =
    input?.now instanceof Date
      ? input.now.toISOString()
      : (input?.now ?? new Date().toISOString());
  const busyRetryBefore = new Date(
    new Date(now).getTime() - BUSY_JOB_RETRY_DELAY_MS,
  ).toISOString();
  const db = getDbPg();
  const result: ClaimDueGreenfieldJobRunsResult = {
    enqueuedRunIds: [],
    blockedJobIds: [],
    skippedJobIds: [],
    busyJobIds: [],
    failedJobIds: [],
  };

  let handledCount = 0;
  let scannedCount = 0;
  const scannedJobIds = new Set<string>();
  while (handledCount < limit && scannedCount < maxScannedCount) {
    const remainingScanBudget = maxScannedCount - scannedCount;
    const dueJobs = await listDueGreenfieldJobCandidates({
      sql: db,
      now,
      busyRetryBefore,
      limit: Math.min(limit, remainingScanBudget),
      scannedJobIds: Array.from(scannedJobIds),
      ownerEmailPattern: input?.ownerEmailPattern ?? null,
    });
    if (dueJobs.length === 0) break;

    for (const job of dueJobs) {
      scannedCount += 1;
      scannedJobIds.add(job.id);

      let claim: ClaimDueGreenfieldJobRunResult;
      try {
        claim = await claimDueGreenfieldJobRun({
          workspaceId: job.workspace_id,
          talkId: job.talk_id,
          jobId: job.id,
          now,
          busyRetryBefore,
        });
      } catch (err) {
        result.failedJobIds.push(job.id);
        try {
          await deferFailedGreenfieldJobClaim({
            sql: db,
            workspaceId: job.workspace_id,
            talkId: job.talk_id,
            jobId: job.id,
            now,
          });
        } catch (deferErr) {
          logger.warn(
            {
              err: deferErr,
              workspaceId: job.workspace_id,
              talkId: job.talk_id,
              jobId: job.id,
            },
            'scheduler: failed to defer failed greenfield job claim',
          );
        }
        logger.error(
          {
            err,
            workspaceId: job.workspace_id,
            talkId: job.talk_id,
            jobId: job.id,
          },
          'scheduler: failed to claim greenfield due job',
        );
        continue;
      }

      if (claim.status === 'enqueued') {
        result.enqueuedRunIds.push(claim.runId);
        handledCount += 1;
        await input?.onEnqueuedRun?.(claim.runId);
      } else if (claim.status === 'blocked') {
        result.blockedJobIds.push(claim.jobId);
        handledCount += 1;
      } else if (claim.status === 'skipped') {
        result.skippedJobIds.push(claim.jobId);
        handledCount += 1;
      } else if (claim.status === 'busy') {
        result.busyJobIds.push(claim.jobId);
        if (claim.advancedNextDueAt) handledCount += 1;
      }

      if (handledCount >= limit || scannedCount >= maxScannedCount) break;
    }
  }
  return result;
}

async function listDueGreenfieldJobCandidates(input: {
  sql: Sql;
  now: string;
  busyRetryBefore: string;
  limit: number;
  scannedJobIds: string[];
  ownerEmailPattern: string | null;
}): Promise<DueGreenfieldJobCandidate[]> {
  const retryReadyLimit = Math.max(1, Math.floor(input.limit / 3));
  const unclaimedLimit = Math.max(1, input.limit - retryReadyLimit);
  const retryFirst = input.limit === 1;
  const unclaimedPriority = retryFirst ? 1 : 0;
  const retryReadyPriority = retryFirst ? 0 : 1;
  const candidatePageLimit = unclaimedLimit + retryReadyLimit;
  const ownerFilter = buildOwnerEmailWorkspaceFilter(
    input.sql,
    input.ownerEmailPattern,
    'jobs',
  );
  return input.sql<DueGreenfieldJobCandidate[]>`
    with unclaimed_due as (
      select
        j.workspace_id,
        j.talk_id,
        j.id,
        j.next_due_at,
        j.created_at,
        ${unclaimedPriority}::int as candidate_priority,
        null::timestamptz as retry_claimed_at
      from public.jobs j
      where j.status = 'active'
        and j.archived_at is null
        and j.next_due_at is not null
        and j.next_due_at <= ${input.now}::timestamptz
        and j.claimed_at is null
        and j.id <> all(${input.scannedJobIds}::uuid[])
        ${ownerFilter}
      order by j.next_due_at asc, j.created_at asc, j.id asc
      limit ${unclaimedLimit}
    ),
    retry_ready_due as (
      select
        j.workspace_id,
        j.talk_id,
        j.id,
        j.next_due_at,
        j.created_at,
        ${retryReadyPriority}::int as candidate_priority,
        j.claimed_at as retry_claimed_at
      from public.jobs j
      where j.status = 'active'
        and j.archived_at is null
        and j.next_due_at is not null
        and j.next_due_at <= ${input.now}::timestamptz
        and j.claimed_at < ${input.busyRetryBefore}::timestamptz
        and j.id <> all(${input.scannedJobIds}::uuid[])
        ${ownerFilter}
      order by j.claimed_at asc, j.next_due_at asc, j.created_at asc, j.id asc
      limit ${retryReadyLimit}
    ),
    candidates as (
      select * from unclaimed_due
      union all
      select * from retry_ready_due
    )
    select
      workspace_id,
      talk_id,
      id,
      next_due_at::text as next_due_at,
      created_at::text as created_at
    from candidates
    order by
      candidate_priority asc,
      retry_claimed_at asc nulls last,
      next_due_at asc,
      created_at asc,
      id asc
    limit ${candidatePageLimit}
  `;
}

async function claimDueGreenfieldJobRun(input: {
  workspaceId: string;
  talkId: string;
  jobId: string;
  now: string;
  busyRetryBefore: string;
}): Promise<ClaimDueGreenfieldJobRunResult> {
  const db = getDbPg();
  const runId = randomUUID();
  const promptSnapshotId = randomUUID();
  const snapshotGroupId = randomUUID();
  const responseGroupId = randomUUID();
  let pendingNotify: PendingOutboxNotify | null = null;

  const result = await db.begin(async (tx) => {
    const txSql = tx as unknown as Sql;
    const jobRows = await txSql<GreenfieldJobRow[]>`
      select ${txSql.unsafe(JOB_SELECT)}
      from public.jobs j
      left join public.agents a
        on a.workspace_id = j.workspace_id
       and a.id = j.agent_id
      where j.workspace_id = ${input.workspaceId}::uuid
        and j.talk_id = ${input.talkId}::uuid
        and j.id = ${input.jobId}::uuid
        and j.status = 'active'
        and j.archived_at is null
        and j.next_due_at is not null
        and j.next_due_at <= ${input.now}::timestamptz
        and (
          j.claimed_at is null
          or j.claimed_at < ${input.busyRetryBefore}::timestamptz
        )
      limit 1
      for update of j skip locked
    `;
    const lockedJob = jobRows[0] ? toJob(jobRows[0]) : undefined;
    if (!lockedJob?.nextDueAt) {
      return { status: 'not_claimed', jobId: input.jobId } as const;
    }

    let scheduleTiming: {
      scheduledFor: string;
      nextDueAt: string;
      missedAtLeastOneSlot: boolean;
    } | null = null;
    const getScheduleTiming = (): {
      scheduledFor: string;
      nextDueAt: string;
      missedAtLeastOneSlot: boolean;
    } => {
      if (scheduleTiming) return scheduleTiming;
      const schedule = normalizeStoredSchedule(lockedJob.schedule);
      const scheduledFor = lockedJob.nextDueAt!;
      const nextAfterSlot = computeNextGreenfieldJobDueAt({
        schedule,
        timezone: lockedJob.timezone,
        from: scheduledFor,
      });
      const missedAtLeastOneSlot =
        new Date(nextAfterSlot).getTime() <= new Date(input.now).getTime();
      const nextDueAt = missedAtLeastOneSlot
        ? computeNextGreenfieldJobDueAtAfter({
            schedule,
            timezone: lockedJob.timezone,
            from: scheduledFor,
            after: input.now,
          })
        : nextAfterSlot;
      scheduleTiming = { scheduledFor, nextDueAt, missedAtLeastOneSlot };
      return scheduleTiming;
    };

    const active = await txSql<{ count: number }[]>`
      select count(*)::int as count
      from public.runs
      where workspace_id = ${input.workspaceId}::uuid
        and job_id = ${input.jobId}::uuid
        and status in ('queued', 'running', 'awaiting')
    `;
    if ((active[0]?.count ?? 0) > 0) {
      if (lockedJob.catchUp === 'skip') {
        const { nextDueAt } = getScheduleTiming();
        await withTrustedDbWrites(async () => {
          await txSql`
            update public.jobs
            set next_due_at = ${nextDueAt}::timestamptz,
                claimed_at = null,
                updated_at = now()
            where workspace_id = ${input.workspaceId}::uuid
              and talk_id = ${input.talkId}::uuid
              and id = ${input.jobId}::uuid
          `;
        });
      } else {
        await deferBusyGreenfieldJobOnSql({ ...input, sql: txSql });
      }
      return {
        status: 'busy',
        jobId: input.jobId,
        advancedNextDueAt: lockedJob.catchUp === 'skip',
      } as const;
    }

    const lockedTalkRows = await txSql<{ id: string }[]>`
      select id
      from public.talks
      where workspace_id = ${input.workspaceId}::uuid
        and id = ${input.talkId}::uuid
      limit 1
      for update skip locked
    `;
    if (lockedTalkRows.length !== 1) {
      await deferBusyGreenfieldJobOnSql({ ...input, sql: txSql });
      return {
        status: 'busy',
        jobId: input.jobId,
        advancedNextDueAt: false,
      } as const;
    }

    const activeTalkRuns = await txSql<{ count: number }[]>`
      select count(*)::int as count
      from public.runs
      where workspace_id = ${input.workspaceId}::uuid
        and talk_id = ${input.talkId}::uuid
        and status in ('queued', 'running', 'awaiting')
    `;
    if ((activeTalkRuns[0]?.count ?? 0) > 0) {
      await deferBusyGreenfieldJobOnSql({ ...input, sql: txSql });
      return {
        status: 'busy',
        jobId: input.jobId,
        advancedNextDueAt: false,
      } as const;
    }

    const { scheduledFor, nextDueAt, missedAtLeastOneSlot } =
      getScheduleTiming();
    if (lockedJob.catchUp === 'skip' && missedAtLeastOneSlot) {
      await withTrustedDbWrites(async () => {
        await txSql`
          update public.jobs
          set next_due_at = ${nextDueAt}::timestamptz,
              claimed_at = null,
              updated_at = now()
          where workspace_id = ${input.workspaceId}::uuid
            and talk_id = ${input.talkId}::uuid
            and id = ${input.jobId}::uuid
        `;
      });
      return { status: 'skipped', jobId: input.jobId } as const;
    }

    const lockedScope = normalizeStoredScope(lockedJob.sourceScope);
    const unsupportedScopeIssue = unsupportedSourceScopeIssue(lockedScope.api);
    if (unsupportedScopeIssue) {
      await blockDueGreenfieldJobOnSql({
        sql: txSql,
        workspaceId: input.workspaceId,
        talkId: input.talkId,
        jobId: input.jobId,
        jobTitle: lockedJob.title,
        issue: unsupportedScopeIssue,
      });
      return { status: 'blocked', jobId: input.jobId } as const;
    }

    const lockedSourceScope = lockedScope.stored;
    const lockedIssue = await getDependencyIssue({
      workspaceId: input.workspaceId,
      talkId: input.talkId,
      createdBy: lockedJob.createdBy,
      agentId: lockedJob.targetAgentId,
      sourceScope: lockedSourceScope,
      emitDocumentAppend: lockedJob.emitDocumentAppend,
      sql: txSql,
    });
    if (lockedIssue) {
      await blockDueGreenfieldJobOnSql({
        sql: txSql,
        workspaceId: input.workspaceId,
        talkId: input.talkId,
        jobId: input.jobId,
        jobTitle: lockedJob.title,
        issue: lockedIssue,
      });
      return { status: 'blocked', jobId: input.jobId } as const;
    }

    const roster = await loadRoster({ ...input, sql: txSql });
    const target = roster.find((agent) => agent.id === lockedJob.targetAgentId);
    if (!target || !target.provider_id) {
      const targetIssue: GreenfieldJobDependencyIssue = {
        code: target ? 'model_disabled' : 'agent_missing',
        message: target
          ? 'The selected agent model or provider is not available.'
          : 'The selected Talk agent is no longer available on this talk.',
      };
      await blockDueGreenfieldJobOnSql({
        sql: txSql,
        workspaceId: input.workspaceId,
        talkId: input.talkId,
        jobId: input.jobId,
        jobTitle: lockedJob.title,
        issue: targetIssue,
      });
      return { status: 'blocked', jobId: input.jobId } as const;
    }

    const rounds = await txSql<{ round: number }[]>`
      select greatest(
        coalesce((
          select max(round)
          from public.messages
          where workspace_id = ${input.workspaceId}::uuid
            and talk_id = ${input.talkId}::uuid
        ), 0),
        coalesce((
          select max(round)
          from public.runs
          where workspace_id = ${input.workspaceId}::uuid
            and talk_id = ${input.talkId}::uuid
        ), 0)
      ) + 1 as round
    `;
    const round = rounds[0]?.round ?? 1;
    const toolRows = await txSql<TalkToolStateRow[]>`
      select tool_id, enabled
      from public.talk_tools
      where workspace_id = ${input.workspaceId}::uuid
        and talk_id = ${input.talkId}::uuid
    `;
    const scopedToolRows = filterTalkToolRowsForJobScope(
      toolRows,
      lockedSourceScope,
    );
    const userToolPermissions = await listUserToolPermissionsForUserOnSql(
      txSql,
      lockedJob.createdBy,
    );
    const toolManifest = {
      active: normalizeTalkToolFamiliesFromRows(scopedToolRows),
      effectiveTools: buildEffectiveToolsFromTalkToolRows(
        scopedToolRows,
        userToolPermissions,
      ),
      jobSourceScope: lockedSourceScope,
    };
    const credentialKindSnapshot = await resolveCredentialKindSnapshot(
      toCredentialSnapshotAgent(target, lockedJob.createdBy),
      {
        principalUserId: lockedJob.createdBy,
        workspaceId: input.workspaceId,
      },
      txSql,
    );

    await withTrustedDbWrites(async () => {
      const snapshotIds = new Map<string, string>();
      for (const agent of roster) {
        if (!agent.provider_id) continue;
        const snapshotId = randomUUID();
        snapshotIds.set(agent.id, snapshotId);
        await txSql`
        insert into public.talk_agent_snapshots (
          id,
          workspace_id,
          talk_id,
          snapshot_group_id,
          source_agent_id,
          role_key,
          name,
          handle,
          initials,
          accent,
          accent_dark,
          provider_id,
          model_id,
          temperature,
          persona,
          focus,
          method,
          sort_order,
          role_template_version
        )
        values (
          ${snapshotId}::uuid,
          ${input.workspaceId}::uuid,
          ${input.talkId}::uuid,
          ${snapshotGroupId}::uuid,
          ${agent.id}::uuid,
          ${agent.role_key},
          ${agent.name},
          ${agent.handle},
          ${agent.initials},
          ${agent.accent},
          ${agent.accent_dark},
          ${agent.provider_id},
          ${agent.model_id},
          ${agent.temperature},
          ${agent.persona},
          ${agent.focus},
          ${agent.method},
          ${agent.sort_order},
          ${agent.created_from_template_version}
        )
      `;
      }
      const targetSnapshotId = snapshotIds.get(target.id);
      if (!targetSnapshotId) throw new Error('target_snapshot_missing');
      await txSql`
      insert into public.runs (
        id,
        workspace_id,
        talk_id,
        round,
        snapshot_group_id,
        agent_snapshot_id,
        status,
        model_id,
        requested_by,
        trigger_message_id,
        job_id,
        trigger,
        scheduled_for,
        response_group_id,
        sequence_index,
        prompt_snapshot_id
      )
      values (
        ${runId}::uuid,
        ${input.workspaceId}::uuid,
        ${input.talkId}::uuid,
        ${round},
        ${snapshotGroupId}::uuid,
        ${targetSnapshotId}::uuid,
        'queued',
        ${target.model_id},
        ${lockedJob.createdBy}::uuid,
        null,
        ${input.jobId}::uuid,
        'scheduler',
        ${scheduledFor}::timestamptz,
        ${responseGroupId},
        0,
        ${promptSnapshotId}::uuid
      )
    `;
      await txSql`
      insert into public.run_prompt_snapshots (
        id,
        workspace_id,
        run_id,
        talk_id,
        agent_snapshot_id,
        model_id,
        provider,
        role_template_version,
        prompt_assembly_version,
        tool_manifest_json,
        prompt_text_redacted
      )
      values (
        ${promptSnapshotId}::uuid,
        ${input.workspaceId}::uuid,
        ${runId}::uuid,
        ${input.talkId}::uuid,
        ${targetSnapshotId}::uuid,
        ${target.model_id},
        ${target.provider_id},
        ${target.created_from_template_version},
        1,
        ${txSql.json({
          ...toolManifest,
          agentCredentialMode: credentialKindSnapshot,
          jobOutputTargets: {
            emitTalkMessage: lockedJob.emitTalkMessage,
            emitDocumentAppend: lockedJob.emitDocumentAppend,
          },
        } as never)},
        ${lockedJob.prompt}
      )
    `;
    });
    await withTrustedDbWrites(async () => {
      await txSql`
        update public.jobs
        set next_due_at = ${nextDueAt}::timestamptz,
            claimed_at = null,
            updated_at = now()
        where workspace_id = ${input.workspaceId}::uuid
          and talk_id = ${input.talkId}::uuid
          and id = ${input.jobId}::uuid
      `;
    });
    await txSql`
      update public.talks
      set last_activity_at = now()
      where workspace_id = ${input.workspaceId}::uuid
        and id = ${input.talkId}::uuid
    `;
    const ownerIds = await listWorkspaceNotifyOwnerIdsOnSql({
      sql: txSql,
      workspaceId: input.workspaceId,
      fallbackUserId: lockedJob.createdBy,
    });
    const eventId = await emitOutboxEventOnSql(txSql, {
      topic: `talk:${input.talkId}`,
      eventType: 'talk_run_queued',
      payload: {
        talkId: input.talkId,
        runId,
        runKind: 'conversation',
        triggerMessageId: null,
        targetAgentId: target.id,
        targetAgentNickname: target.name,
        responseGroupId,
        sequenceIndex: 0,
        status: 'queued',
        executorAlias: target.name,
        executorModel: target.model_id,
        providerId: target.provider_id,
        jobId: input.jobId,
      },
      ownerIds,
    });
    pendingNotify = {
      topic: `talk:${input.talkId}`,
      eventId,
      ownerIds,
    };

    return { status: 'enqueued', jobId: input.jobId, runId } as const;
  });
  if (pendingNotify) enqueueOutboxNotify(pendingNotify);
  return result;
}

export async function createGreenfieldJobRunNow(input: {
  workspaceId: string;
  talkId: string;
  jobId: string;
  requestedBy: string;
}): Promise<CreateGreenfieldJobRunNowResult> {
  const current = await getGreenfieldJob({
    workspaceId: input.workspaceId,
    talkId: input.talkId,
    jobId: input.jobId,
  });
  if (!current) return { status: 'not_found' };
  if (current.createdBy !== input.requestedBy) {
    return { status: 'forbidden', job: current };
  }
  if (current.archivedAt) return { status: 'archived', job: current };
  if (current.status === 'blocked') {
    return {
      status: 'blocked',
      job: current,
      issue: {
        code:
          (current.blockReason as GreenfieldJobDependencyIssue['code']) ??
          'agent_missing',
        message: 'The job is blocked and must be fixed before it can run.',
      },
    };
  }

  const db = getDbPg();
  const runId = randomUUID();
  const promptSnapshotId = randomUUID();
  const snapshotGroupId = randomUUID();
  const responseGroupId = randomUUID();
  let pendingNotify: PendingOutboxNotify | null = null;

  const result = await withTrustedDbWrites(() =>
    withExistingOrNewTransaction(db, async (txSql) => {
      await txSql`
      select pg_advisory_xact_lock(
        hashtextextended(
          ${`greenfield-job-run-now:${input.workspaceId}:${input.jobId}`},
          0
        )
      )
    `;
      const jobRows = await txSql<GreenfieldJobRow[]>`
      select ${txSql.unsafe(JOB_SELECT)}
      from public.jobs j
      left join public.agents a
        on a.workspace_id = j.workspace_id
       and a.id = j.agent_id
      where j.workspace_id = ${input.workspaceId}::uuid
        and j.talk_id = ${input.talkId}::uuid
        and j.id = ${input.jobId}::uuid
      limit 1
      for update of j
    `;
      const lockedJob = jobRows[0] ? toJob(jobRows[0]) : undefined;
      if (!lockedJob) return { status: 'not_found' } as const;
      if (lockedJob.archivedAt) {
        return { status: 'archived', job: lockedJob } as const;
      }
      if (lockedJob.status === 'blocked') {
        return {
          status: 'blocked',
          job: lockedJob,
          issue: {
            code:
              (lockedJob.blockReason as GreenfieldJobDependencyIssue['code']) ??
              'agent_missing',
            message: 'The job is blocked and must be fixed before it can run.',
          },
        } as const;
      }

      const lockedScope = normalizeStoredScope(lockedJob.sourceScope);
      const unsupportedScopeIssue = unsupportedSourceScopeIssue(
        lockedScope.api,
      );
      if (unsupportedScopeIssue) {
        await markGreenfieldJobBlockedOnSql({
          sql: txSql,
          workspaceId: input.workspaceId,
          talkId: input.talkId,
          jobId: input.jobId,
          issue: unsupportedScopeIssue,
        });
        return {
          status: 'blocked',
          job: {
            ...lockedJob,
            status: 'blocked',
            blockReason: unsupportedScopeIssue.code,
            nextDueAt: null,
          },
          issue: unsupportedScopeIssue,
        } as const;
      }
      const lockedSourceScope = lockedScope.stored;
      const lockedIssue = await getDependencyIssue({
        workspaceId: input.workspaceId,
        talkId: input.talkId,
        createdBy: lockedJob.createdBy,
        agentId: lockedJob.targetAgentId,
        sourceScope: lockedSourceScope,
        emitDocumentAppend: lockedJob.emitDocumentAppend,
        sql: txSql,
      });
      if (lockedIssue) {
        await markGreenfieldJobBlockedOnSql({
          sql: txSql,
          workspaceId: input.workspaceId,
          talkId: input.talkId,
          jobId: input.jobId,
          issue: lockedIssue,
        });
        return {
          status: 'blocked',
          job: {
            ...lockedJob,
            status: 'blocked',
            blockReason: lockedIssue.code,
            nextDueAt: null,
          },
          issue: lockedIssue,
        } as const;
      }

      await txSql`
      select 1
      from public.talks
      where workspace_id = ${input.workspaceId}::uuid
        and id = ${input.talkId}::uuid
      for update
    `;

      const active = await txSql<{ count: number }[]>`
      select count(*)::int as count
      from public.runs
      where workspace_id = ${input.workspaceId}::uuid
        and job_id = ${input.jobId}::uuid
        and status in ('queued', 'running', 'awaiting')
    `;
      if ((active[0]?.count ?? 0) > 0) {
        return { status: 'job_busy', job: lockedJob } as const;
      }
      const activeTalkRuns = await txSql<{ count: number }[]>`
      select count(*)::int as count
      from public.runs
      where workspace_id = ${input.workspaceId}::uuid
        and talk_id = ${input.talkId}::uuid
        and status in ('queued', 'running', 'awaiting')
    `;
      if ((activeTalkRuns[0]?.count ?? 0) > 0) {
        return { status: 'talk_busy', job: lockedJob } as const;
      }

      const roster = await loadRoster({ ...input, sql: txSql });
      const target = roster.find(
        (agent) => agent.id === lockedJob.targetAgentId,
      );
      if (!target || !target.provider_id) {
        const targetIssue: GreenfieldJobDependencyIssue = {
          code: target ? 'model_disabled' : 'agent_missing',
          message: target
            ? 'The selected agent model or provider is not available.'
            : 'The selected Talk agent is no longer available on this talk.',
        };
        await markGreenfieldJobBlockedOnSql({
          sql: txSql,
          workspaceId: input.workspaceId,
          talkId: input.talkId,
          jobId: input.jobId,
          issue: targetIssue,
        });
        return {
          status: 'blocked',
          job: {
            ...lockedJob,
            status: 'blocked',
            blockReason: targetIssue.code,
            nextDueAt: null,
          },
          issue: targetIssue,
        } as const;
      }

      const rounds = await txSql<{ round: number }[]>`
      select greatest(
        coalesce((
          select max(round)
          from public.messages
          where workspace_id = ${input.workspaceId}::uuid
            and talk_id = ${input.talkId}::uuid
        ), 0),
        coalesce((
          select max(round)
          from public.runs
          where workspace_id = ${input.workspaceId}::uuid
            and talk_id = ${input.talkId}::uuid
        ), 0)
      ) + 1 as round
    `;
      const round = rounds[0]?.round ?? 1;
      const toolRows = await txSql<TalkToolStateRow[]>`
      select tool_id, enabled
      from public.talk_tools
      where workspace_id = ${input.workspaceId}::uuid
        and talk_id = ${input.talkId}::uuid
    `;
      const scopedToolRows = filterTalkToolRowsForJobScope(
        toolRows,
        lockedSourceScope,
      );
      const executionUserId = lockedJob.createdBy;
      const userToolPermissions = await listUserToolPermissionsForUserOnSql(
        txSql,
        executionUserId,
      );
      const toolManifest = {
        active: normalizeTalkToolFamiliesFromRows(scopedToolRows),
        effectiveTools: buildEffectiveToolsFromTalkToolRows(
          scopedToolRows,
          userToolPermissions,
        ),
        jobSourceScope: lockedSourceScope,
      };
      const credentialKindSnapshot = await resolveCredentialKindSnapshot(
        toCredentialSnapshotAgent(target, executionUserId),
        {
          principalUserId: executionUserId,
          workspaceId: input.workspaceId,
        },
        txSql,
      );

      await withTrustedDbWrites(async () => {
        const snapshotIds = new Map<string, string>();
        for (const agent of roster) {
          if (!agent.provider_id) continue;
          const snapshotId = randomUUID();
          snapshotIds.set(agent.id, snapshotId);
          await txSql`
        insert into public.talk_agent_snapshots (
          id,
          workspace_id,
          talk_id,
          snapshot_group_id,
          source_agent_id,
          role_key,
          name,
          handle,
          initials,
          accent,
          accent_dark,
          provider_id,
          model_id,
          temperature,
          persona,
          focus,
          method,
          sort_order,
          role_template_version
        )
        values (
          ${snapshotId}::uuid,
          ${input.workspaceId}::uuid,
          ${input.talkId}::uuid,
          ${snapshotGroupId}::uuid,
          ${agent.id}::uuid,
          ${agent.role_key},
          ${agent.name},
          ${agent.handle},
          ${agent.initials},
          ${agent.accent},
          ${agent.accent_dark},
          ${agent.provider_id},
          ${agent.model_id},
          ${agent.temperature},
          ${agent.persona},
          ${agent.focus},
          ${agent.method},
          ${agent.sort_order},
          ${agent.created_from_template_version}
        )
      `;
        }
        const targetSnapshotId = snapshotIds.get(target.id);
        if (!targetSnapshotId) throw new Error('target_snapshot_missing');
        await txSql`
      insert into public.runs (
        id,
        workspace_id,
        talk_id,
        round,
        snapshot_group_id,
        agent_snapshot_id,
        status,
        model_id,
        requested_by,
        trigger_message_id,
        job_id,
        trigger,
        scheduled_for,
        response_group_id,
        sequence_index,
        prompt_snapshot_id
      )
      values (
        ${runId}::uuid,
        ${input.workspaceId}::uuid,
        ${input.talkId}::uuid,
        ${round},
        ${snapshotGroupId}::uuid,
        ${targetSnapshotId}::uuid,
        'queued',
        ${target.model_id},
        ${executionUserId}::uuid,
        null,
        ${input.jobId}::uuid,
        'manual',
        null,
        ${responseGroupId},
        0,
        ${promptSnapshotId}::uuid
      )
    `;
        await txSql`
      insert into public.run_prompt_snapshots (
        id,
        workspace_id,
        run_id,
        talk_id,
        agent_snapshot_id,
        model_id,
        provider,
        role_template_version,
        prompt_assembly_version,
        tool_manifest_json,
        prompt_text_redacted
      )
      values (
        ${promptSnapshotId}::uuid,
        ${input.workspaceId}::uuid,
        ${runId}::uuid,
        ${input.talkId}::uuid,
        ${targetSnapshotId}::uuid,
        ${target.model_id},
        ${target.provider_id},
        ${target.created_from_template_version},
        1,
        ${txSql.json({
          ...toolManifest,
          agentCredentialMode: credentialKindSnapshot,
          jobOutputTargets: {
            emitTalkMessage: lockedJob.emitTalkMessage,
            emitDocumentAppend: lockedJob.emitDocumentAppend,
          },
        } as never)},
        ${lockedJob.prompt}
      )
    `;
      });
      await txSql`
      update public.talks
      set last_activity_at = now()
      where workspace_id = ${input.workspaceId}::uuid
        and id = ${input.talkId}::uuid
    `;
      const ownerIds = await listWorkspaceNotifyOwnerIdsOnSql({
        sql: txSql,
        workspaceId: input.workspaceId,
        fallbackUserId: input.requestedBy,
      });
      const eventId = await emitOutboxEventOnSql(txSql, {
        topic: `talk:${input.talkId}`,
        eventType: 'talk_run_queued',
        payload: {
          talkId: input.talkId,
          runId,
          runKind: 'conversation',
          triggerMessageId: null,
          targetAgentId: target.id,
          targetAgentNickname: target.name,
          responseGroupId,
          sequenceIndex: 0,
          status: 'queued',
          executorAlias: target.name,
          executorModel: target.model_id,
          providerId: target.provider_id,
          jobId: input.jobId,
        },
        ownerIds,
      });
      pendingNotify = {
        topic: `talk:${input.talkId}`,
        eventId,
        ownerIds,
      };

      return { status: 'enqueued', job: lockedJob, runId } as const;
    }),
  );
  if (pendingNotify) enqueueOutboxNotify(pendingNotify);
  if (result.status !== 'enqueued') return result;

  const job = (await getGreenfieldJob(input)) ?? result.job;
  return { status: 'enqueued', job, runId: result.runId };
}
