import { withUserContext } from '../../../db.js';
import {
  listWorkspaceAgents,
  listWorkspaceTeams,
  type GreenfieldAgentRecord,
  type GreenfieldTeamRecord,
} from '../../agents/greenfield-accessors.js';
import { resolveModelCapabilities } from '../../llm/capabilities.js';
import {
  archiveGreenfieldTalk,
  createGreenfieldFolder,
  createGreenfieldTalk,
  deleteGreenfieldFolder,
  getGreenfieldTalk,
  listDefaultTalkAgentIds,
  listGreenfieldFolders,
  listGreenfieldTalkAgents,
  listGreenfieldTalks,
  replaceGreenfieldTalkAgents,
  updateGreenfieldFolder,
  updateGreenfieldTalk,
  type GreenfieldFolderRecord,
  type GreenfieldTalkAgentRecord,
  type GreenfieldTalkRecord,
} from '../../talks/greenfield-accessors.js';
import {
  getWorkspaceUser,
  listWorkspacesForUser,
  resolveWorkspaceForUser,
  type WorkspaceSummaryRecord,
  type WorkspaceUserRecord,
} from '../../workspaces/accessors.js';
import { ensureWorkspaceBootstrapForUser } from '../../workspaces/bootstrap.js';
import type { ApiEnvelope, AuthContext } from '../types.js';

type RouteResult<T> = {
  statusCode: number;
  body: ApiEnvelope<T>;
};

type SessionMePayload = {
  user: {
    id: string;
    email: string;
    name: string;
    displayName: string;
    avatarColor: string | null;
    initials: string | null;
    role: string;
    createdAt: string;
  };
  workspaces: Array<{
    id: string;
    name: string;
    role: string;
    initials: string;
  }>;
  currentWorkspaceId: string;
};

type WorkspaceContext = {
  workspace: WorkspaceSummaryRecord;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TALK_AGENTS = 5;
const LEGACY_POLICY_MAX_AGENT_NAMES = 12;
const MAX_TALK_AGENT_NAME_CHARS = 80;

function ok<T>(data: T, statusCode = 200): RouteResult<T> {
  return { statusCode, body: { ok: true, data } };
}

function error(
  statusCode: number,
  code: string,
  message: string,
): RouteResult<never> {
  return { statusCode, body: { ok: false, error: { code, message } } };
}

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
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

function toSessionMePayload(input: {
  user: WorkspaceUserRecord;
  workspaces: WorkspaceSummaryRecord[];
  currentWorkspaceId: string;
}): SessionMePayload {
  const current = input.workspaces.find(
    (workspace) => workspace.id === input.currentWorkspaceId,
  );
  return {
    user: {
      id: input.user.id,
      email: input.user.email,
      name: input.user.name,
      displayName: input.user.name,
      avatarColor: input.user.avatar_color,
      initials: input.user.initials,
      role: current?.role ?? 'member',
      createdAt: input.user.created_at,
    },
    workspaces: input.workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      role: workspace.role,
      initials: workspace.initials || workspace.name.slice(0, 2).toUpperCase(),
    })),
    currentWorkspaceId: input.currentWorkspaceId,
  };
}

export async function getGreenfieldMeRoute(input: {
  auth: AuthContext;
  requestedWorkspaceId?: string | null;
}): Promise<RouteResult<SessionMePayload>> {
  try {
    await ensureWorkspaceBootstrapForUser(input.auth.userId);
  } catch {
    return error(401, 'unauthorized', 'Session is not active.');
  }

  return withUserContext(input.auth.userId, async () => {
    const [user, workspaces] = await Promise.all([
      getWorkspaceUser(input.auth.userId),
      listWorkspacesForUser(input.auth.userId),
    ]);
    if (!user || workspaces.length === 0) {
      return error(401, 'unauthorized', 'Session is not active.');
    }
    const current =
      (input.requestedWorkspaceId &&
        workspaces.find(
          (workspace) => workspace.id === input.requestedWorkspaceId,
        )) ||
      workspaces[0]!;
    if (
      input.requestedWorkspaceId &&
      current.id !== input.requestedWorkspaceId
    ) {
      return error(403, 'workspace_forbidden', 'Workspace is not available.');
    }
    return ok(
      toSessionMePayload({
        user,
        workspaces,
        currentWorkspaceId: current.id,
      }),
    );
  });
}

