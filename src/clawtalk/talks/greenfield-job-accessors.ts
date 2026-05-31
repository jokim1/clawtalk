import { randomUUID } from 'node:crypto';

import { getDbPg, type Sql } from '../../db.js';
import {
  buildEffectiveToolsFromTalkToolRows,
  listUserToolPermissionsForUser,
  normalizeTalkToolFamiliesFromRows,
  TALK_TOOL_IDS_BY_FAMILY,
} from '../db/agent-accessors.js';
import { emitOutboxEventOnSql, enqueueOutboxNotify } from './outbox-emit.js';

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
  connectorIds: string[];
  channelBindingIds: string[];
  toolIds: string[];
  allowWeb: boolean;
}

type StoredGreenfieldJobScope = {
  allow_web?: unknown;
  allowWeb?: unknown;
  tool_ids?: unknown;
  toolIds?: unknown;
  connector_ids?: unknown;
  connectorIds?: unknown;
  channel_binding_ids?: unknown;
  channelBindingIds?: unknown;
};

type TalkToolStateRow = { tool_id: string; enabled: boolean };

interface PendingOutboxNotify {
  topic: string;
  eventId: number;
  ownerIds: string[];
}

const REQUIRED_CONNECTOR_SERVICE_BY_TOOL_ID: Record<string, string> = {
  linear: 'linear',
  'github-read': 'github',
  'notion-read': 'notion',
  'gdrive-read': 'gdrive',
  'gdrive-write': 'gdrive',
  'gmail-read': 'gmail',
  'gmail-send': 'gmail',
  messaging: 'slack',
};

const MUTATING_JOB_TOOL_IDS = new Set([
  'gdrive-write',
  'gmail-send',
  'messaging',
]);

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
  | { status: 'archived'; job: GreenfieldJob }
  | {
      status: 'blocked';
      job: GreenfieldJob;
      issue: GreenfieldJobDependencyIssue;
    }
  | { status: 'job_busy'; job: GreenfieldJob }
  | { status: 'talk_busy'; job: GreenfieldJob };

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
    connectorIds: normalizeStringList(
      source.connector_ids ?? source.connectorIds,
    ),
    channelBindingIds: normalizeStringList(
      source.channel_binding_ids ?? source.channelBindingIds,
    ),
    toolIds,
    allowWeb: source.allow_web === true || source.allowWeb === true,
  };
  return {
    stored: { allow_web: api.allowWeb, tool_ids: toolIds },
    api,
  };
}

