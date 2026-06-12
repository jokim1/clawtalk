import { getDbPg, withUserContext } from '../../../db.js';
import {
  TALK_TOOL_FAMILIES,
  TALK_TOOL_IDS_BY_FAMILY,
  normalizeTalkToolFamiliesFromRows,
} from '../../db/agent-accessors.js';
import {
  listWorkspaceAgents,
  listWorkspaceTeams,
  type GreenfieldAgentRecord,
  type GreenfieldTeamRecord,
} from '../../agents/greenfield-accessors.js';
import { resolveModelCapabilities } from '../../llm/capabilities.js';
import {
  archiveGreenfieldTalk,
  unarchiveGreenfieldTalk,
  createGreenfieldFolder,
  createGreenfieldTalk,
  deleteGreenfieldFolder,
  getGreenfieldTalk,
  listDefaultTalkAgentIds,
  listGreenfieldFolders,
  listGreenfieldTalkAgents,
  listGreenfieldTalkTools,
  listGreenfieldTalks,
  replaceGreenfieldTalkAgents,
  reorderGreenfieldSidebarItem,
  setGreenfieldTalkTools,
  updateGreenfieldFolder,
  updateGreenfieldTalk,
  type GreenfieldFolderRecord,
  type GreenfieldTalkAgentRecord,
  type GreenfieldTalkRecord,
  type GreenfieldTalkToolRecord,
} from '../../talks/greenfield-accessors.js';
import { emitOutboxEvent } from '../../talks/outbox-emit.js';
import {
  addExistingWorkspaceMember,
  getWorkspaceUser,
  listWorkspaceMembers,
  listWorkspacesForUser,
  removeWorkspaceMember,
  resolveWorkspaceForUser,
  transferWorkspaceOwnership,
  updateWorkspaceMemberRole,
  type WorkspaceMemberRecord,
  type WorkspaceRole,
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

type WorkspaceResolutionScope = {
  talkId?: string | null;
  folderId?: string | null;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TALK_AGENTS = 5;

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

function requireWorkspaceAdmin(
  workspace: WorkspaceSummaryRecord,
): RouteResult<never> | null {
  if (workspace.role === 'owner' || workspace.role === 'admin') return null;
  return error(
    403,
    'workspace_admin_required',
    'Workspace admin access is required.',
  );
}

function requireWorkspaceOwner(
  workspace: WorkspaceSummaryRecord,
): RouteResult<never> | null {
  if (workspace.role === 'owner') return null;
  return error(
    403,
    'workspace_owner_required',
    'Workspace owner access is required.',
  );
}

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

async function withResolvedWorkspace<T>(
  auth: AuthContext,
  requestedWorkspaceId: string | null | undefined,
  scopeOrFn:
    | WorkspaceResolutionScope
    | null
    | ((ctx: WorkspaceContext) => Promise<RouteResult<T>>),
  maybeFn?: (ctx: WorkspaceContext) => Promise<RouteResult<T>>,
): Promise<RouteResult<T>> {
  const scope = typeof scopeOrFn === 'function' ? null : (scopeOrFn ?? null);
  const fn = typeof scopeOrFn === 'function' ? scopeOrFn : maybeFn;
  if (!fn) {
    throw new Error('withResolvedWorkspace requires a route handler.');
  }
  try {
    await ensureWorkspaceBootstrapForUser(auth.userId);
  } catch (err) {
    // A bootstrap bug locks the user out of every route as a fake auth
    // failure — keep the real cause in the logs.
    console.error('[workspace-bootstrap] failed', err);
    return error(401, 'unauthorized', 'Session is not active.');
  }

  return withUserContext(auth.userId, async () => {
    const scopedWorkspaceId =
      requestedWorkspaceId ??
      (await findVisibleScopedWorkspaceId({
        userId: auth.userId,
        talkId: scope?.talkId ?? null,
        folderId: scope?.folderId ?? null,
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

async function findVisibleScopedWorkspaceId(input: {
  userId: string;
  talkId: string | null;
  folderId: string | null;
}): Promise<string | undefined> {
  const db = getDbPg();
  if (input.talkId) {
    const rows = await db<{ workspace_id: string }[]>`
      select t.workspace_id
      from public.talks t
      join public.workspace_members wm
        on wm.workspace_id = t.workspace_id
       and wm.user_id = ${input.userId}::uuid
      where t.id = ${input.talkId}::uuid
      limit 1
    `;
    if (rows[0]) return rows[0].workspace_id;
  }
  if (input.folderId) {
    const rows = await db<{ workspace_id: string }[]>`
      select f.workspace_id
      from public.folders f
      join public.workspace_members wm
        on wm.workspace_id = f.workspace_id
       and wm.user_id = ${input.userId}::uuid
      where f.id = ${input.folderId}::uuid
      limit 1
    `;
    if (rows[0]) return rows[0].workspace_id;
  }
  return undefined;
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

function toWorkspaceMemberApiRecord(member: WorkspaceMemberRecord): {
  workspaceId: string;
  userId: string;
  email: string;
  name: string;
  avatarColor: string | null;
  initials: string | null;
  role: WorkspaceRole;
  createdAt: string;
} {
  return {
    workspaceId: member.workspace_id,
    userId: member.user_id,
    email: member.email,
    name: member.name,
    avatarColor: member.avatar_color,
    initials: member.initials,
    role: member.role,
    createdAt: member.created_at,
  };
}

export async function getGreenfieldMeRoute(input: {
  auth: AuthContext;
  requestedWorkspaceId?: string | null;
}): Promise<RouteResult<SessionMePayload>> {
  try {
    await ensureWorkspaceBootstrapForUser(input.auth.userId);
  } catch (err) {
    console.error('[workspace-bootstrap] failed', err);
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

type TalkAccessRole = 'owner' | 'admin' | 'editor' | 'viewer';

function talkAccessRole(input: {
  talk: GreenfieldTalkRecord;
  workspace: WorkspaceSummaryRecord;
  userId: string;
}): TalkAccessRole {
  if (input.workspace.role === 'guest') return 'viewer';
  if (input.talk.created_by === input.userId) return 'owner';
  if (input.workspace.role === 'owner' || input.workspace.role === 'admin') {
    return 'admin';
  }
  return 'editor';
}

function toTalkApiRecord(input: {
  talk: GreenfieldTalkRecord;
  workspace: WorkspaceSummaryRecord;
  userId: string;
}): {
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
  accessRole: TalkAccessRole;
  workspaceId: string;
  mode: 'Ordered' | 'Parallel';
  rounds: number;
  running: boolean;
  unread: number;
  archivedAt: string | null;
  lastActivityAt: string;
  primaryDocumentId: string | null;
  messageCount: number;
  isSystem: boolean;
} {
  const { talk } = input;
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
    accessRole: talkAccessRole(input),
    workspaceId: talk.workspace_id,
    mode: talk.mode === 'parallel' ? 'Parallel' : 'Ordered',
    rounds: talk.rounds_limit,
    running: talk.has_active_run,
    unread: 0,
    archivedAt: talk.archived_at,
    lastActivityAt: talk.last_activity_at,
    primaryDocumentId: talk.primary_document_id,
    messageCount: talk.message_count,
    isSystem: talk.is_system,
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

export async function listWorkspaceMembersRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
}): Promise<
  RouteResult<{ members: ReturnType<typeof toWorkspaceMemberApiRecord>[] }>
> {
  if (!input.workspaceId || !isUuid(input.workspaceId)) {
    return error(
      400,
      'workspace_id_required',
      'A valid workspaceId is required.',
    );
  }
  return withResolvedWorkspace(input.auth, input.workspaceId, async (ctx) => {
    const members = await listWorkspaceMembers({
      workspaceId: ctx.workspace.id,
    });
    return ok({ members: members.map(toWorkspaceMemberApiRecord) });
  });
}

export async function inviteWorkspaceMemberRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  body: { email?: unknown; role?: unknown };
}): Promise<
  RouteResult<{ member: ReturnType<typeof toWorkspaceMemberApiRecord> }>
> {
  if (!input.workspaceId || !isUuid(input.workspaceId)) {
    return error(
      400,
      'workspace_id_required',
      'A valid workspaceId is required.',
    );
  }
  const email =
    typeof input.body.email === 'string' ? input.body.email.trim() : '';
  if (
    !email ||
    email.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return error(400, 'invalid_email', 'A valid email address is required.');
  }
  const role = input.body.role ?? 'member';
  if (role !== 'admin' && role !== 'member' && role !== 'guest') {
    return error(400, 'invalid_role', 'Role must be admin, member, or guest.');
  }

  return withResolvedWorkspace(input.auth, input.workspaceId, async (ctx) => {
    const adminError = requireWorkspaceAdmin(ctx.workspace);
    if (adminError) return adminError;
    const result = await addExistingWorkspaceMember({
      workspaceId: ctx.workspace.id,
      email,
      role,
    });
    if (!result.ok) {
      return error(result.statusCode, result.code, result.message);
    }
    return ok({ member: toWorkspaceMemberApiRecord(result.data.member) }, 201);
  });
}

export async function updateWorkspaceMemberRoleRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  userId?: string | null;
  body: { role?: unknown };
}): Promise<
  RouteResult<{ member: ReturnType<typeof toWorkspaceMemberApiRecord> }>
> {
  if (!input.workspaceId || !isUuid(input.workspaceId)) {
    return error(
      400,
      'workspace_id_required',
      'A valid workspaceId is required.',
    );
  }
  if (!input.userId || !isUuid(input.userId)) {
    return error(400, 'user_id_required', 'A valid userId is required.');
  }
  const role = input.body.role;
  if (role !== 'admin' && role !== 'member' && role !== 'guest') {
    return error(
      400,
      'invalid_role',
      'Role must be admin, member, or guest. Use transfer ownership for owners.',
    );
  }

  return withResolvedWorkspace(input.auth, input.workspaceId, async (ctx) => {
    const adminError = requireWorkspaceAdmin(ctx.workspace);
    if (adminError) return adminError;
    const result = await updateWorkspaceMemberRole({
      workspaceId: ctx.workspace.id,
      userId: input.userId!,
      role,
    });
    if (!result.ok) {
      return error(result.statusCode, result.code, result.message);
    }
    return ok({ member: toWorkspaceMemberApiRecord(result.data.member) });
  });
}

export async function removeWorkspaceMemberRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  userId?: string | null;
}): Promise<RouteResult<{ removed: true }>> {
  if (!input.workspaceId || !isUuid(input.workspaceId)) {
    return error(
      400,
      'workspace_id_required',
      'A valid workspaceId is required.',
    );
  }
  if (!input.userId || !isUuid(input.userId)) {
    return error(400, 'user_id_required', 'A valid userId is required.');
  }
  return withResolvedWorkspace(input.auth, input.workspaceId, async (ctx) => {
    const adminError = requireWorkspaceAdmin(ctx.workspace);
    if (adminError) return adminError;
    const result = await removeWorkspaceMember({
      workspaceId: ctx.workspace.id,
      actorUserId: input.auth.userId,
      userId: input.userId!,
    });
    if (!result.ok) {
      return error(result.statusCode, result.code, result.message);
    }
    return ok(result.data);
  });
}

export async function transferWorkspaceOwnershipRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  body: { newOwnerUserId?: unknown };
}): Promise<
  RouteResult<{
    workspaceId: string;
    newOwnerUserId: string;
    members: ReturnType<typeof toWorkspaceMemberApiRecord>[];
  }>
> {
  if (!input.workspaceId || !isUuid(input.workspaceId)) {
    return error(
      400,
      'workspace_id_required',
      'A valid workspaceId is required.',
    );
  }
  const newOwnerUserId =
    typeof input.body.newOwnerUserId === 'string'
      ? input.body.newOwnerUserId
      : '';
  if (!isUuid(newOwnerUserId)) {
    return error(
      400,
      'new_owner_user_id_required',
      'A valid newOwnerUserId is required.',
    );
  }

  return withResolvedWorkspace(input.auth, input.workspaceId, async (ctx) => {
    const ownerError = requireWorkspaceOwner(ctx.workspace);
    if (ownerError) return ownerError;
    const result = await transferWorkspaceOwnership({
      workspaceId: ctx.workspace.id,
      actorUserId: input.auth.userId,
      newOwnerUserId,
    });
    if (!result.ok) {
      return error(result.statusCode, result.code, result.message);
    }
    return ok({
      workspaceId: result.data.workspaceId,
      newOwnerUserId: result.data.newOwnerUserId,
      members: result.data.members.map(toWorkspaceMemberApiRecord),
    });
  });
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
    const writerError = requireWorkspaceWriter(ctx.workspace);
    if (writerError) return writerError;
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
  return withResolvedWorkspace(
    input.auth,
    input.workspaceId,
    { folderId: input.folderId },
    async (ctx) => {
      const writerError = requireWorkspaceWriter(ctx.workspace);
      if (writerError) return writerError;
      const folder = await updateGreenfieldFolder({
        workspaceId: ctx.workspace.id,
        folderId: input.folderId,
        title,
        sortOrder: input.sortOrder,
      });
      if (!folder) return error(404, 'folder_not_found', 'Folder not found.');
      return ok({ folder: toFolderApiRecord(folder) });
    },
  );
}

export async function deleteGreenfieldFolderRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  folderId: string;
}): Promise<RouteResult<{ deleted: true }>> {
  if (!isUuid(input.folderId)) {
    return error(400, 'invalid_folder_id', 'Folder id must be a UUID.');
  }
  return withResolvedWorkspace(
    input.auth,
    input.workspaceId,
    { folderId: input.folderId },
    async (ctx) => {
      const writerError = requireWorkspaceWriter(ctx.workspace);
      if (writerError) return writerError;
      const deleted = await deleteGreenfieldFolder({
        workspaceId: ctx.workspace.id,
        folderId: input.folderId,
      });
      if (!deleted) return error(404, 'folder_not_found', 'Folder not found.');
      return ok({ deleted: true });
    },
  );
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
    const allTalks = await listGreenfieldTalks({
      workspaceId: ctx.workspace.id,
      folderId: input.folderId ?? 'all',
      includeArchived: input.includeArchived,
    });
    // The system talk (Buddy) lives behind the sidebar's pinned row, not in
    // the Talks index.
    const talks = allTalks.filter((talk) => !talk.is_system);
    return ok({
      talks: talks.map((talk) =>
        toTalkApiRecord({
          talk,
          workspace: ctx.workspace,
          userId: input.auth.userId,
        }),
      ),
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
    const writerError = requireWorkspaceWriter(ctx.workspace);
    if (writerError) return writerError;
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
    return ok(
      {
        talk: toTalkApiRecord({
          talk,
          workspace: ctx.workspace,
          userId: input.auth.userId,
        }),
      },
      201,
    );
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
  return withResolvedWorkspace(
    input.auth,
    input.workspaceId,
    { talkId: input.talkId },
    async (ctx) => {
      const talk = await getGreenfieldTalk({
        workspaceId: ctx.workspace.id,
        talkId: input.talkId,
      });
      if (!talk) return error(404, 'talk_not_found', 'Talk not found.');
      return ok({
        talk: toTalkApiRecord({
          talk,
          workspace: ctx.workspace,
          userId: input.auth.userId,
        }),
      });
    },
  );
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
  return withResolvedWorkspace(
    input.auth,
    input.workspaceId,
    { talkId: input.talkId },
    async (ctx) => {
      const writerError = requireWorkspaceWriter(ctx.workspace);
      if (writerError) return writerError;
      const talk = await updateGreenfieldTalk({
        workspaceId: ctx.workspace.id,
        talkId: input.talkId,
        title,
        folderId,
        mode: normalizeMode(input.body.mode ?? input.body.orchestrationMode),
        roundsLimit: normalizeRounds(
          input.body.rounds ?? input.body.roundsLimit,
        ),
        sortOrder:
          typeof input.body.sortOrder === 'number'
            ? input.body.sortOrder
            : undefined,
      });
      if (!talk) return error(404, 'talk_not_found', 'Talk not found.');
      return ok({
        talk: toTalkApiRecord({
          talk,
          workspace: ctx.workspace,
          userId: input.auth.userId,
        }),
      });
    },
  );
}

export async function archiveGreenfieldTalkRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
}): Promise<RouteResult<{ deleted: true }>> {
  if (!isUuid(input.talkId)) {
    return error(400, 'invalid_talk_id', 'Talk id must be a UUID.');
  }
  return withResolvedWorkspace(
    input.auth,
    input.workspaceId,
    { talkId: input.talkId },
    async (ctx) => {
      const writerError = requireWorkspaceWriter(ctx.workspace);
      if (writerError) return writerError;
      const archived = await archiveGreenfieldTalk({
        workspaceId: ctx.workspace.id,
        talkId: input.talkId,
      });
      if (!archived) return error(404, 'talk_not_found', 'Talk not found.');
      return ok({ deleted: true });
    },
  );
}

export async function unarchiveGreenfieldTalkRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
}): Promise<RouteResult<{ restored: true }>> {
  if (!isUuid(input.talkId)) {
    return error(400, 'invalid_talk_id', 'Talk id must be a UUID.');
  }
  return withResolvedWorkspace(
    input.auth,
    input.workspaceId,
    { talkId: input.talkId },
    async (ctx) => {
      const writerError = requireWorkspaceWriter(ctx.workspace);
      if (writerError) return writerError;
      const restored = await unarchiveGreenfieldTalk({
        workspaceId: ctx.workspace.id,
        talkId: input.talkId,
      });
      if (!restored) return error(404, 'talk_not_found', 'Talk not found.');
      return ok({ restored: true });
    },
  );
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
    buddyTalkId: string | null;
    contents: [];
  }>
> {
  return withResolvedWorkspace(input.auth, input.workspaceId, async (ctx) => {
    const [folders, allTalks] = await Promise.all([
      listGreenfieldFolders({ workspaceId: ctx.workspace.id }),
      listGreenfieldTalks({ workspaceId: ctx.workspace.id }),
    ]);
    // The system talk (Buddy) renders as the pinned row above the tree, so
    // keep it out of the regular items.
    const buddyTalk = allTalks.find((talk) => talk.is_system) ?? null;
    const talks = allTalks.filter((talk) => !talk.is_system);
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
      buddyTalkId: buddyTalk?.id ?? null,
      contents: [],
    });
  });
}

export async function reorderGreenfieldTalkSidebarRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  itemType: unknown;
  itemId: unknown;
  destinationFolderId: unknown;
  destinationIndex: unknown;
}): Promise<RouteResult<{ reordered: true }>> {
  if (input.itemType !== 'talk' && input.itemType !== 'folder') {
    return error(
      400,
      'invalid_sidebar_reorder',
      'Item type must be talk or folder.',
    );
  }
  if (typeof input.itemId !== 'string' || !isUuid(input.itemId)) {
    return error(400, 'invalid_sidebar_reorder', 'Item id must be a UUID.');
  }
  if (
    input.destinationFolderId !== null &&
    (typeof input.destinationFolderId !== 'string' ||
      !isUuid(input.destinationFolderId))
  ) {
    return error(
      400,
      'invalid_sidebar_reorder',
      'Destination folder must be a folder id or null.',
    );
  }
  if (
    typeof input.destinationIndex !== 'number' ||
    !Number.isInteger(input.destinationIndex) ||
    input.destinationIndex < 0
  ) {
    return error(
      400,
      'invalid_sidebar_reorder',
      'Destination index must be a non-negative integer.',
    );
  }
  const itemType = input.itemType;
  const itemId = input.itemId;
  const destinationFolderId = input.destinationFolderId;
  const destinationIndex = input.destinationIndex;

  return withResolvedWorkspace(
    input.auth,
    input.workspaceId,
    {
      talkId: itemType === 'talk' ? itemId : null,
      folderId: itemType === 'folder' ? itemId : null,
    },
    async (ctx) => {
      const writerError = requireWorkspaceWriter(ctx.workspace);
      if (writerError) return writerError;
      const result = await reorderGreenfieldSidebarItem({
        workspaceId: ctx.workspace.id,
        itemType,
        itemId,
        destinationFolderId,
        destinationIndex,
      });
      if (result.status === 'item_not_found') {
        return error(404, 'sidebar_item_not_found', 'Sidebar item not found.');
      }
      if (result.status === 'destination_not_found') {
        return error(
          404,
          'destination_folder_not_found',
          'Destination folder not found.',
        );
      }
      if (result.status === 'invalid_destination') {
        return error(
          400,
          'invalid_sidebar_reorder',
          'Folders can only be moved at the root level.',
        );
      }
      if (result.status === 'invalid_destination_index') {
        return error(
          400,
          'invalid_sidebar_reorder',
          'Destination index is outside the destination list.',
        );
      }
      return ok({ reordered: true });
    },
  );
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
  return withResolvedWorkspace(
    input.auth,
    input.workspaceId,
    { talkId: input.talkId },
    async (ctx) => {
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
    },
  );
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

  return withResolvedWorkspace(
    input.auth,
    input.workspaceId,
    { talkId: input.talkId },
    async (ctx) => {
      const writerError = requireWorkspaceWriter(ctx.workspace);
      if (writerError) return writerError;
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
    },
  );
}