function toTalkApiRecord(talk: GreenfieldTalkRecord): {
  id: string;
  ownerId: string;
  title: string;
  orchestrationMode: 'ordered' | 'panel';
  agents: string[];
  status: 'active' | 'archived';
  folderId: string | null;
  sortOrder: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  accessRole: 'owner';
  workspaceId: string;
  mode: 'Ordered' | 'Parallel';
  rounds: number;
  running: boolean;
  unread: number;
  archivedAt: string | null;
  lastActivityAt: string;
  primaryDocumentId: string | null;
  messageCount: number;
} {
  return {
    id: talk.id,
    ownerId: talk.created_by,
    title: talk.title,
    orchestrationMode: talk.mode === 'parallel' ? 'panel' : 'ordered',
    agents: talk.agent_ids,
    status: talk.archived_at ? 'archived' : 'active',
    folderId: talk.folder_id,
    sortOrder: talk.sort_order,
    version: 1,
    createdAt: talk.created_at,
    updatedAt: talk.updated_at,
    accessRole: 'owner',
    workspaceId: talk.workspace_id,
    mode: talk.mode === 'parallel' ? 'Parallel' : 'Ordered',
    rounds: talk.rounds_limit,
    running: talk.has_active_run,
    unread: 0,
    archivedAt: talk.archived_at,
    lastActivityAt: talk.last_activity_at,
    primaryDocumentId: talk.primary_document_id,
    messageCount: talk.message_count,
  };
}

function toFolderApiRecord(folder: GreenfieldFolderRecord): {
  id: string;
  workspaceId: string;
  title: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  talks: Array<ReturnType<typeof toSidebarTalkApiRecord>>;
} {
  return {
    id: folder.id,
    workspaceId: folder.workspace_id,
    title: folder.title,
    sortOrder: folder.sort_order,
    createdAt: folder.created_at,
    updatedAt: folder.updated_at,
    talks: [],
  };
}

function toSidebarTalkApiRecord(talk: GreenfieldTalkRecord): {
  id: string;
  title: string;
  status: 'active' | 'archived';
  sortOrder: number;
  lastMessageAt: string | null;
  messageCount: number;
  hasActiveRun: boolean;
  hasContent: boolean;
} {
  return {
    id: talk.id,
    title: talk.title,
    status: talk.archived_at ? 'archived' : 'active',
    sortOrder: talk.sort_order,
    lastMessageAt: talk.message_count > 0 ? talk.last_activity_at : null,
    messageCount: talk.message_count,
    hasActiveRun: talk.has_active_run,
    hasContent: talk.primary_document_id !== null,
  };
}

function toAgentApiRecord(agent: GreenfieldAgentRecord): {
  id: string;
  workspaceId: string;
  roleKey: string;
  name: string;
  handle: string;
  initials: string;
  accent: string;
  accentDark: string | null;
  model: string;
  modelDisplayName: string | null;
  defaultModel: string;
  defaultModelDisplayName: string | null;
  job: string;
  persona: string | null;
  focus: string | null;
  method: string[];
  capabilities: string[];
  isCustom: boolean;
  enabled: boolean;
  isDefault: boolean;
} {
  return {
    id: agent.id,
    workspaceId: agent.workspace_id,
    roleKey: agent.role_key,
    name: agent.name,
    handle: agent.handle,
    initials: agent.initials,
    accent: agent.accent,
    accentDark: agent.accent_dark,
    model: agent.model_id,
    modelDisplayName: agent.model_display_name,
    defaultModel: agent.default_model_id,
    defaultModelDisplayName: agent.default_model_display_name,
    job: agent.job,
    persona: agent.persona,
    focus: agent.focus,
    method: agent.method,
    capabilities: agent.capabilities,
    isCustom: agent.is_custom,
    enabled: agent.enabled,
    isDefault: agent.is_default,
  };
}

