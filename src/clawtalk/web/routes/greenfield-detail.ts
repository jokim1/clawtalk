import { getDbPg, withUserContext } from '../../../db.js';
import {
  getGreenfieldDocumentForTalk,
  getGreenfieldRunContextSnapshotRecord,
  getGreenfieldThreadMetrics,
  getTalkSnapshotVersion,
  listGreenfieldMessages,
  listGreenfieldRuns,
  searchGreenfieldMessages,
  deleteGreenfieldMessages,
  listPendingGreenfieldDocumentEdits,
  type GreenfieldDocumentBlockRecord,
  type GreenfieldDocumentEditRecord,
  type GreenfieldDocumentRecord,
  type GreenfieldMessageRecord,
  type GreenfieldRunContextSnapshotRecord,
  type GreenfieldRunRecord,
  type GreenfieldThreadMetrics,
} from '../../talks/greenfield-detail-accessors.js';
import type { TalkRunContextSnapshot } from '../../talks/talk-run-context-snapshot.js';
import {
  getGreenfieldTalk,
  listGreenfieldTalkAgents,
  type GreenfieldTalkAgentRecord,
  type GreenfieldTalkRecord,
} from '../../talks/greenfield-accessors.js';
import {
  resolveWorkspaceForUser,
  type WorkspaceSummaryRecord,
} from '../../workspaces/accessors.js';
import { ensureWorkspaceBootstrapForUser } from '../../workspaces/bootstrap.js';
import type { ApiEnvelope, AuthContext } from '../types.js';

type RouteResult<T> = {
  statusCode: number;
  body: ApiEnvelope<T>;
};

type WorkspaceContext = {
  workspace: WorkspaceSummaryRecord;
};

