import { withUserContext } from '../../../db.js';
import {
  getGreenfieldDocumentById,
  getGreenfieldDocumentForTalk,
  getGreenfieldThreadMetrics,
  listGreenfieldMessages,
  listGreenfieldRuns,
  searchGreenfieldMessages,
  createGreenfieldDocumentForTalk,
  deleteGreenfieldMessages,
  listPendingGreenfieldDocumentEdits,
  replaceGreenfieldDocumentBlocks,
  updateGreenfieldDocumentTitle,
  type GreenfieldDocumentBlockRecord,
  type GreenfieldDocumentEditRecord,
  type GreenfieldDocumentRecord,
  type GreenfieldMessageRecord,
  type GreenfieldRunRecord,
  type GreenfieldThreadMetrics,
} from '../../talks/greenfield-detail-accessors.js';
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

async function withResolvedWorkspace<T>(
  auth: AuthContext,
  requestedWorkspaceId: string | null | undefined,
  fn: (ctx: WorkspaceContext) => Promise<RouteResult<T>>,
): Promise<RouteResult<T>> {
  try {
    await ensureWorkspaceBootstrapForUser(auth.userId);
  } catch {
    return error(401, 'unauthorized', 'Session is not active.');
  }

  return withUserContext(auth.userId, async () => {
    const workspace = await resolveWorkspaceForUser({
      userId: auth.userId,
      requestedWorkspaceId,
    });
    if (!workspace) {
      return error(
        requestedWorkspaceId ? 403 : 404,
        requestedWorkspaceId ? 'workspace_forbidden' : 'workspace_not_found',
        requestedWorkspaceId
          ? 'Workspace is not available to this user.'
          : 'No workspace exists for this user.',
      );
    }
    return fn({ workspace });
  });
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
    attachments: normalizeAttachments(message.attachments_json),
  };
}

function normalizeAttachments(value: unknown): Array<{
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  extractionStatus: 'pending' | 'ready' | 'failed';
}> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const id =
      typeof record.id === 'string' ? record.id : `attachment-${index}`;
    const fileName =
      typeof record.fileName === 'string'
        ? record.fileName
        : typeof record.name === 'string'
          ? record.name
          : 'Attachment';
    const fileSize =
      typeof record.fileSize === 'number'
        ? record.fileSize
        : typeof record.size === 'number'
          ? record.size
          : 0;
    const mimeType =
      typeof record.mimeType === 'string'
        ? record.mimeType
        : typeof record.type === 'string'
          ? record.type
          : 'application/octet-stream';
    const rawStatus = record.extractionStatus;
    const extractionStatus =
      rawStatus === 'pending' || rawStatus === 'failed' ? rawStatus : 'ready';
    return [{ id, fileName, fileSize, mimeType, extractionStatus }];
  });
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

function markdownToBlocks(
  markdown: string,
): Array<{ kind: GreenfieldDocumentBlockRecord['kind']; text: string }> {
  return markdown
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      if (part.startsWith('# ')) {
        return { kind: 'h1', text: part.slice(2).trim() };
      }
      if (part.startsWith('## ')) {
        return { kind: 'h2', text: part.slice(3).trim() };
      }
      if (part.startsWith('- ')) {
        return { kind: 'li', text: part.slice(2).trim() };
      }
      if (part.startsWith('```') && part.endsWith('```')) {
        return { kind: 'code', text: part.slice(3, -3).trim() };
      }
      return { kind: 'p', text: part };
    });
}

function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h1|h2|li)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
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
    targetAnchorId: edit.block_id,
    newMarkdown: edit.new_text,
    rationale: null,
    createdAt: edit.created_at,
  };
}