function toTeamApiRecord(team: GreenfieldTeamRecord): {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  icon: string | null;
  isDefault: boolean;
  runsCount: number;
  agentIds: string[];
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: team.id,
    workspaceId: team.workspace_id,
    name: team.name,
    description: team.description,
    icon: team.icon,
    isDefault: team.is_default,
    runsCount: team.runs_count,
    agentIds: team.agent_ids,
    createdAt: team.created_at,
    updatedAt: team.updated_at,
  };
}

function toTalkAgentApiRecord(agent: GreenfieldTalkAgentRecord): {
  id: string;
  nickname: string;
  nicknameMode: 'auto';
  sourceKind: 'provider';
  role: 'assistant' | 'critic' | 'strategist' | 'editor' | 'analyst';
  isPrimary: boolean;
  displayOrder: number;
  health: 'ready' | 'invalid';
  providerId: string | null;
  modelId: string;
  modelDisplayName: string | null;
  supportsVision: boolean;
  supportsPdfDocuments: boolean;
} {
  const capabilities =
    agent.provider_id && agent.model_id
      ? resolveModelCapabilities({
          providerId: agent.provider_id,
          modelId: agent.model_id,
        })
      : null;
  return {
    id: agent.id,
    nickname: agent.name,
    nicknameMode: 'auto',
    sourceKind: 'provider',
    role:
      agent.role_key === 'strategist'
        ? 'strategist'
        : agent.role_key === 'critic'
          ? 'critic'
          : agent.role_key === 'editor'
            ? 'editor'
            : 'analyst',
    isPrimary: agent.sort_order === 0,
    displayOrder: agent.sort_order,
    health: agent.enabled ? 'ready' : 'invalid',
    providerId: agent.provider_id,
    modelId: agent.model_id,
    modelDisplayName: agent.model_display_name,
    supportsVision: capabilities?.supports_vision === true,
    supportsPdfDocuments: capabilities?.supports_pdf_documents === true,
  };
}

export async function listGreenfieldWorkspacesRoute(input: {
  auth: AuthContext;
}): Promise<RouteResult<{ workspaces: SessionMePayload['workspaces'] }>> {
  const me = await getGreenfieldMeRoute({ auth: input.auth });
  if (!me.body.ok) return me;
  return ok({ workspaces: me.body.data.workspaces });
}

export async function switchGreenfieldWorkspaceRoute(input: {
  auth: AuthContext;
  workspaceId?: string;
}): Promise<RouteResult<{ currentWorkspaceId: string }>> {
  if (!input.workspaceId) {
    return error(400, 'workspace_id_required', 'workspaceId is required.');
  }
  return withResolvedWorkspace(input.auth, input.workspaceId, async (ctx) =>
    ok({ currentWorkspaceId: ctx.workspace.id }),
  );
}

export async function listGreenfieldAgentsRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
}): Promise<
  RouteResult<{
    agents: ReturnType<typeof toAgentApiRecord>[];
    teams: ReturnType<typeof toTeamApiRecord>[];
  }>
> {
  return withResolvedWorkspace(input.auth, input.workspaceId, async (ctx) => {
    const [agents, teams] = await Promise.all([
      listWorkspaceAgents({ workspaceId: ctx.workspace.id }),
      listWorkspaceTeams({ workspaceId: ctx.workspace.id }),
    ]);
    return ok({
      agents: agents.map(toAgentApiRecord),
      teams: teams.map(toTeamApiRecord),
    });
  });
}

export async function listGreenfieldFoldersRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
}): Promise<RouteResult<{ folders: ReturnType<typeof toFolderApiRecord>[] }>> {
  return withResolvedWorkspace(input.auth, input.workspaceId, async (ctx) => {
    const folders = await listGreenfieldFolders({
      workspaceId: ctx.workspace.id,
    });
    return ok({ folders: folders.map(toFolderApiRecord) });
  });
}

export async function createGreenfieldFolderRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  title?: string;
}): Promise<RouteResult<{ folder: ReturnType<typeof toFolderApiRecord> }>> {
  const title = input.title?.trim() || 'Untitled Folder';
  if (title.length > 160) {
    return error(
      400,
      'invalid_folder_title',
      'Folder title must be 160 characters or less.',
    );
  }
  return withResolvedWorkspace(input.auth, input.workspaceId, async (ctx) => {
    const folder = await createGreenfieldFolder({
      workspaceId: ctx.workspace.id,
      title,
    });
    return ok({ folder: toFolderApiRecord(folder) }, 201);
  });
}