type WorkspaceResolutionScope = {
  talkId?: string | null;
  contentId?: string | null;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function ok<T>(data: T, statusCode = 200): RouteResult<T> {
  return { statusCode, body: { ok: true, data } };
}

function error(
  statusCode: number,
  code: string,
  message: string,
  details?: unknown,
): RouteResult<never> {
  return {
    statusCode,
    body: { ok: false, error: { code, message, details } },
  };
}

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function failure<T>(result: RouteResult<T>): RouteResult<never> {
  if (result.body.ok) {
    throw new Error('Expected failed route result');
  }
  return error(
    result.statusCode,
    result.body.error.code,
    result.body.error.message,
    result.body.error.details,
  );
}

function requireWorkspaceWriter(
  workspace: WorkspaceSummaryRecord,
): RouteResult<never> | null {
  if (workspace.role !== 'guest') return null;
  return error(
    403,
    'workspace_writer_required',
    'Workspace write access is required.',
  );
}

async function withResolvedWorkspace<T>(
  auth: AuthContext,
  requestedWorkspaceId: string | null | undefined,
  scope: WorkspaceResolutionScope | null,
  fn: (ctx: WorkspaceContext) => Promise<RouteResult<T>>,
): Promise<RouteResult<T>> {
  if (scope?.talkId && !isUuid(scope.talkId)) {
    return error(400, 'invalid_talk_id', 'Talk id must be a UUID.');
  }
  if (scope?.contentId && !isUuid(scope.contentId)) {
    return error(400, 'invalid_content_id', 'Content id must be a UUID.');
  }

  try {
    await ensureWorkspaceBootstrapForUser(auth.userId);
  } catch {
    return error(401, 'unauthorized', 'Session is not active.');
  }

  return withUserContext(auth.userId, async () => {
    const scopedWorkspaceId =
      requestedWorkspaceId ??
      (await findVisibleWorkspaceIdForScope({
        userId: auth.userId,
        scope,
      }));
    const workspace = await resolveWorkspaceForUser({
      userId: auth.userId,
      requestedWorkspaceId: scopedWorkspaceId,
    });
    if (!workspace) {
      return error(
        scopedWorkspaceId ? 403 : 404,
        scopedWorkspaceId ? 'workspace_forbidden' : 'workspace_not_found',
        scopedWorkspaceId
          ? 'Workspace is not available to this user.'
          : 'No workspace exists for this user.',
      );
    }
    return fn({ workspace });
  });
}

async function findVisibleWorkspaceIdForScope(input: {
  userId: string;
  scope: WorkspaceResolutionScope | null;
}): Promise<string | undefined> {
  if (!input.scope) return undefined;
  const db = getDbPg();
  if (input.scope.talkId) {
    const rows = await db<{ workspace_id: string }[]>`
      select t.workspace_id
      from public.talks t
      join public.workspace_members wm
        on wm.workspace_id = t.workspace_id
       and wm.user_id = ${input.userId}::uuid
      where t.id = ${input.scope.talkId}::uuid
      limit 1
    `;
    return rows[0]?.workspace_id;
  }
  if (input.scope.contentId) {
    const rows = await db<{ workspace_id: string }[]>`
      select d.workspace_id
      from public.documents d
      join public.workspace_members wm
        on wm.workspace_id = d.workspace_id
       and wm.user_id = ${input.userId}::uuid
      where d.id = ${input.scope.contentId}::uuid
      limit 1
    `;
    return rows[0]?.workspace_id;
  }
  return undefined;
}

function syntheticThreadId(talkId: string): string {
  return talkId;
}

function assertSyntheticThread(input: {
  talkId: string;
  threadId?: string | null;
}): RouteResult<never> | null {
  if (!input.threadId || input.threadId === syntheticThreadId(input.talkId)) {
    return null;
  }
  return error(404, 'thread_not_found', 'Thread not found.');
}

function toThreadApi(
  talk: GreenfieldTalkRecord,
  metrics: GreenfieldThreadMetrics,
): {
  id: string;
  talk_id: string;
  title: string | null;
  is_default: number;
  is_pinned: number;
  created_at: string;
  updated_at: string;
  message_count: number;
  last_message_at: string | null;
} {
  return {
    id: syntheticThreadId(talk.id),
    talk_id: talk.id,
    title: metrics.title,
    is_default: 1,
    is_pinned: 1,
    created_at: metrics.created_at,
    updated_at: metrics.updated_at,
    message_count: metrics.message_count,
    last_message_at: metrics.last_message_at,
  };
}

function toSnapshotThreadApi(
  talk: GreenfieldTalkRecord,
  metrics: GreenfieldThreadMetrics,
): {
  id: string;
  talkId: string;
  title: string | null;
  isDefault: boolean;
  isInternal: boolean;
  isPinned: boolean;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessageAt: string | null;
} {
  return {
    id: syntheticThreadId(talk.id),
    talkId: talk.id,
    title: metrics.title,
    isDefault: true,
    isInternal: false,
    isPinned: true,
    createdAt: metrics.created_at,
    updatedAt: metrics.updated_at,
    messageCount: metrics.message_count,
    lastMessageAt: metrics.last_message_at,
  };
}

function toMessageApi(message: GreenfieldMessageRecord): {
  id: string;
  threadId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  createdBy: string | null;
  createdAt: string;
  runId: string | null;
  agentId: string | null;
  agentNickname: string | null;
  metadata: Record<string, unknown> | null;
  attachments: Array<{
    id: string;
    fileName: string;
    fileSize: number;
    mimeType: string;
    extractionStatus: 'pending' | 'ready' | 'failed';
  }>;
} {
  return {
    id: message.id,
    threadId: syntheticThreadId(message.talk_id),
    role: message.author_kind === 'agent' ? 'assistant' : 'user',
    content: message.body ?? '',
    createdBy: message.author_user_id,
    createdAt: message.created_at,
    runId: message.run_id,
    agentId: message.agent_id,
    agentNickname: message.agent_name,
    metadata: {
      round: message.round,
      authorKind: message.author_kind,
      agentRole: message.agent_role_key,
    },
    attachments: [],
  };
}

function toSearchResult(message: GreenfieldMessageRecord): {
  messageId: string;
  threadId: string;
  threadTitle: string | null;
  role: 'user' | 'assistant' | 'system' | 'tool';
  createdAt: string;
  preview: string;
} {
  const apiMessage = toMessageApi(message);
  return {
    messageId: message.id,
    threadId: apiMessage.threadId,
    threadTitle: null,
    role: apiMessage.role,
    createdAt: message.created_at,
    preview: (message.body ?? '').replace(/\s+/g, ' ').slice(0, 240),
  };
}

function mapRunStatus(
  status: GreenfieldRunRecord['status'],
):
  | 'queued'
  | 'running'
  | 'awaiting_confirmation'
  | 'cancelled'
  | 'completed'
  | 'failed' {
  return status === 'awaiting' ? 'awaiting_confirmation' : status;
}

function toRunApi(run: GreenfieldRunRecord): {
  id: string;
  threadId: string;
  responseGroupId: string | null;
  sequenceIndex: number | null;
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
  targetAgentId: string | null;
  targetAgentNickname: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  cancelReason: string | null;
  executorAlias: string | null;
  executorModel: string | null;
  providerId: string | null;
} {
  const errorInfo =
    run.error_json && typeof run.error_json === 'object'
      ? (run.error_json as Record<string, unknown>)
      : null;
  return {
    id: run.id,
    threadId: syntheticThreadId(run.talk_id),
    responseGroupId: run.response_group_id,
    sequenceIndex: run.sequence_index,
    status: mapRunStatus(run.status),
    createdAt: run.created_at,
    startedAt: run.started_at,
    completedAt: run.finished_at,
    triggerMessageId: run.trigger_message_id,
    targetAgentId: run.target_agent_id,
    targetAgentNickname: run.target_agent_name,
    errorCode:
      errorInfo && typeof errorInfo.code === 'string' ? errorInfo.code : null,
    errorMessage:
      errorInfo && typeof errorInfo.message === 'string'
        ? errorInfo.message
        : null,
    cancelReason: null,
    executorAlias: run.target_agent_name,
    executorModel: run.model_id,
    providerId: run.provider_id,
  };
}

function toSnapshotRunApi(run: GreenfieldRunRecord): {
  id: string;
  threadId: string;
  status: ReturnType<typeof mapRunStatus>;
  responseGroupId: string | null;
  sequenceIndex: number | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  triggerMessageId: string | null;
  targetAgentId: string | null;
  executorAlias: string | null;
  executorModel: string | null;
  providerId: string | null;
} {
  return {
    id: run.id,
    threadId: syntheticThreadId(run.talk_id),
    status: mapRunStatus(run.status),
    responseGroupId: run.response_group_id,
    sequenceIndex: run.sequence_index,
    createdAt: run.created_at,
    startedAt: run.started_at,
    endedAt: run.finished_at,
    triggerMessageId: run.trigger_message_id,
    targetAgentId: run.target_agent_id,
    executorAlias: run.target_agent_name,
    executorModel: run.model_id,
    providerId: run.provider_id,
  };
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toPersonaRole(
  roleKey: string | null,
): TalkRunContextSnapshot['personaRole'] {
  switch (roleKey) {
    case 'assistant':
    case 'analyst':
    case 'critic':
    case 'strategist':
    case 'devils-advocate':
    case 'synthesizer':
    case 'editor':
      return roleKey;
    case 'researcher':
    case 'quant':
      return 'analyst';
    default:
      return null;
  }
}

function parsePersistedRunContextSnapshot(
  value: unknown,
): TalkRunContextSnapshot | null {
  const record = recordOf(value);
  const candidate = recordOf(record?.contextSnapshot) ?? record;
  if (candidate?.version !== 1) return null;
  return candidate as unknown as TalkRunContextSnapshot;
}

function enabledRuntimeToolNames(value: unknown): string[] {
  const manifest = recordOf(value);
  const effectiveTools = manifest?.effectiveTools;
  if (!Array.isArray(effectiveTools)) return [];
  const names = new Set<string>();
  for (const entry of effectiveTools) {
    const tool = recordOf(entry);
    if (tool?.enabled !== true || !Array.isArray(tool.runtimeTools)) continue;
    for (const name of tool.runtimeTools) {
      if (typeof name === 'string' && name.trim()) names.add(name.trim());
    }
  }
  return Array.from(names).sort();
}

function toRunContextSnapshot(
  record: GreenfieldRunContextSnapshotRecord,
): TalkRunContextSnapshot {
  const persisted = parsePersistedRunContextSnapshot(
    record.context_manifest_json,
  );
  if (persisted) return persisted;

  const promptChars = record.prompt_text_redacted?.length ?? 0;
  return {
    version: 1,
    threadId: syntheticThreadId(record.talk_id),
    personaRole: toPersonaRole(record.role_key),
    roleHint: null,
    goalIncluded: false,
    summaryIncluded: false,
    activeRules: [],
    stateSnapshot: {
      totalCount: 0,
      omittedCount: 0,
      included: [],
    },
    sources: {
      totalCount: 0,
      manifest: [],
      inline: [],
      forcedInjection: {
        refs: [],
        slugs: [],
        bytes: 0,
      },
    },
    retrieval: {
      query: null,
      queryTerms: [],
      roleTerms: [],
      state: [],
      sources: [],
    },
    tools: {
      contextToolNames: enabledRuntimeToolNames(record.tool_manifest_json),
      connectorToolNames: [],
    },
    history: {
      messageIds: record.trigger_message_id ? [record.trigger_message_id] : [],
      turnCount: Math.max(0, record.round),
    },
    estimatedTokens: Math.ceil(promptChars / 4),
  };
}

function blockToMarkdown(block: GreenfieldDocumentBlockRecord): string {
  if (block.kind === 'h1') return `# ${block.text}`;
  if (block.kind === 'h2') return `## ${block.text}`;
  if (block.kind === 'li') return `- ${block.text}`;
  if (block.kind === 'code') return `\`\`\`\n${block.text}\n\`\`\``;
  return block.text;
}

function renderDocumentMarkdown(document: GreenfieldDocumentRecord): string {
  return document.blocks.map(blockToMarkdown).join('\n\n');
}

function toContentApi(document: GreenfieldDocumentRecord): {
  id: string;
  ownerId: string;
  talkId: string;
  threadId: string;
  title: string;
  contentKind: string;
  contentFormat: 'markdown' | 'html';
  bodyMarkdown: string;
  bodyHtml: string | null;
  bodyVersion: number;
  anchorMap: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  updatedByRunId: string | null;
} {
  const bodyMarkdown = renderDocumentMarkdown(document);
  return {
    id: document.id,
    ownerId: document.owner_id ?? '',
    talkId: document.primary_talk_id ?? '',
    threadId: document.primary_talk_id
      ? syntheticThreadId(document.primary_talk_id)
      : document.tab_id,
    title: document.title,
    contentKind: 'document',
    contentFormat: document.format,
    bodyMarkdown,
    bodyHtml: document.format === 'html' ? bodyMarkdown : null,
    bodyVersion: document.list_version,
    anchorMap: Object.fromEntries(
      document.blocks.map((block) => [
        block.id,
        {
          kind: block.kind,
          sortOrder: block.sort_order,
          preview: block.text.slice(0, 140),
          version: block.version,
        },
      ]),
    ),
    createdAt: document.created_at,
    updatedAt: document.updated_at,
    createdByUserId: document.created_by_user_id ?? document.owner_id,
    updatedByUserId: document.updated_by_user_id,
    updatedByRunId: document.updated_by_run_id,
  };
}

function toPendingEditApi(edit: GreenfieldDocumentEditRecord): {
  id: string;
  contentId: string;
  runId: string;
  agentId: string | null;
  agentNickname: string | null;
  messageId: string | null;
  kind: 'insert' | 'replace' | 'delete' | 'bulk';
  baseContentVersion: number;
  targetAnchorId: string | null;
  newMarkdown: string | null;
  rationale: string | null;
  createdAt: string;
} {
  return {
    id: edit.id,
    contentId: edit.document_id,
    runId: edit.proposed_by_run_id ?? '',
    agentId: edit.proposed_by_agent_id,
    agentNickname: edit.proposed_by_agent_name,
    messageId: null,
    kind: edit.op,
    baseContentVersion: edit.base_list_version ?? edit.base_block_version ?? 1,
    targetAnchorId: edit.op === 'insert' ? edit.after_block_id : edit.block_id,
    newMarkdown: edit.new_text,
    rationale: null,
    createdAt: edit.created_at,
  };
}

type SnapshotAccessRole = 'owner' | 'admin' | 'editor' | 'viewer';

function snapshotAccessRole(input: {
  talk: GreenfieldTalkRecord;
  workspace: WorkspaceSummaryRecord;
  userId: string;
}): SnapshotAccessRole {
  if (input.workspace.role === 'guest') return 'viewer';
  if (input.talk.created_by === input.userId) return 'owner';
  if (input.workspace.role === 'owner' || input.workspace.role === 'admin') {
    return 'admin';
  }
  return 'editor';
}

function toSnapshotTalk(input: {
  talk: GreenfieldTalkRecord;
  workspace: WorkspaceSummaryRecord;
  userId: string;
}): {
  id: string;
  workspaceId: string;
  ownerId: string;
  folderId: string | null;
  sortOrder: number;
  title: string | null;
  orchestrationMode: 'ordered' | 'panel';
  status: 'active' | 'paused' | 'archived';
  version: number;
  createdAt: string;
  updatedAt: string;
  accessRole: SnapshotAccessRole;
} {
  const { talk } = input;
  return {
    id: talk.id,
    workspaceId: input.workspace.id,
    ownerId: talk.created_by,
    folderId: talk.folder_id,
    sortOrder: talk.sort_order,
    title: talk.title,
    orchestrationMode: talk.mode === 'parallel' ? 'panel' : 'ordered',
    status: talk.archived_at ? 'archived' : 'active',
    version: 1,
    createdAt: talk.created_at,
    updatedAt: talk.updated_at,
    accessRole: snapshotAccessRole(input),
  };
}

function toSnapshotAgent(agent: GreenfieldTalkAgentRecord): {
  assignmentId: string;
  agentId: string;
  agentName: string;
  nickname: string;
  personaRole: string | null;
  isPrimary: boolean;
  sortOrder: number;
} {
  return {
    assignmentId: agent.id,
    agentId: agent.id,
    agentName: agent.name,
    nickname: agent.name,
    personaRole: agent.role_key,
    isPrimary: agent.sort_order === 0,
    sortOrder: agent.sort_order,
  };
}

async function loadTalkOr404(input: {
  workspaceId: string;
  talkId: string;
}): Promise<GreenfieldTalkRecord | RouteResult<never>> {
  if (!isUuid(input.talkId)) {
    return error(400, 'invalid_talk_id', 'Talk id must be a UUID.');
  }
  const talk = await getGreenfieldTalk(input);
  return talk ?? error(404, 'talk_not_found', 'Talk not found.');
}

export async function listGreenfieldMessagesRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
  threadId?: string | null;
  beforeCreatedAt?: string;
  limit?: number;
}): Promise<
  RouteResult<{
    talkId: string;
    messages: ReturnType<typeof toMessageApi>[];
    page: { limit: number; count: number; beforeCreatedAt: string | null };
  }>