function toTalkToolsActiveMap(
  rows: GreenfieldTalkToolRecord[],
): Record<string, boolean> {
  return normalizeTalkToolFamiliesFromRows(rows);
}

function toolIdsForFamily(family: string): string[] {
  const toolIds = TALK_TOOL_IDS_BY_FAMILY[family];
  if (!toolIds) {
    throw new Error(`Unhandled greenfield talk tool family: ${family}`);
  }
  return toolIds;
}

const TALK_TOOL_IDS = Object.values(TALK_TOOL_IDS_BY_FAMILY).flat();

function activeToolIdsFromRows(rows: GreenfieldTalkToolRecord[]): string[] {
  const enabled = new Set(
    rows.filter((row) => row.enabled).map((row) => row.tool_id),
  );
  return TALK_TOOL_IDS.filter((toolId) => enabled.has(toolId));
}

function talkToolsPayload(input: {
  talkId: string;
  rows: GreenfieldTalkToolRecord[];
}): {
  talkId: string;
  active: Record<string, boolean>;
  activeToolIds: string[];
  available: string[];
} {
  return {
    talkId: input.talkId,
    active: toTalkToolsActiveMap(input.rows),
    activeToolIds: activeToolIdsFromRows(input.rows),
    available: TALK_TOOL_FAMILIES,
  };
}