export async function patchGreenfieldFolderRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  folderId: string;
  title?: string;
  sortOrder?: number;
}): Promise<RouteResult<{ folder: ReturnType<typeof toFolderApiRecord> }>> {
  if (!isUuid(input.folderId)) {
    return error(400, 'invalid_folder_id', 'Folder id must be a UUID.');
  }
  const title = input.title?.trim();
  if (title !== undefined && title.length === 0) {
    return error(400, 'invalid_folder_title', 'Folder title is required.');
  }
  if (title && title.length > 160) {
    return error(
      400,
      'invalid_folder_title',
      'Folder title must be 160 characters or less.',
    );
  }
  return withResolvedWorkspace(input.auth, input.workspaceId, async (ctx) => {
    const folder = await updateGreenfieldFolder({
      workspaceId: ctx.workspace.id,
      folderId: input.folderId,
      title,
      sortOrder: input.sortOrder,
    });
    if (!folder) return error(404, 'folder_not_found', 'Folder not found.');
    return ok({ folder: toFolderApiRecord(folder) });
  });
}

export async function deleteGreenfieldFolderRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  folderId: string;
}): Promise<RouteResult<{ deleted: true }>> {
  if (!isUuid(input.folderId)) {
    return error(400, 'invalid_folder_id', 'Folder id must be a UUID.');
  }
  return withResolvedWorkspace(input.auth, input.workspaceId, async (ctx) => {
    const deleted = await deleteGreenfieldFolder({
      workspaceId: ctx.workspace.id,
      folderId: input.folderId,
    });
    if (!deleted) return error(404, 'folder_not_found', 'Folder not found.');
    return ok({ deleted: true });
  });
}

export async function listGreenfieldTalksRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  folderId?: string | null | 'all' | 'unfiled';
  includeArchived?: boolean;
}): Promise<
  RouteResult<{
    talks: ReturnType<typeof toTalkApiRecord>[];
    page: { limit: number; offset: number; count: number };
  }>
> {
  return withResolvedWorkspace(input.auth, input.workspaceId, async (ctx) => {
    const talks = await listGreenfieldTalks({
      workspaceId: ctx.workspace.id,
      folderId: input.folderId ?? 'all',
      includeArchived: input.includeArchived,
    });
    return ok({
      talks: talks.map(toTalkApiRecord),
      page: { limit: talks.length, offset: 0, count: talks.length },
    });
  });
}

function normalizeMode(value: unknown): 'ordered' | 'parallel' | undefined {
  if (value === 'ordered' || value === 'Ordered') return 'ordered';
  if (value === 'parallel' || value === 'Parallel' || value === 'panel') {
    return 'parallel';
  }
  return undefined;
}

function normalizeRounds(value: unknown): 1 | 2 | 3 | 5 | undefined {
  if (value === 1 || value === 2 || value === 3 || value === 5) return value;
  return undefined;
}

function normalizeTalkAgentRoster(
  input: unknown,
): { agentIds: string[] } | { error: string } {
  if (!Array.isArray(input)) {
    return { error: 'agents must be an array' };
  }
  if (input.length === 0) {
    return { error: 'at least one talk agent is required' };
  }
  if (input.length > MAX_TALK_AGENTS) {
    return { error: `at most ${MAX_TALK_AGENTS} talk agents are allowed` };
  }

  const seen = new Set<string>();
  const entries: Array<{ id: string; displayOrder: number; index: number }> =
    [];
  for (const [index, raw] of input.entries()) {
    const rawObject =
      raw && typeof raw === 'object'
        ? (raw as Record<string, unknown>)
        : undefined;
    const id =
      typeof raw === 'string'
        ? raw.trim()
        : typeof rawObject?.id === 'string'
          ? rawObject.id.trim()
          : '';
    if (!id || !isUuid(id)) {
      return { error: 'each talk agent id must be a UUID' };
    }
    if (seen.has(id)) {
      return { error: 'talk agent ids must be unique' };
    }
    seen.add(id);
    const displayOrder =
      typeof rawObject?.displayOrder === 'number'
        ? Math.max(0, Math.floor(rawObject.displayOrder))
        : typeof rawObject?.sortOrder === 'number'
          ? Math.max(0, Math.floor(rawObject.sortOrder))
          : index;
    entries.push({ id, displayOrder, index });
  }

  return {
    agentIds: entries
      .sort(
        (left, right) =>
          left.displayOrder - right.displayOrder || left.index - right.index,
      )
      .map((entry) => entry.id),
  };
}