> {
  const threadError = assertSyntheticThread({
    talkId: input.talkId,
    threadId: input.threadId,
  });
  if (threadError) return threadError;
  return withResolvedWorkspace(
    input.auth,
    input.workspaceId,
    { talkId: input.talkId },
    async (ctx) => {
      const talk = await loadTalkOr404({
        workspaceId: ctx.workspace.id,
        talkId: input.talkId,
      });
      if ('statusCode' in talk) return talk;
      const limit = Math.min(Math.max(input.limit ?? 200, 1), 500);
      const messages = await listGreenfieldMessages({
        workspaceId: ctx.workspace.id,
        talkId: input.talkId,
        beforeCreatedAt: input.beforeCreatedAt,
        limit,
      });
      return ok({
        talkId: input.talkId,
        messages: messages.map(toMessageApi),
        page: {
          limit,
          count: messages.length,
          beforeCreatedAt: input.beforeCreatedAt ?? null,
        },
      });
    },
  );
}

export async function searchGreenfieldMessagesRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
  query: string;
  limit?: number;
}): Promise<
  RouteResult<{
    talkId: string;
    query: string;
    results: ReturnType<typeof toSearchResult>[];
  }>
> {
  return withResolvedWorkspace(
    input.auth,
    input.workspaceId,
    { talkId: input.talkId },
    async (ctx) => {
      const talk = await loadTalkOr404({
        workspaceId: ctx.workspace.id,
        talkId: input.talkId,
      });
      if ('statusCode' in talk) return talk;
      const query = input.query.trim();
      if (!query) return ok({ talkId: input.talkId, query, results: [] });
      const messages = await searchGreenfieldMessages({
        workspaceId: ctx.workspace.id,
        talkId: input.talkId,
        query,
        limit: input.limit,
      });
      return ok({
        talkId: input.talkId,
        query,
        results: messages.map(toSearchResult),
      });
    },
  );
}

export async function deleteGreenfieldMessagesRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
  messageIds: unknown;
}): Promise<
  RouteResult<{
    talkId: string;
    deletedCount: number;
    deletedMessageIds: string[];
  }>
> {
  return withResolvedWorkspace(
    input.auth,
    input.workspaceId,
    { talkId: input.talkId },
    async (ctx) => {
      const talk = await loadTalkOr404({
        workspaceId: ctx.workspace.id,
        talkId: input.talkId,
      });
      if ('statusCode' in talk) return talk;
      const writerError = requireWorkspaceWriter(ctx.workspace);
      if (writerError) return writerError;
      if (
        !Array.isArray(input.messageIds) ||
        input.messageIds.length === 0 ||
        input.messageIds.some((messageId) => typeof messageId !== 'string')
      ) {
        return error(
          400,
          'invalid_message_id',
          'Message ids must be a non-empty array of UUID strings.',
        );
      }
      if (!input.messageIds.every(isUuid)) {
        return error(400, 'invalid_message_id', 'Message ids must be UUIDs.');
      }
      const deletedIds = await deleteGreenfieldMessages({
        workspaceId: ctx.workspace.id,
        talkId: input.talkId,
        messageIds: input.messageIds,
      });
      return ok({
        talkId: input.talkId,
        deletedCount: deletedIds.length,
        deletedMessageIds: deletedIds,
      });
    },
  );
}