function toSnapshotTalk(talk: GreenfieldTalkRecord): {
  id: string;
  ownerId: string;
  folderId: string | null;
  sortOrder: number;
  title: string | null;
  orchestrationMode: 'ordered' | 'panel';
  status: 'active' | 'paused' | 'archived';
  version: number;
  createdAt: string;
  updatedAt: string;
  accessRole: 'owner';
} {
  return {
    id: talk.id,
    ownerId: talk.created_by,
    folderId: talk.folder_id,
    sortOrder: talk.sort_order,
    title: talk.title,
    orchestrationMode: talk.mode === 'parallel' ? 'panel' : 'ordered',
    status: talk.archived_at ? 'archived' : 'active',
    version: 1,
    createdAt: talk.created_at,
    updatedAt: talk.updated_at,
    accessRole: 'owner',
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
  return withResolvedWorkspace(input.auth, input.workspaceId, async (ctx) => {
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
  });
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
  return withResolvedWorkspace(input.auth, input.workspaceId, async (ctx) => {
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
  });
}

export async function deleteGreenfieldMessagesRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
  messageIds: string[];
}): Promise<
  RouteResult<{
    talkId: string;
    deletedCount: number;
    deletedMessageIds: string[];
  }>
> {
  return withResolvedWorkspace(input.auth, input.workspaceId, async (ctx) => {
    const talk = await loadTalkOr404({
      workspaceId: ctx.workspace.id,
      talkId: input.talkId,
    });
    if ('statusCode' in talk) return talk;
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
  });
}

export async function listGreenfieldThreadsRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
}): Promise<RouteResult<{ threads: ReturnType<typeof toThreadApi>[] }>> {
  return withResolvedWorkspace(input.auth, input.workspaceId, async (ctx) => {
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
  });
}

export async function createGreenfieldThreadRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
}): Promise<RouteResult<{ thread: ReturnType<typeof toThreadApi> }>> {
  const threads = await listGreenfieldThreadsRoute(input);
  if (!threads.body.ok) return failure(threads);
  return ok({ thread: threads.body.data.threads[0]! }, 201);
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
  const threads = await listGreenfieldThreadsRoute(input);
  if (!threads.body.ok) return failure(threads);
  return ok(threads.body.data.threads[0]!);
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

export async function getGreenfieldTalkContentRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
}): Promise<
  Awaited<ReturnType<typeof contentPayload>> extends infer T
    ? RouteResult<T>
    : never
> {
  return withResolvedWorkspace(input.auth, input.workspaceId, async (ctx) => {
    const talk = await loadTalkOr404({
      workspaceId: ctx.workspace.id,
      talkId: input.talkId,
    });
    if ('statusCode' in talk) return talk;
    const document = await getGreenfieldDocumentForTalk({
      workspaceId: ctx.workspace.id,
      talkId: input.talkId,
    });
    return ok(
      await contentPayload({ workspaceId: ctx.workspace.id, document }),
    );
  });
}

export async function getGreenfieldThreadContentRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  threadId: string;
}): Promise<
  Awaited<ReturnType<typeof contentPayload>> extends infer T
    ? RouteResult<T>
    : never
> {
  return getGreenfieldTalkContentRoute({
    auth: input.auth,
    workspaceId: input.workspaceId,
    talkId: input.threadId,
  });
}

export async function createGreenfieldTalkContentRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
  title?: unknown;
  format?: unknown;
}): Promise<RouteResult<{ content: ReturnType<typeof toContentApi> }>> {
  return withResolvedWorkspace(input.auth, input.workspaceId, async (ctx) => {
    const talk = await loadTalkOr404({
      workspaceId: ctx.workspace.id,
      talkId: input.talkId,
    });
    if ('statusCode' in talk) return talk;
    if (typeof input.title !== 'string' || !input.title.trim()) {
      return error(400, 'title_required', 'Content title is required.');
    }
    const format =
      input.format === undefined || input.format === null
        ? 'markdown'
        : input.format;
    if (format !== 'markdown' && format !== 'html') {
      return error(
        400,
        'invalid_format',
        'Content format must be markdown or html.',
      );
    }
    const document = await createGreenfieldDocumentForTalk({
      workspaceId: ctx.workspace.id,
      talkId: input.talkId,
      title: input.title.trim(),
      format,
    });
    return ok({ content: toContentApi(document) }, 201);
  });
}

export async function createGreenfieldThreadContentRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  threadId: string;
  title?: unknown;
  format?: unknown;
}): Promise<RouteResult<{ content: ReturnType<typeof toContentApi> }>> {
  return createGreenfieldTalkContentRoute({
    auth: input.auth,
    workspaceId: input.workspaceId,
    talkId: input.threadId,
    title: input.title,
    format: input.format,
  });
}

export async function patchGreenfieldContentRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  contentId: string;
  expectedVersion?: unknown;
  bodyMarkdown?: unknown;
  bodyHtml?: unknown;
  title?: unknown;
  acceptPendingEditIds?: unknown;
}): Promise<
  RouteResult<{
    content: ReturnType<typeof toContentApi>;
    acceptedPendingEditIds?: string[];
  }>
> {
  if (!isUuid(input.contentId)) {
    return error(400, 'invalid_content_id', 'Content id must be a UUID.');
  }
  if (typeof input.expectedVersion !== 'number') {
    return error(
      400,
      'expected_version_required',
      'expectedVersion is required.',
    );
  }
  return withResolvedWorkspace(input.auth, input.workspaceId, async (ctx) => {
    const document = await getGreenfieldDocumentById({
      workspaceId: ctx.workspace.id,
      documentId: input.contentId,
    });
    if (!document) return error(404, 'not_found', 'Content not found.');
    if (document.list_version !== input.expectedVersion) {
      return error(
        409,
        'version_conflict',
        'This content changed since you started. Reload and retry.',
        { currentVersion: document.list_version },
      );
    }
    if (input.title !== undefined) {
      if (typeof input.title !== 'string' || !input.title.trim()) {
        return error(400, 'title_required', 'Content title is required.');
      }
      await updateGreenfieldDocumentTitle({
        workspaceId: ctx.workspace.id,
        documentId: document.id,
        title: input.title.trim(),
      });
    }
    const nextBody =
      typeof input.bodyMarkdown === 'string'
        ? input.bodyMarkdown
        : typeof input.bodyHtml === 'string'
          ? htmlToText(input.bodyHtml)
          : null;
    if (nextBody !== null) {
      await replaceGreenfieldDocumentBlocks({
        workspaceId: ctx.workspace.id,
        documentId: document.id,
        tabId: document.tab_id,
        blocks: markdownToBlocks(nextBody),
      });
    }
    const updated = await getGreenfieldDocumentById({
      workspaceId: ctx.workspace.id,
      documentId: document.id,
    });
    if (!updated) return error(404, 'not_found', 'Content not found.');
    return ok({ content: toContentApi(updated) });
  });
}

export async function listGreenfieldRunsRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
}): Promise<
  RouteResult<{ talkId: string; runs: ReturnType<typeof toRunApi>[] }>
> {
  return withResolvedWorkspace(input.auth, input.workspaceId, async (ctx) => {
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
  });
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
  return withResolvedWorkspace(input.auth, input.workspaceId, async (ctx) => {
    const talk = await loadTalkOr404({
      workspaceId: ctx.workspace.id,
      talkId: input.talkId,
    });
    if ('statusCode' in talk) return talk;
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
      talk: toSnapshotTalk(talk),
      threads: [toSnapshotThreadApi(talk, metrics)],
      activeThreadId: syntheticThreadId(talk.id),
      messages: messages.map(toMessageApi),
      hasOlderMessages: rawMessages.length > 200,
      content: content.content,
      pendingEdits: content.pendingEdits,
      runs: runs.map(toSnapshotRunApi),
      agents: agents.map(toSnapshotAgent),
      snapshotVersion: Date.parse(talk.updated_at) || 1,
    });
  });
}