export async function createGreenfieldTalkRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  body: Record<string, unknown>;
}): Promise<RouteResult<{ talk: ReturnType<typeof toTalkApiRecord> }>> {
  const title =
    typeof input.body.title === 'string' && input.body.title.trim()
      ? input.body.title.trim()
      : 'Untitled Talk';
  if (title.length > 160) {
    return error(
      400,
      'invalid_talk_title',
      'Talk title must be 160 characters or less.',
    );
  }
  const folderId =
    typeof input.body.folderId === 'string'
      ? input.body.folderId
      : input.body.folderId === null
        ? null
        : undefined;
  if (folderId && !isUuid(folderId)) {
    return error(400, 'invalid_folder_id', 'Folder id must be a UUID.');
  }
  const requestedAgentsSource = Array.isArray(input.body.team)
    ? input.body.team
    : Array.isArray(input.body.agents)
      ? input.body.agents
      : undefined;
  if (
    requestedAgentsSource &&
    !requestedAgentsSource.every((id) => typeof id === 'string' && isUuid(id))
  ) {
    return error(400, 'invalid_team', 'Team agent ids must be UUIDs.');
  }
  const requestedAgentIds = requestedAgentsSource as string[] | undefined;

  return withResolvedWorkspace(input.auth, input.workspaceId, async (ctx) => {
    const agentIds = await listDefaultTalkAgentIds({
      workspaceId: ctx.workspace.id,
      requestedAgentIds,
    });
    if (requestedAgentIds && agentIds.length !== requestedAgentIds.length) {
      return error(400, 'invalid_team', 'One or more agents are unavailable.');
    }
    if (agentIds.length === 0) {
      return error(
        409,
        'no_agents_available',
        'No enabled agents are available.',
      );
    }
    if (agentIds.length > 5) {
      return error(409, 'roster_full', 'A Talk can include at most 5 agents.');
    }
    const talk = await createGreenfieldTalk({
      workspaceId: ctx.workspace.id,
      createdBy: input.auth.userId,
      title,
      folderId,
      mode: normalizeMode(input.body.mode ?? input.body.orchestrationMode),
      roundsLimit: normalizeRounds(input.body.rounds ?? input.body.roundsLimit),
      agentIds,
    });
    return ok({ talk: toTalkApiRecord(talk) }, 201);
  });
}

export async function getGreenfieldTalkRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
}): Promise<RouteResult<{ talk: ReturnType<typeof toTalkApiRecord> }>> {
  if (!isUuid(input.talkId)) {
    return error(400, 'invalid_talk_id', 'Talk id must be a UUID.');
  }
  return withResolvedWorkspace(input.auth, input.workspaceId, async (ctx) => {
    const talk = await getGreenfieldTalk({
      workspaceId: ctx.workspace.id,
      talkId: input.talkId,
    });
    if (!talk) return error(404, 'talk_not_found', 'Talk not found.');
    return ok({ talk: toTalkApiRecord(talk) });
  });
}