export async function listGreenfieldThreadsRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
}): Promise<RouteResult<{ threads: ReturnType<typeof toThreadApi>[] }>> {
  return withResolvedWorkspace(
    input.auth,
    input.workspaceId,
    { talkId: input.talkId },
    async (ctx) => {
      const talk = await loadTalkOr404({
        workspaceId: ctx.workspace.id,
        talkId: input.talkId,
      });
      if ('statusCode' in talk) return talk;
      const metrics = await getGreenfieldThreadMetrics({
        workspaceId: ctx.workspace.id,
        talkId: input.talkId,
      });
      if (!metrics) return error(404, 'talk_not_found', 'Talk not found.');
      return ok({ threads: [toThreadApi(talk, metrics)] });
    },
  );
}

export async function createGreenfieldThreadRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
}): Promise<RouteResult<{ thread: ReturnType<typeof toThreadApi> }>> {
  return withResolvedWorkspace(
    input.auth,
    input.workspaceId,
    { talkId: input.talkId },
    async (ctx) => {
      const talk = await loadTalkOr404({
        workspaceId: ctx.workspace.id,
        talkId: input.talkId,
      });
      if ('statusCode' in talk) return talk;
      return error(
        409,
        'threads_not_supported',
        'Greenfield Talks currently expose one default thread. Creating additional threads is not supported yet.',
      );
    },
  );
}