type NormalizedToolPatch =
  | { ok: true; toolIds: string[]; enabled: boolean }
  | { ok: false; error: string };

function normalizeTalkToolPatch(body: unknown): NormalizedToolPatch {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'request body must be an object' };
  }
  const raw = body as Record<string, unknown>;
  const family = raw.family;
  const toolId = raw.toolId;
  const enabled = raw.enabled;
  if (typeof enabled !== 'boolean') {
    return { ok: false, error: 'enabled must be a boolean' };
  }

  const hasFamily = typeof family === 'string' && family.trim().length > 0;
  const hasToolId = typeof toolId === 'string' && toolId.trim().length > 0;
  if (hasFamily === hasToolId) {
    return {
      ok: false,
      error: 'provide exactly one of family or toolId',
    };
  }

  if (hasFamily) {
    const normalizedFamily = family.trim();
    if (!TALK_TOOL_FAMILIES.includes(normalizedFamily)) {
      return {
        ok: false,
        error: `unknown family '${normalizedFamily}' — must be one of ${TALK_TOOL_FAMILIES.join(
          ', ',
        )}`,
      };
    }
    return {
      ok: true,
      toolIds: toolIdsForFamily(normalizedFamily),
      enabled,
    };
  }

  const normalizedToolId = typeof toolId === 'string' ? toolId.trim() : '';
  if (!TALK_TOOL_IDS.includes(normalizedToolId)) {
    return {
      ok: false,
      error: `unknown toolId '${normalizedToolId}' — must be one of ${TALK_TOOL_IDS.join(
        ', ',
      )}`,
    };
  }
  return { ok: true, toolIds: [normalizedToolId], enabled };
}

export async function getGreenfieldTalkToolsRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
}): Promise<
  RouteResult<{
    talkId: string;
    active: Record<string, boolean>;
    activeToolIds: string[];
    available: string[];
  }>
> {
  if (!isUuid(input.talkId)) {
    return error(400, 'invalid_talk_id', 'Talk id must be a UUID.');
  }
  return withResolvedWorkspace(
    input.auth,
    input.workspaceId,
    { talkId: input.talkId },
    async (ctx) => {
      const talk = await getGreenfieldTalk({
        workspaceId: ctx.workspace.id,
        talkId: input.talkId,
      });
      if (!talk) return error(404, 'talk_not_found', 'Talk not found.');
      const rows = await listGreenfieldTalkTools({
        workspaceId: ctx.workspace.id,
        talkId: input.talkId,
      });
      return ok(talkToolsPayload({ talkId: input.talkId, rows }));
    },
  );
}

export async function updateGreenfieldTalkToolRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
  body: unknown;
}): Promise<
  RouteResult<{
    talkId: string;
    active: Record<string, boolean>;
    activeToolIds: string[];
    available: string[];
  }>
> {
  if (!isUuid(input.talkId)) {
    return error(400, 'invalid_talk_id', 'Talk id must be a UUID.');
  }
  const normalized = normalizeTalkToolPatch(input.body);
  if (!normalized.ok) {
    return error(400, 'invalid_tool_toggle', normalized.error);
  }

  return withResolvedWorkspace(
    input.auth,
    input.workspaceId,
    { talkId: input.talkId },
    async (ctx) => {
      const writerError = requireWorkspaceWriter(ctx.workspace);
      if (writerError) return writerError;
      const updated = await setGreenfieldTalkTools({
        workspaceId: ctx.workspace.id,
        talkId: input.talkId,
        toolIds: normalized.toolIds,
        enabled: normalized.enabled,
      });
      if (!updated) return error(404, 'talk_not_found', 'Talk not found.');

      const rows = await listGreenfieldTalkTools({
        workspaceId: ctx.workspace.id,
        talkId: input.talkId,
      });
      const payload = talkToolsPayload({ talkId: input.talkId, rows });
      await emitOutboxEvent({
        topic: `talk:${input.talkId}`,
        eventType: 'talk_tools_changed',
        payload: {
          talkId: input.talkId,
          active: payload.active,
        },
        ownerIds: [input.auth.userId],
      });
      return ok(payload);
    },
  );
}