function unsupportedSourceScopeIssue(
  sourceScope: GreenfieldJobScope,
): GreenfieldJobDependencyIssue | null {
  if (sourceScope.connectorIds.length > 0) {
    return {
      code: 'tool_not_enabled',
      message:
        'Connector-id scoped job sources are not supported by the greenfield jobs runtime yet.',
    };
  }
  if (sourceScope.channelBindingIds.length > 0) {
    return {
      code: 'tool_not_enabled',
      message:
        'Channel-binding scoped job sources are not supported by the greenfield jobs runtime yet.',
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
    for (const toolId of TALK_TOOL_IDS_BY_FAMILY.web ?? []) {
      allowedToolIds.add(toolId);
    }
  }
  return rows.filter(
    (row) =>
      row.enabled &&
      allowedToolIds.has(row.tool_id) &&
      !MUTATING_JOB_TOOL_IDS.has(row.tool_id),
  );
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

function getLocalDateParts(
  date: Date,
  timezone: string,
): { weekday: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type: string): string =>
    parts.find((part) => part.type === type)?.value || '';
  const weekdayRaw = get('weekday').slice(0, 3).toLowerCase();
  return {
    weekday:
      WEEKDAY_TO_NUMBER[weekdayRaw as GreenfieldJobWeekday] ??
      WEEKDAY_TO_NUMBER.sun,
    hour: Number.parseInt(get('hour'), 10),
    minute: Number.parseInt(get('minute'), 10),
  };
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

  const startMs = fromDate.getTime() + 60_000;
  const weekdays =
    input.schedule.kind === 'daily'
      ? new Set([0, 1, 2, 3, 4, 5, 6])
      : new Set(input.schedule.weekdays);
  const endMs = startMs + 8 * 24 * 60 * 60 * 1000;
  for (let ts = startMs; ts <= endMs; ts += 60_000) {
    const parts = getLocalDateParts(new Date(ts), input.timezone);
    if (
      weekdays.has(parts.weekday) &&
      parts.hour === input.schedule.hour &&
      parts.minute === input.schedule.minute
    ) {
      return new Date(ts).toISOString();
    }
  }
  throw new Error('Could not compute next due time for schedule');
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
      a.created_from_template_version
    from public.talk_agents ta
    join public.agents a
      on a.workspace_id = ta.workspace_id
     and a.id = ta.agent_id
    left join lateral (
      select provider_id
      from public.llm_provider_models
      where model_id = a.model_id
        and enabled = true
      order by provider_id asc
      limit 1
    ) lpm on true
    where ta.workspace_id = ${input.workspaceId}::uuid
      and ta.talk_id = ${input.talkId}::uuid
      and a.enabled = true
      and a.is_system = false
    order by ta.sort_order asc, a.name asc, a.id asc
  `;
}

async function getDependencyIssue(input: {
  workspaceId: string;
  talkId: string;
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
      message: 'The selected agent model is not available.',
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
    const webToolIds = TALK_TOOL_IDS_BY_FAMILY.web ?? [];
    const webRows = await db<{ count: number }[]>`
      select count(*)::int as count
      from public.talk_tools
      where workspace_id = ${input.workspaceId}::uuid
        and talk_id = ${input.talkId}::uuid
        and tool_id in ${db(webToolIds)}
        and enabled = true
    `;
    if ((webRows[0]?.count ?? 0) === 0) {
      return {
        code: 'tool_not_enabled',
        message: 'Web tools are not enabled for this talk.',
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
      const connectors = await db<{ id: string }[]>`
        select id
        from public.connectors
        where workspace_id = ${input.workspaceId}::uuid
          and service = ${requiredService}
          and authorized = true
        limit 1
      `;
      if (connectors.length === 0) {
        return {
          code: 'connector_not_authorized',
          message: `Connector ${requiredService} is not authorized for this workspace.`,
        };
      }
    }
  }
  return null;
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
  if (emitDocumentAppend) {
    throw new Error('Document append job output is not enabled yet');
  }
  if (!emitTalkMessage && !emitDocumentAppend) {
    throw new Error('A job must emit a Talk message or a Document append');
  }
  const agentId = input.agentId.trim();
  if (!agentId) throw new Error('Job target agent is required');

  const issue = await getDependencyIssue({
    workspaceId: input.workspaceId,
    talkId: input.talkId,
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
  const rows = await db<{ id: string }[]>`
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
  const current = await getGreenfieldJob(input);
  if (!current) return undefined;

  const title =
    input.title !== undefined ? normalizeTitle(input.title) : current.title;
  const prompt =
    input.prompt !== undefined ? normalizePrompt(input.prompt) : current.prompt;
  const agentId =
    input.agentId !== undefined ? input.agentId.trim() : current.targetAgentId;
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
      ? normalizeStoredScope(input.sourceScope)
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
  if (emitDocumentAppend) {
    throw new Error('Document append job output is not enabled yet');
  }
  if (!emitTalkMessage && !emitDocumentAppend) {
    throw new Error('A job must emit a Talk message or a Document append');
  }

  const issue = await getDependencyIssue({
    workspaceId: input.workspaceId,
    talkId: input.talkId,
    agentId,
    sourceScope: storedSourceScope,
    emitDocumentAppend,
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

  const db = getDbPg();
  await db`
    update public.jobs
    set title = ${title},
        prompt = ${prompt},
        agent_id = ${agentId}::uuid,
        schedule_json = ${db.json(schedule as never)},
        timezone = ${timezone},
        source_scope_json = ${db.json(storedSourceScope as never)},
        emit_talk_message = ${emitTalkMessage},
        emit_document_append = ${emitDocumentAppend},
        catch_up = ${normalizeCatchUp(input.catchUp ?? current.catchUp)},
        status = ${status},
        block_reason = ${issue?.code ?? null},
        next_due_at = ${nextDueAt}::timestamptz,
        updated_at = now()
    where workspace_id = ${input.workspaceId}::uuid
      and talk_id = ${input.talkId}::uuid
      and id = ${input.jobId}::uuid
      and archived_at is null
  `;
  await db`
    update public.talks
    set updated_at = now(), last_activity_at = now()
    where workspace_id = ${input.workspaceId}::uuid
      and id = ${input.talkId}::uuid
  `;
  return await getGreenfieldJob(input);
}

export async function archiveGreenfieldJob(input: {
  workspaceId: string;
  talkId: string;
  jobId: string;
}): Promise<boolean> {
  const db = getDbPg();
  const rows = await db<{ id: string }[]>`
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
  `;
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
  const rows = await db<{ id: string }[]>`
    update public.jobs
    set status = ${input.status},
        block_reason = null,
        next_due_at = ${input.nextDueAt}::timestamptz,
        updated_at = now()
    where workspace_id = ${input.workspaceId}::uuid
      and talk_id = ${input.talkId}::uuid
      and id = ${input.jobId}::uuid
      and archived_at is null
    returning id
  `;
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
  const rows = await db<{ id: string }[]>`
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
  `;
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
      r.model_id,
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
    };
  });
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
  const userToolPermissions = await listUserToolPermissionsForUser(
    input.requestedBy,
  );
  let pendingNotify: PendingOutboxNotify | null = null;

  const result = await withExistingOrNewTransaction(db, async (txSql) => {
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
    const unsupportedScopeIssue = unsupportedSourceScopeIssue(lockedScope.api);
    if (unsupportedScopeIssue) {
      await txSql`
        update public.jobs
        set status = 'blocked',
            block_reason = ${unsupportedScopeIssue.code},
            next_due_at = null,
            updated_at = now()
        where workspace_id = ${input.workspaceId}::uuid
          and talk_id = ${input.talkId}::uuid
          and id = ${input.jobId}::uuid
      `;
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
      agentId: lockedJob.targetAgentId,
      sourceScope: lockedSourceScope,
      emitDocumentAppend: lockedJob.emitDocumentAppend,
      sql: txSql,
    });
    if (lockedIssue) {
      await txSql`
        update public.jobs
        set status = 'blocked',
            block_reason = ${lockedIssue.code},
            next_due_at = null,
            updated_at = now()
        where workspace_id = ${input.workspaceId}::uuid
          and talk_id = ${input.talkId}::uuid
          and id = ${input.jobId}::uuid
      `;
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
    const target = roster.find((agent) => agent.id === lockedJob.targetAgentId);
    if (!target || !target.provider_id) {
      const targetIssue: GreenfieldJobDependencyIssue = {
        code: target ? 'model_disabled' : 'agent_missing',
        message: target
          ? 'The selected agent model is not available.'
          : 'The selected Talk agent is no longer available on this talk.',
      };
      await txSql`
        update public.jobs
        set status = 'blocked',
            block_reason = ${targetIssue.code},
            next_due_at = null,
            updated_at = now()
        where workspace_id = ${input.workspaceId}::uuid
          and talk_id = ${input.talkId}::uuid
          and id = ${input.jobId}::uuid
      `;
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
    const toolManifest = {
      active: normalizeTalkToolFamiliesFromRows(scopedToolRows),
      effectiveTools: buildEffectiveToolsFromTalkToolRows(
        scopedToolRows,
        userToolPermissions,
      ),
      jobSourceScope: lockedSourceScope,
    };

    const snapshotIds = new Map<string, string>();
    for (const agent of roster) {
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
    const targetSnapshotId = snapshotIds.get(target.id)!;
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
        ${input.requestedBy}::uuid,
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
        ${txSql.json(toolManifest as never)},
        ${lockedJob.prompt}
      )
    `;
    await txSql`
      update public.talks
      set last_activity_at = now()
      where workspace_id = ${input.workspaceId}::uuid
        and id = ${input.talkId}::uuid
    `;
    const eventId = await emitOutboxEventOnSql(txSql, {
      topic: `talk:${input.talkId}`,
      eventType: 'talk_run_queued',
      payload: {
        talkId: input.talkId,
        threadId: input.talkId,
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
        jobId: input.jobId,
      },
      ownerIds: [input.requestedBy],
    });
    pendingNotify = {
      topic: `talk:${input.talkId}`,
      eventId,
      ownerIds: [input.requestedBy],
    };

    return { status: 'enqueued', job: lockedJob, runId } as const;
  });
  if (pendingNotify) enqueueOutboxNotify(pendingNotify);
  if (result.status !== 'enqueued') return result;

  const job = (await getGreenfieldJob(input)) ?? result.job;
  return { status: 'enqueued', job, runId: result.runId };
}