export async function patchGreenfieldThreadRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
  threadId: string;
}): Promise<RouteResult<ReturnType<typeof toThreadApi>>> {
  const threadError = assertSyntheticThread({
    talkId: input.talkId,
    threadId: input.threadId,
  });
  if (threadError) return threadError;
  return withResolvedWorkspace(
    input.auth,
    input.workspaceId,
    { talkId: input.talkId },
    async (ctx) => {
      const talk = await loadTalkOr404({
        workspaceId: ctx.workspace.id,
        talkId: input.talkId,
      });
      if ('statusCode' in talk) return talk;
      return error(
        409,
        'thread_metadata_not_supported',
        'Greenfield Talks currently expose one default thread, so thread rename and pin changes are not supported yet.',
      );
    },
  );
}

export async function deleteGreenfieldThreadRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
  threadId: string;
}): Promise<RouteResult<{ deleted: true }>> {
  const threadError = assertSyntheticThread({
    talkId: input.talkId,
    threadId: input.threadId,
  });
  if (threadError) return threadError;
  const threads = await listGreenfieldThreadsRoute(input);
  if (!threads.body.ok) return failure(threads);
  return error(
    409,
    'default_thread_required',
    'The default thread cannot be deleted.',
  );
}

async function contentPayload(input: {
  workspaceId: string;
  document: GreenfieldDocumentRecord | undefined;
}): Promise<{
  content: ReturnType<typeof toContentApi> | null;
  pendingEdits: ReturnType<typeof toPendingEditApi>[];
}> {
  if (!input.document) return { content: null, pendingEdits: [] };
  const edits = await listPendingGreenfieldDocumentEdits({
    workspaceId: input.workspaceId,
    documentId: input.document.id,
  });
  return {
    content: toContentApi(input.document),
    pendingEdits: edits.map(toPendingEditApi),
  };
}