export async function patchGreenfieldTalkRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
  body: Record<string, unknown>;
}): Promise<RouteResult<{ talk: ReturnType<typeof toTalkApiRecord> }>> {
  if (!isUuid(input.talkId)) {
    return error(400, 'invalid_talk_id', 'Talk id must be a UUID.');
  }
  const title =
    typeof input.body.title === 'string' ? input.body.title.trim() : undefined;
  if (title !== undefined && title.length === 0) {
    return error(400, 'invalid_talk_title', 'Talk title is required.');
  }
  if (title && title.length > 160) {
    return error(
      400,
      'invalid_talk_title',
      'Talk title must be 160 characters or less.',
    );
  }
  const folderId =
    typeof input.body.folderId === 'string'
      ? input.body.folderId
      : input.body.folderId === null
        ? null
        : undefined;
  if (folderId && !isUuid(folderId)) {
    return error(400, 'invalid_folder_id', 'Folder id must be a UUID.');
  }
  return withResolvedWorkspace(input.auth, input.workspaceId, async (ctx) => {
    const talk = await updateGreenfieldTalk({
      workspaceId: ctx.workspace.id,
      talkId: input.talkId,
      title,
      folderId,
      mode: normalizeMode(input.body.mode ?? input.body.orchestrationMode),
      roundsLimit: normalizeRounds(input.body.rounds ?? input.body.roundsLimit),
      sortOrder:
        typeof input.body.sortOrder === 'number'
          ? input.body.sortOrder
          : undefined,
    });
    if (!talk) return error(404, 'talk_not_found', 'Talk not found.');
    return ok({ talk: toTalkApiRecord(talk) });
  });
}

export async function archiveGreenfieldTalkRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
}): Promise<RouteResult<{ deleted: true }>> {
  if (!isUuid(input.talkId)) {
    return error(400, 'invalid_talk_id', 'Talk id must be a UUID.');
  }
  return withResolvedWorkspace(input.auth, input.workspaceId, async (ctx) => {
    const archived = await archiveGreenfieldTalk({
      workspaceId: ctx.workspace.id,
      talkId: input.talkId,
    });
    if (!archived) return error(404, 'talk_not_found', 'Talk not found.');
    return ok({ deleted: true });
  });
}

export async function listGreenfieldTalkSidebarRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
}): Promise<
  RouteResult<{
    items: Array<
      | ({ type: 'talk' } & ReturnType<typeof toSidebarTalkApiRecord>)
      | ({ type: 'folder' } & ReturnType<typeof toFolderApiRecord>)
    >;
    mainTalkId: string | null;
    contents: [];
  }>
> {
  return withResolvedWorkspace(input.auth, input.workspaceId, async (ctx) => {
    const [folders, talks] = await Promise.all([
      listGreenfieldFolders({ workspaceId: ctx.workspace.id }),
      listGreenfieldTalks({ workspaceId: ctx.workspace.id }),
    ]);
    const rootTalks = talks.filter((talk) => talk.folder_id === null);
    const folderItems = folders.map((folder) => ({
      type: 'folder' as const,
      ...toFolderApiRecord(folder),
      talks: talks
        .filter((talk) => talk.folder_id === folder.id)
        .map(toSidebarTalkApiRecord),
    }));
    const items = [
      ...rootTalks.map((talk) => ({
        type: 'talk' as const,
        ...toSidebarTalkApiRecord(talk),
      })),
      ...folderItems,
    ].sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
    return ok({
      items,
      mainTalkId: talks[0]?.id ?? null,
      contents: [],
    });
  });
}

export async function listGreenfieldTalkAgentsRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
}): Promise<
  RouteResult<{
    talkId: string;
    agents: ReturnType<typeof toTalkAgentApiRecord>[];
  }>
> {
  if (!isUuid(input.talkId)) {
    return error(400, 'invalid_talk_id', 'Talk id must be a UUID.');
  }
  return withResolvedWorkspace(input.auth, input.workspaceId, async (ctx) => {
    const talk = await getGreenfieldTalk({
      workspaceId: ctx.workspace.id,
      talkId: input.talkId,
    });
    if (!talk) return error(404, 'talk_not_found', 'Talk not found.');
    const agents = await listGreenfieldTalkAgents({
      workspaceId: ctx.workspace.id,
      talkId: input.talkId,
    });
    return ok({
      talkId: input.talkId,
      agents: agents.map(toTalkAgentApiRecord),
    });
  });
}

export async function updateGreenfieldTalkAgentsRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
  agents: unknown;
}): Promise<
  RouteResult<{
    talkId: string;
    agents: ReturnType<typeof toTalkAgentApiRecord>[];
  }>