export async function listGreenfieldRunsRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
}): Promise<
  RouteResult<{ talkId: string; runs: ReturnType<typeof toRunApi>[] }>
> {
  return withResolvedWorkspace(
    input.auth,
    input.workspaceId,
    { talkId: input.talkId },
    async (ctx) => {
      const talk = await loadTalkOr404({
        workspaceId: ctx.workspace.id,
        talkId: input.talkId,
      });
      if ('statusCode' in talk) return talk;
      const runs = await listGreenfieldRuns({
        workspaceId: ctx.workspace.id,
        talkId: input.talkId,
      });
      return ok({ talkId: input.talkId, runs: runs.map(toRunApi) });
    },
  );
}

export async function getGreenfieldRunContextRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
  runId: string;
}): Promise<
  RouteResult<{
    talkId: string;
    runId: string;
    contextSnapshot: TalkRunContextSnapshot | null;
  }>
> {
  if (!isUuid(input.talkId)) {
    return error(400, 'invalid_talk_id', 'Talk id must be a UUID.');
  }
  if (!isUuid(input.runId)) {
    return error(400, 'invalid_run_id', 'Run id must be a UUID.');
  }
  return withResolvedWorkspace(
    input.auth,
    input.workspaceId,
    { talkId: input.talkId },
    async (ctx) => {
      const talk = await loadTalkOr404({
        workspaceId: ctx.workspace.id,
        talkId: input.talkId,
      });
      if ('statusCode' in talk) return talk;
      const snapshotRecord = await getGreenfieldRunContextSnapshotRecord({
        workspaceId: ctx.workspace.id,
        talkId: input.talkId,
        runId: input.runId,
      });
      if (!snapshotRecord) {
        return error(404, 'run_not_found', 'Run not found.');
      }
      return ok({
        talkId: input.talkId,
        runId: input.runId,
        contextSnapshot: toRunContextSnapshot(snapshotRecord),
      });
    },
  );
}

export async function getGreenfieldSnapshotRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
  threadId?: string | null;
}): Promise<
  RouteResult<{
    talk: ReturnType<typeof toSnapshotTalk>;
    threads: ReturnType<typeof toSnapshotThreadApi>[];
    activeThreadId: string;
    messages: ReturnType<typeof toMessageApi>[];
    hasOlderMessages: boolean;
    content: ReturnType<typeof toContentApi> | null;
    pendingEdits: ReturnType<typeof toPendingEditApi>[];
    runs: ReturnType<typeof toSnapshotRunApi>[];
    agents: ReturnType<typeof toSnapshotAgent>[];
    snapshotVersion: number;
  }>
> {
  const threadError = assertSyntheticThread({
    talkId: input.talkId,
    threadId: input.threadId,
  });
  if (threadError) return threadError;
  return withResolvedWorkspace(
    input.auth,
    input.workspaceId,
    { talkId: input.talkId },
    async (ctx) => {
      const talk = await loadTalkOr404({
        workspaceId: ctx.workspace.id,
        talkId: input.talkId,
      });
      if ('statusCode' in talk) return talk;
      // Outbox cursor for the client's streamed-message dedup. Read BEFORE
      // the message load so it stays a lower bound consistent with the
      // returned messages (see getTalkSnapshotVersion). MUST be the
      // event_outbox high-water (same scale as the streamed eventId), not a
      // wall-clock timestamp — otherwise every streamed reply is dropped and
      // vanishes from the live thread until a reload.
      const snapshotVersion = await getTalkSnapshotVersion({
        talkId: input.talkId,
      });
      const [metrics, rawMessages, document, runs, agents] = await Promise.all([
        getGreenfieldThreadMetrics({
          workspaceId: ctx.workspace.id,
          talkId: input.talkId,
        }),
        listGreenfieldMessages({
          workspaceId: ctx.workspace.id,
          talkId: input.talkId,
          limit: 201,
        }),
        getGreenfieldDocumentForTalk({
          workspaceId: ctx.workspace.id,
          talkId: input.talkId,
        }),
        listGreenfieldRuns({
          workspaceId: ctx.workspace.id,
          talkId: input.talkId,
        }),
        listGreenfieldTalkAgents({
          workspaceId: ctx.workspace.id,
          talkId: input.talkId,
        }),
      ]);
      if (!metrics) return error(404, 'talk_not_found', 'Talk not found.');
      const messages =
        rawMessages.length > 200 ? rawMessages.slice(1) : rawMessages;
      const content = await contentPayload({
        workspaceId: ctx.workspace.id,
        document,
      });
      return ok({
        talk: toSnapshotTalk({
          talk,
          workspace: ctx.workspace,
          userId: input.auth.userId,
        }),
        threads: [toSnapshotThreadApi(talk, metrics)],
        activeThreadId: syntheticThreadId(talk.id),
        messages: messages.map(toMessageApi),
        hasOlderMessages: rawMessages.length > 200,
        content: content.content,
        pendingEdits: content.pendingEdits,
        runs: runs.map(toSnapshotRunApi),
        agents: agents.map(toSnapshotAgent),
        snapshotVersion,
      });
    },
  );
}