> {
  if (!isUuid(input.talkId)) {
    return error(400, 'invalid_talk_id', 'Talk id must be a UUID.');
  }
  const normalized = normalizeTalkAgentRoster(input.agents);
  if ('error' in normalized) {
    return error(
      400,
      'invalid_talk_agents',
      normalized.error || 'talk agents are invalid',
    );
  }

  return withResolvedWorkspace(input.auth, input.workspaceId, async (ctx) => {
    const result = await replaceGreenfieldTalkAgents({
      workspaceId: ctx.workspace.id,
      talkId: input.talkId,
      agentIds: normalized.agentIds,
    });
    if (result.status === 'talk_not_found') {
      return error(404, 'talk_not_found', 'Talk not found.');
    }
    if (result.status === 'agents_unavailable') {
      return error(
        400,
        'invalid_talk_agents',
        'One or more agents are unavailable.',
      );
    }
    return ok({
      talkId: input.talkId,
      agents: result.agents.map(toTalkAgentApiRecord),
    });
  });
}

function validateTalkPolicyAgents(input: unknown): true | { error: string } {
  if (!Array.isArray(input)) {
    return { error: 'agents must be an array of strings' };
  }

  const normalizedNames = [
    ...new Set(
      input
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter(Boolean),
    ),
  ];
  if (normalizedNames.length > LEGACY_POLICY_MAX_AGENT_NAMES) {
    return {
      error: `at most ${LEGACY_POLICY_MAX_AGENT_NAMES} agents are allowed`,
    };
  }
  return true;
}

function talkPolicyPayload(input: { talkId: string; agentNames: string[] }): {
  talkId: string;
  agents: string[];
  limits: { maxAgents: number; maxAgentChars: number };
} {
  // Compatibility route, greenfield contract: expose the same 5-agent roster
  // cap enforced by /agents instead of preserving the retired 12-name shim.
  return {
    talkId: input.talkId,
    agents: input.agentNames,
    limits: {
      maxAgents: MAX_TALK_AGENTS,
      maxAgentChars: MAX_TALK_AGENT_NAME_CHARS,
    },
  };
}

export async function getGreenfieldTalkPolicyRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
}): Promise<
  RouteResult<{
    talkId: string;
    agents: string[];
    limits: { maxAgents: number; maxAgentChars: number };
  }>
> {
  if (!isUuid(input.talkId)) {
    return error(400, 'invalid_talk_id', 'Talk id must be a UUID.');
  }
  return withResolvedWorkspace(input.auth, input.workspaceId, async (ctx) => {
    const talk = await getGreenfieldTalk({
      workspaceId: ctx.workspace.id,
      talkId: input.talkId,
    });
    if (!talk) return error(404, 'talk_not_found', 'Talk not found.');
    // Roster mutation lives at PUT /agents. This compatibility facade accepts
    // legacy policy payloads but always reports the current greenfield roster.
    const agents = await listGreenfieldTalkAgents({
      workspaceId: ctx.workspace.id,
      talkId: input.talkId,
    });
    return ok(
      talkPolicyPayload({
        talkId: input.talkId,
        agentNames: agents.map((agent) => agent.name),
      }),
    );
  });
}

export async function updateGreenfieldTalkPolicyRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
  agents: unknown;
}): Promise<
  RouteResult<{
    talkId: string;
    agents: string[];
    limits: { maxAgents: number; maxAgentChars: number };
  }>
> {
  if (!isUuid(input.talkId)) {
    return error(400, 'invalid_talk_id', 'Talk id must be a UUID.');
  }
  const validAgents = validateTalkPolicyAgents(input.agents);
  if (validAgents !== true) {
    return error(400, 'invalid_agents', validAgents.error);
  }

  return withResolvedWorkspace(input.auth, input.workspaceId, async (ctx) => {
    const talk = await getGreenfieldTalk({
      workspaceId: ctx.workspace.id,
      talkId: input.talkId,
    });
    if (!talk) return error(404, 'talk_not_found', 'Talk not found.');
    // Accept legacy-sized payloads with the old shim's lenient string
    // normalization, then report the real greenfield roster. Active roster
    // mutation lives at PUT /agents.
    const agents = await listGreenfieldTalkAgents({
      workspaceId: ctx.workspace.id,
      talkId: input.talkId,
    });
    return ok(
      talkPolicyPayload({
        talkId: input.talkId,
        agentNames: agents.map((agent) => agent.name),
      }),
    );
  });
}
