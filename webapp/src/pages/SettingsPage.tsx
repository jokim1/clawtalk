import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import {
  ApiError,
  type AgentProviderCard,
  type AiAgentsPageData,
  type ChannelKind,
  type DataConnectorKind,
  type ExecutorSettings,
  type ProviderCredentialScope,
  type RegisteredAgent,
  type SessionUser,
  type UserGoogleAccount,
  type WebSearchPageData,
  type WebSearchProviderId,
  type WorkspaceChannel,
  type WorkspaceDataConnector,
  type WorkspaceSlackInstall,
  clearWebSearchCredential,
  completeAnthropicSubscriptionOauth,
  connectUserGoogleAccount,
  connectWorkspaceSlackInstall,
  createWorkspaceChannel,
  createWorkspaceDataConnector,
  deleteWorkspaceChannel,
  deleteWorkspaceDataConnector,
  deleteWorkspaceSlackInstall,
  disconnectUserGoogleAccount,
  expandUserGoogleScopes,
  getAiAgents,
  getMainRegisteredAgent,
  getUserGoogleAccount,
  getWebSearchProviders,
  initiateAnthropicSubscriptionOauth,
  initiateOpenAiCodexSubscriptionOauth,
  listRegisteredAgents,
  listWorkspaceChannels,
  listWorkspaceDataConnectors,
  listWorkspaceSlackInstalls,
  pollOpenAiCodexSubscriptionOauth,
  saveAiProviderCredential,
  setActiveWebSearchProvider,
  setWebSearchCredential,
  setWorkspaceChannelCredential,
  setWorkspaceDataConnectorCredential,
  UnauthorizedError,
  updateMainRegisteredAgent,
  updateSessionMe,
  updateWorkspaceChannel,
  updateWorkspaceDataConnector,
  verifyAiProviderCredential,
} from '../lib/api';
import { launchGoogleAccountPopup } from '../lib/googleAccountPopup';
import { launchSlackInstallPopup } from '../lib/slackInstallPopup';
import {
  type AnthropicSubscriptionOauthState,
  type ApiKeysSubTab,
  type OpenAiCodexSubscriptionOauthState,
  type ProviderDraft,
  ProviderConfigPanel,
  draftKey,
  emptyAnthropicSubscriptionOauthState,
  emptyOpenAiCodexSubscriptionOauthState,
  initProviderDrafts,
  projectProvider,
} from '../components/settings/ProviderConfigPanel';
import { AiAgentsSettingsPanel } from '../components/settings/AiAgentsSettingsPanel';
import {
  ConnectorsSettingsPanel,
  type ConnectorDeleteState,
  type ConnectorListStatus,
  type ConnectorModalState,
  type ConnectorSlackBusy,
} from '../components/settings/ConnectorsSettingsPanel';

const REQUIRED_GOOGLE_TOOL_SCOPES = [
  'drive.readonly',
  'documents',
  'spreadsheets',
];

function isGoogleToolsEnabled(): boolean {
  return import.meta.env.VITE_GOOGLE_TOOLS_ENABLED === 'true';
}

type Props = {
  user: SessionUser;
  userRole: string;
  onUnauthorized: () => void;
  onUserUpdated: (user: SessionUser) => void;
};

type SettingsTab = 'profile' | 'api-keys' | 'agents' | 'tools' | 'connectors';

const TAB_VALUES: readonly SettingsTab[] = [
  'profile',
  'api-keys',
  'agents',
  'tools',
  'connectors',
];

const TAB_PAGE_HEADERS: Record<
  SettingsTab,
  { title: string; subtitle: string }
> = {
  profile: {
    title: 'My Profile',
    subtitle: 'Manage your personal information.',
  },
  'api-keys': {
    title: 'API Keys',
    subtitle:
      'Workspace-shared and personal AI provider credentials used by your agents.',
  },
  agents: {
    title: 'AI Agents',
    subtitle: 'Register the agents available in your talks.',
  },
  tools: {
    title: 'Tools',
    subtitle: 'Configure tool integrations that agents can call.',
  },
  connectors: {
    title: 'Connectors',
    subtitle:
      'Workspace-wide channels and data sources that any talk can opt into.',
  },
};

function parseTab(value: string | null): SettingsTab {
  return TAB_VALUES.includes(value as SettingsTab)
    ? (value as SettingsTab)
    : 'profile';
}

// The new cloud Worker has no Anthropic-container runtime, so the
// Anthropic execution preview the RegisteredAgentsPanel renders is
// derived purely from whether an Anthropic API key is on file. We
// pass a synthetic ExecutorSettings shape that drives the panel's
// "Main will use Anthropic direct HTTP" branch when the Anthropic
// card has a credential, and the "no key configured" branch otherwise.
function deriveExecutorSettings(
  providers: AgentProviderCard[],
): ExecutorSettings {
  const anthropic = providers.find((p) => p.id === 'provider.anthropic');
  // Any credential surface the execution-resolver will accept counts as
  // "configured". Workspace api_key + personal/workspace OAuth
  // subscriptions all flow into the same resolver fallback chain, so
  // surfacing them here unblocks Save in the agent form.
  const hasApiKey =
    anthropic?.hasCredential === true ||
    anthropic?.workspaceHasCredential === true;
  const hasOauthToken =
    anthropic?.hasPersonalSubscription === true ||
    anthropic?.hasWorkspaceSubscription === true;
  return {
    configuredAliasMap: {},
    effectiveAliasMap: {},
    defaultAlias: '',
    executorAuthMode: 'api_key',
    authModeSource: 'settings',
    hasApiKey,
    hasOauthToken,
    hasAuthToken: false,
    apiKeySource: hasApiKey ? 'stored' : null,
    oauthTokenSource: hasOauthToken ? 'stored' : null,
    authTokenSource: null,
    apiKeyHint: anthropic?.credentialHint ?? null,
    oauthTokenHint: null,
    authTokenHint: null,
    activeCredentialConfigured: hasApiKey || hasOauthToken,
    verificationStatus: anthropic?.verificationStatus ?? 'missing',
    lastVerifiedAt: anthropic?.lastVerifiedAt ?? null,
    lastVerificationError: anthropic?.lastVerificationError ?? null,
    anthropicBaseUrl: anthropic?.baseUrl ?? '',
    isConfigured: hasApiKey,
    configVersion: 0,
    lastUpdatedAt: null,
    lastUpdatedBy: null,
    configErrors: [],
  };
}

export function SettingsPage({
  user,
  userRole,
  onUnauthorized,
  onUserUpdated,
}: Props): JSX.Element {
  const [searchParams] = useSearchParams();
  const tab = parseTab(searchParams.get('tab'));
  const header = TAB_PAGE_HEADERS[tab];

  return (
    <section className="page-shell">
      <header className="page-header">
        <div>
          <h1>{header.title}</h1>
          <p>{header.subtitle}</p>
        </div>
      </header>

      {tab === 'profile' ? (
        <ProfileTab
          user={user}
          onUnauthorized={onUnauthorized}
          onUserUpdated={onUserUpdated}
        />
      ) : null}

      {tab === 'api-keys' ? (
        <ApiKeysTab
          onUnauthorized={onUnauthorized}
          userRole={userRole}
          workspaceId={user.currentWorkspaceId}
        />
      ) : null}

      {tab === 'agents' ? (
        <AgentsTab
          onUnauthorized={onUnauthorized}
          workspaceId={user.currentWorkspaceId}
        />
      ) : null}

      {tab === 'tools' ? (
        <ToolsTab
          onUnauthorized={onUnauthorized}
          workspaceId={user.currentWorkspaceId}
        />
      ) : null}

      {tab === 'connectors' ? (
        <ConnectorsTab
          onUnauthorized={onUnauthorized}
          userRole={userRole}
          workspaceId={user.currentWorkspaceId}
        />
      ) : null}
    </section>
  );
}

// ─── Profile tab ─────────────────────────────────────────────────────

const PROFILE_AVATAR_GRADIENTS = [
  'linear-gradient(135deg, #6366f1, #8b5cf6)',
  'linear-gradient(135deg, #3b82f6, #06b6d4)',
  'linear-gradient(135deg, #10b981, #34d399)',
  'linear-gradient(135deg, #f59e0b, #f97316)',
  'linear-gradient(135deg, #ef4444, #f43f5e)',
  'linear-gradient(135deg, #8b5cf6, #ec4899)',
  'linear-gradient(135deg, #14b8a6, #3b82f6)',
  'linear-gradient(135deg, #f97316, #ef4444)',
];

function getProfileInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.trim().slice(0, 2).toUpperCase() || '?';
}

function getProfileGradient(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  }
  return PROFILE_AVATAR_GRADIENTS[
    Math.abs(hash) % PROFILE_AVATAR_GRADIENTS.length
  ];
}

function formatProfileDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) return iso;
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function ProfileTab({
  user,
  onUnauthorized,
  onUserUpdated,
}: {
  user: SessionUser;
  onUnauthorized: () => void;
  onUserUpdated: (user: SessionUser) => void;
}): JSX.Element {
  const [nameDraft, setNameDraft] = useState(user.displayName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setNameDraft(user.displayName);
  }, [user.displayName]);

  const hasNameChange =
    nameDraft.trim() !== '' && nameDraft.trim() !== user.displayName;

  const handleSave = async (): Promise<void> => {
    if (!hasNameChange) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await updateSessionMe({
        workspaceId: user.currentWorkspaceId,
        displayName: nameDraft.trim(),
      });
      onUserUpdated(updated);
      setNotice('Profile updated.');
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof ApiError ? err.message : 'Failed to update profile.',
      );
    } finally {
      setSaving(false);
    }
  };

  const initials = getProfileInitials(user.displayName);
  const gradient = getProfileGradient(user.id);

  return (
    <>
      {error ? (
        <div className="settings-banner settings-banner-error" role="alert">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="settings-banner settings-banner-success" role="status">
          {notice}
        </div>
      ) : null}

      <section className="settings-card">
        <h2>Profile Picture</h2>
        <div className="profile-avatar-section">
          <span className="profile-avatar-lg" style={{ background: gradient }}>
            {initials}
          </span>
        </div>
      </section>

      <section className="settings-card">
        <h2>Personal Information</h2>
        <label className="profile-field">
          <span className="profile-field-label">Full name</span>
          <input
            type="text"
            className="profile-field-input"
            value={nameDraft}
            onChange={(event) => setNameDraft(event.target.value)}
          />
        </label>
        <label className="profile-field">
          <span className="profile-field-label">Email address</span>
          <input
            type="text"
            className="profile-field-input profile-field-locked"
            value={user.email}
            readOnly
          />
          <span className="profile-field-hint">
            This is the email used for signing in and notifications.
          </span>
        </label>
        <div className="profile-actions">
          <button
            type="button"
            className="primary-btn"
            disabled={!hasNameChange || saving}
            onClick={() => void handleSave()}
          >
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </section>

      <section className="settings-card">
        <h2>Role &amp; Permissions</h2>
        <div className="profile-role-row">
          <strong>{formatRole(user.role)}</strong>
          <span
            className={`profile-role-badge profile-role-badge-${user.role}`}
          >
            {user.role}
          </span>
        </div>
        <p className="settings-copy">{roleDescription(user.role)}</p>
      </section>

      <section className="settings-card">
        <h2>Account</h2>
        <div className="profile-meta-grid">
          <div>
            <span className="settings-label">User ID</span>
            <strong className="profile-meta-value">
              {user.id.slice(0, 12)}…
            </strong>
          </div>
          <div>
            <span className="settings-label">Member since</span>
            <strong>{formatProfileDate(user.createdAt)}</strong>
          </div>
        </div>
      </section>
    </>
  );
}

function formatRole(role: string): string {
  switch (role) {
    case 'owner':
      return 'Owner';
    case 'admin':
      return 'Admin';
    case 'member':
      return 'Member';
    default:
      return role;
  }
}

function roleDescription(role: string): string {
  switch (role) {
    case 'owner':
      return 'Full access to all settings and billing.';
    case 'admin':
      return 'Can manage agents, connectors, and settings.';
    case 'member':
      return 'Can create and participate in talks.';
    default:
      return '';
  }
}

// ─── API Keys tab ────────────────────────────────────────────────────

const PROVIDER_SAVE_POLL_DELAYS_MS = [
  1_500, 1_500, 2_500, 3_500, 5_000, 5_000, 5_000,
];

export const settingsPageNavigation = {
  reload: (): void => {
    window.location.reload();
  },
};

function updateOauthRecord<T>(
  current: Record<string, T>,
  key: string,
  initial: () => T,
  patch: Partial<T>,
): Record<string, T> {
  return {
    ...current,
    [key]: {
      ...initial(),
      ...(current[key] || {}),
      ...patch,
    },
  };
}

function ApiKeysTab({
  onUnauthorized,
  userRole,
  workspaceId,
}: {
  onUnauthorized: () => void;
  userRole: string;
  workspaceId?: string | null;
}): JSX.Element {
  const isAdmin = userRole === 'owner' || userRole === 'admin';
  const [searchParams, setSearchParams] = useSearchParams();
  const [data, setData] = useState<AiAgentsPageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, ProviderDraft>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [anthropicOauth, setAnthropicOauth] = useState<
    Record<string, AnthropicSubscriptionOauthState>
  >({});
  const [openAiCodexOauth, setOpenAiCodexOauth] = useState<
    Record<string, OpenAiCodexSubscriptionOauthState>
  >({});
  const onUnauthorizedRef = useRef(onUnauthorized);
  // Personal first — that's where members spend most of their time. Admins
  // still get the workspace tab; non-admins see it read-only (the existing
  // ProviderCredentialCard already enforces canManage=isAdmin for workspace
  // scope).
  const [subTab, setSubTab] = useState<ApiKeysSubTab>('personal');

  useEffect(() => {
    onUnauthorizedRef.current = onUnauthorized;
  }, [onUnauthorized]);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const next = await getAiAgents({ workspaceId });
        if (cancelled) return;
        setData(next);
        setDrafts(initProviderDrafts(next.additionalProviders));
        setError(null);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        setError(
          err instanceof ApiError
            ? err.message
            : 'Failed to load AI provider settings.',
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [onUnauthorized, workspaceId]);

  const updateDraft = (
    scope: ProviderCredentialScope,
    providerId: string,
    patch: Partial<ProviderDraft>,
  ): void => {
    setDrafts((current) => {
      const key = draftKey(scope, providerId);
      return {
        ...current,
        [key]: {
          ...(current[key] || {
            apiKey: '',
            showApiKey: false,
            expanded: false,
          }),
          ...patch,
        },
      };
    });
  };

  const updateAnthropicOauth = (
    scope: ProviderCredentialScope,
    providerId: string,
    patch: Partial<AnthropicSubscriptionOauthState>,
  ): void => {
    setAnthropicOauth((current) =>
      updateOauthRecord(
        current,
        draftKey(scope, providerId),
        emptyAnthropicSubscriptionOauthState,
        patch,
      ),
    );
  };

  const updateOpenAiCodexOauth = (
    scope: ProviderCredentialScope,
    providerId: string,
    patch: Partial<OpenAiCodexSubscriptionOauthState>,
  ): void => {
    setOpenAiCodexOauth((current) =>
      updateOauthRecord(
        current,
        draftKey(scope, providerId),
        emptyOpenAiCodexSubscriptionOauthState,
        patch,
      ),
    );
  };

  const resetAnthropicOauth = (
    scope: ProviderCredentialScope,
    providerId: string,
  ): void => {
    setAnthropicOauth((current) =>
      updateOauthRecord(
        current,
        draftKey(scope, providerId),
        emptyAnthropicSubscriptionOauthState,
        emptyAnthropicSubscriptionOauthState(),
      ),
    );
  };

  const resetOpenAiCodexOauth = (
    scope: ProviderCredentialScope,
    providerId: string,
  ): void => {
    setOpenAiCodexOauth((current) =>
      updateOauthRecord(
        current,
        draftKey(scope, providerId),
        emptyOpenAiCodexSubscriptionOauthState,
        emptyOpenAiCodexSubscriptionOauthState(),
      ),
    );
  };

  const refreshProvider = (
    next: AgentProviderCard,
    scope: ProviderCredentialScope,
  ): void => {
    setData((current) =>
      current
        ? {
            ...current,
            additionalProviders: current.additionalProviders.map((entry) =>
              entry.id === next.id ? next : entry,
            ),
          }
        : current,
    );
    const view = projectProvider(next, scope);
    updateDraft(scope, next.id, {
      apiKey: '',
      expanded: !view.hasCredential,
    });
  };

  const pollAfterSave = async (
    providerId: string,
    scope: ProviderCredentialScope,
  ): Promise<void> => {
    for (const delayMs of PROVIDER_SAVE_POLL_DELAYS_MS) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      try {
        const next = await getAiAgents({ workspaceId });
        const provider = next.additionalProviders.find(
          (entry) => entry.id === providerId,
        );
        if (!provider) return;
        refreshProvider(provider, scope);
        const view = projectProvider(provider, scope);
        if (
          view.verificationStatus === 'verifying' ||
          view.verificationStatus === 'not_verified'
        ) {
          continue;
        }
        if (view.verificationStatus === 'verified') {
          setNotice(`${provider.name} verified.`);
        }
        return;
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
        }
        return;
      }
    }
  };

  const handleFailure = (err: unknown, fallback: string): void => {
    if (err instanceof UnauthorizedError) {
      onUnauthorized();
      return;
    }
    setError(err instanceof ApiError ? err.message : fallback);
  };

  useEffect(() => {
    let cancelled = false;
    const timers: number[] = [];

    const setOpenAiOauthByKey = (
      key: string,
      patch: Partial<OpenAiCodexSubscriptionOauthState>,
    ): void => {
      setOpenAiCodexOauth((current) =>
        updateOauthRecord(
          current,
          key,
          emptyOpenAiCodexSubscriptionOauthState,
          patch,
        ),
      );
    };

    for (const [key, oauth] of Object.entries(openAiCodexOauth)) {
      const pending = oauth.pending;
      if (!pending || !oauth.polling) continue;

      const scheduleTick = (): void => {
        const timer = window.setTimeout(() => {
          void tick();
        }, pending.pollIntervalSeconds * 1000);
        timers.push(timer);
      };

      const tick = async (): Promise<void> => {
        try {
          const result = await pollOpenAiCodexSubscriptionOauth({
            state: pending.state,
          });
          if (cancelled) return;
          if (result.status === 'authorized') {
            setOpenAiOauthByKey(key, { pending: null, polling: false });
            settingsPageNavigation.reload();
            return;
          }
          scheduleTick();
        } catch (err) {
          if (cancelled) return;
          if (err instanceof UnauthorizedError) {
            onUnauthorizedRef.current();
            return;
          }
          setOpenAiOauthByKey(key, {
            error:
              err instanceof ApiError
                ? err.message
                : 'Failed to poll OpenAI device authorization.',
            polling: false,
          });
        }
      };

      scheduleTick();
    }

    return () => {
      cancelled = true;
      for (const timer of timers) clearTimeout(timer);
    };
  }, [openAiCodexOauth]);

  const handleStartAnthropicSubscription = async (
    scope: ProviderCredentialScope,
    providerId: string,
  ): Promise<void> => {
    updateAnthropicOauth(scope, providerId, {
      busy: true,
      error: null,
      done: false,
    });
    try {
      const init = await initiateAnthropicSubscriptionOauth(scope, {
        workspaceId,
      });
      updateAnthropicOauth(scope, providerId, {
        authorizeUrl: init.authorizationUrl,
        state: init.state,
        error: null,
      });
      window.open(init.authorizationUrl, '_blank', 'noopener,noreferrer');
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      updateAnthropicOauth(scope, providerId, {
        error:
          err instanceof ApiError
            ? err.message
            : 'Failed to start Claude OAuth.',
      });
    } finally {
      updateAnthropicOauth(scope, providerId, { busy: false });
    }
  };

  const handleCompleteAnthropicSubscription = async (
    scope: ProviderCredentialScope,
    providerId: string,
  ): Promise<void> => {
    const oauth =
      anthropicOauth[draftKey(scope, providerId)] ||
      emptyAnthropicSubscriptionOauthState();
    if (!oauth.state || !oauth.codeDraft.trim()) {
      updateAnthropicOauth(scope, providerId, {
        error: 'Paste the code from console.anthropic.com.',
      });
      return;
    }
    updateAnthropicOauth(scope, providerId, { busy: true, error: null });
    try {
      const codeOnly = oauth.codeDraft.trim().split('#')[0];
      await completeAnthropicSubscriptionOauth({
        state: oauth.state,
        code: codeOnly,
      });
      updateAnthropicOauth(scope, providerId, { done: true });
      window.location.reload();
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      updateAnthropicOauth(scope, providerId, {
        error:
          err instanceof ApiError
            ? err.message
            : 'Failed to complete Claude OAuth.',
      });
    } finally {
      updateAnthropicOauth(scope, providerId, { busy: false });
    }
  };

  const handleStartOpenAiCodexSubscription = async (
    scope: ProviderCredentialScope,
    providerId: string,
  ): Promise<void> => {
    updateOpenAiCodexOauth(scope, providerId, {
      busy: true,
      error: null,
      polling: false,
    });
    try {
      const init = await initiateOpenAiCodexSubscriptionOauth(scope, {
        workspaceId,
      });
      updateOpenAiCodexOauth(scope, providerId, {
        pending: {
          state: init.state,
          userCode: init.userCode,
          verificationUrl: init.verificationUrl,
          pollIntervalSeconds: init.pollIntervalSeconds,
        },
        busy: false,
        error: null,
        polling: true,
      });
      window.open(init.verificationUrl, '_blank', 'noopener,noreferrer');
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        updateOpenAiCodexOauth(scope, providerId, { busy: false });
        onUnauthorized();
        return;
      }
      updateOpenAiCodexOauth(scope, providerId, {
        error:
          err instanceof ApiError
            ? err.message
            : 'Failed to start ChatGPT OAuth.',
        busy: false,
      });
    }
  };

  const handleSave = async (
    providerId: string,
    scope: ProviderCredentialScope,
  ): Promise<void> => {
    const draft = drafts[draftKey(scope, providerId)];
    if (!draft) return;
    const apiKey = draft.apiKey.trim();
    if (!apiKey) {
      setError('Enter an API key before saving.');
      return;
    }
    setBusyKey(`save:${scope}:${providerId}`);
    setNotice(null);
    setError(null);
    try {
      const updated = await saveAiProviderCredential({
        providerId,
        workspaceId,
        apiKey,
        scope,
      });
      refreshProvider(updated, scope);
      const view = projectProvider(updated, scope);
      setNotice(
        scope === 'workspace'
          ? `${updated.name} workspace credential saved.`
          : `${updated.name} credential saved.`,
      );
      if (
        view.verificationStatus === 'verifying' ||
        view.verificationStatus === 'not_verified'
      ) {
        void pollAfterSave(providerId, scope);
      }
    } catch (err) {
      handleFailure(err, 'Failed to save provider credential.');
    } finally {
      setBusyKey(null);
    }
  };

  const handleClear = async (
    providerId: string,
    scope: ProviderCredentialScope,
  ): Promise<void> => {
    setBusyKey(`save:${scope}:${providerId}`);
    setNotice(null);
    setError(null);
    try {
      const updated = await saveAiProviderCredential({
        providerId,
        workspaceId,
        apiKey: null,
        scope,
      });
      refreshProvider(updated, scope);
      setNotice(
        scope === 'workspace'
          ? `${updated.name} workspace credential cleared.`
          : `${updated.name} credential cleared.`,
      );
    } catch (err) {
      handleFailure(err, 'Failed to clear provider credential.');
    } finally {
      setBusyKey(null);
    }
  };

  const handleVerify = async (
    providerId: string,
    scope: ProviderCredentialScope,
  ): Promise<void> => {
    setBusyKey(`verify:${scope}:${providerId}`);
    setNotice(null);
    setError(null);
    try {
      const updated = await verifyAiProviderCredential(providerId, scope, {
        workspaceId,
      });
      refreshProvider(updated, scope);
      setNotice(`${updated.name} verification updated.`);
    } catch (err) {
      handleFailure(err, 'Failed to verify provider credential.');
    } finally {
      setBusyKey(null);
    }
  };

  if (loading) {
    return <section className="page-state">Loading API keys…</section>;
  }

  if (error && !data) {
    return (
      <section className="settings-banner settings-banner-error" role="alert">
        {error}
      </section>
    );
  }

  const providers = data?.additionalProviders ?? [];

  return (
    <>
      {error ? (
        <div className="settings-banner settings-banner-error" role="alert">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="settings-banner settings-banner-success" role="status">
          {notice}
        </div>
      ) : null}

      <ProviderConfigPanel
        providers={providers}
        drafts={drafts}
        busyKey={busyKey}
        subTab={subTab}
        isAdmin={isAdmin}
        anthropicOauth={anthropicOauth}
        openAiCodexOauth={openAiCodexOauth}
        onSubTabChange={setSubTab}
        onDraftChange={updateDraft}
        onSave={(providerId, scope) => void handleSave(providerId, scope)}
        onClear={(providerId, scope) => void handleClear(providerId, scope)}
        onVerify={(providerId, scope) => void handleVerify(providerId, scope)}
        onConfigureAgents={() => {
          const params = new URLSearchParams(searchParams);
          params.set('tab', 'agents');
          setSearchParams(params, { replace: true });
        }}
        onStartAnthropicSubscription={(scope, providerId) =>
          void handleStartAnthropicSubscription(scope, providerId)
        }
        onCompleteAnthropicSubscription={(scope, providerId) =>
          void handleCompleteAnthropicSubscription(scope, providerId)
        }
        onCancelAnthropicSubscription={resetAnthropicOauth}
        onAnthropicCodeDraftChange={(scope, providerId, codeDraft) =>
          updateAnthropicOauth(scope, providerId, { codeDraft })
        }
        onStartOpenAiCodexSubscription={(scope, providerId) =>
          void handleStartOpenAiCodexSubscription(scope, providerId)
        }
        onCancelOpenAiCodexSubscription={resetOpenAiCodexOauth}
      />
    </>
  );
}

// ─── Tools tab ───────────────────────────────────────────────────────

function ToolsTab({
  onUnauthorized,
  workspaceId,
}: {
  onUnauthorized: () => void;
  workspaceId?: string | null;
}): JSX.Element {
  return (
    <>
      {isGoogleToolsEnabled() ? (
        <GoogleAccountSection
          onUnauthorized={onUnauthorized}
          workspaceId={workspaceId}
        />
      ) : null}
      <WebSearchProvidersSection onUnauthorized={onUnauthorized} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Google account (flag-gated behind VITE_GOOGLE_TOOLS_ENABLED until PR2)
// ---------------------------------------------------------------------------

function GoogleAccountSection({
  onUnauthorized,
  workspaceId,
}: {
  onUnauthorized: () => void;
  workspaceId?: string | null;
}): JSX.Element {
  const [account, setAccount] = useState<UserGoogleAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'connect' | 'expand' | 'disconnect' | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const scopedWorkspaceId =
    typeof workspaceId === 'string' && workspaceId.trim()
      ? workspaceId.trim()
      : null;

  useEffect(() => {
    if (!scopedWorkspaceId) {
      setAccount(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const fresh = await getUserGoogleAccount({
          workspaceId: scopedWorkspaceId,
        });
        if (cancelled) return;
        setAccount(fresh);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        setError(
          err instanceof Error ? err.message : 'Failed to load Google account.',
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onUnauthorized, scopedWorkspaceId]);

  async function refresh(): Promise<void> {
    if (!scopedWorkspaceId) return;
    try {
      const fresh = await getUserGoogleAccount({
        workspaceId: scopedWorkspaceId,
      });
      setAccount(fresh);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof Error ? err.message : 'Failed to reload Google account.',
      );
    }
  }

  async function handleConnect(): Promise<void> {
    if (!scopedWorkspaceId) return;
    setBusy('connect');
    setError(null);
    setNotice(null);
    try {
      const launch = await connectUserGoogleAccount({
        scopes: REQUIRED_GOOGLE_TOOL_SCOPES,
        workspaceId: scopedWorkspaceId,
      });
      await launchGoogleAccountPopup(launch.authorizationUrl);
      await refresh();
      setNotice('Google account connected.');
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof Error
          ? err.message
          : 'Could not connect Google account.',
      );
    } finally {
      setBusy(null);
    }
  }

  async function handleExpand(): Promise<void> {
    if (!scopedWorkspaceId) return;
    setBusy('expand');
    setError(null);
    setNotice(null);
    try {
      const launch = await expandUserGoogleScopes({
        scopes: REQUIRED_GOOGLE_TOOL_SCOPES,
        workspaceId: scopedWorkspaceId,
      });
      await launchGoogleAccountPopup(launch.authorizationUrl);
      await refresh();
      setNotice('Scopes updated.');
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(err instanceof Error ? err.message : 'Could not update scopes.');
    } finally {
      setBusy(null);
    }
  }

  async function handleDisconnect(): Promise<void> {
    if (!scopedWorkspaceId) return;
    setBusy('disconnect');
    setError(null);
    setNotice(null);
    try {
      await disconnectUserGoogleAccount({ workspaceId: scopedWorkspaceId });
      await refresh();
      setNotice('Google account disconnected.');
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof Error
          ? err.message
          : 'Could not disconnect Google account.',
      );
    } finally {
      setBusy(null);
    }
  }

  const missingRequired = account
    ? REQUIRED_GOOGLE_TOOL_SCOPES.filter(
        (scope) => !account.scopes.includes(scope),
      )
    : [];

  return (
    <section
      className="settings-section"
      aria-label="Google account"
      data-testid="google-account-section"
    >
      <header>
        <h2>Google account</h2>
        <p>
          Connect your Google account to let agents read and write Google Docs
          and Sheets.
        </p>
      </header>

      {error ? <p className="settings-error">{error}</p> : null}
      {notice ? <p className="settings-notice">{notice}</p> : null}

      {!scopedWorkspaceId ? (
        <div className="settings-card">
          <p>Select a workspace before connecting Google tools.</p>
        </div>
      ) : loading ? (
        <p>Loading…</p>
      ) : account?.connected ? (
        <div className="settings-card">
          <p>
            <strong>Connected as:</strong>{' '}
            {account.email ?? account.displayName ?? 'unknown'}
          </p>
          <p>
            <strong>Granted scopes:</strong>{' '}
            {account.scopes.length > 0 ? account.scopes.join(', ') : 'none'}
          </p>
          {missingRequired.length > 0 ? (
            <p className="settings-warning">
              Missing required scopes for Google Drive tools:{' '}
              {missingRequired.join(', ')}.{' '}
              <button
                type="button"
                onClick={() => void handleExpand()}
                disabled={busy !== null}
              >
                {busy === 'expand' ? 'Re-requesting…' : 'Re-request scopes'}
              </button>
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => void handleDisconnect()}
            disabled={busy !== null}
          >
            {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
          </button>
        </div>
      ) : (
        <div className="settings-card">
          <p>No Google account connected.</p>
          <button
            type="button"
            onClick={() => void handleConnect()}
            disabled={busy !== null}
          >
            {busy === 'connect' ? 'Connecting…' : 'Connect Google account'}
          </button>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Web Search Providers (per-user keys + active picker)
// ---------------------------------------------------------------------------

const WEB_SEARCH_DOCS: Record<
  WebSearchProviderId,
  { url: string; label: string }
> = {
  'web_search.tavily': {
    url: 'https://app.tavily.com/home',
    label: 'Tavily',
  },
  'web_search.brave': {
    url: 'https://api.search.brave.com/app/keys',
    label: 'Brave Search',
  },
  'web_search.firecrawl': {
    url: 'https://www.firecrawl.dev/app/api-keys',
    label: 'Firecrawl',
  },
  'web_search.exa': {
    url: 'https://dashboard.exa.ai/api-keys',
    label: 'Exa',
  },
};

const WEB_SEARCH_PLACEHOLDER: Record<WebSearchProviderId, string> = {
  'web_search.tavily': 'tvly-...',
  'web_search.brave': 'BSA...',
  'web_search.firecrawl': 'fc-...',
  'web_search.exa': 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
};

function WebSearchProvidersSection({
  onUnauthorized,
}: {
  onUnauthorized: () => void;
}): JSX.Element {
  const [data, setData] = useState<WebSearchPageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<
    Record<WebSearchProviderId, { apiKey: string; showApiKey: boolean }>
  >({} as never);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const fresh = await getWebSearchProviders();
        if (cancelled) return;
        setData(fresh);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        setError(
          err instanceof Error
            ? err.message
            : 'Failed to load web search providers.',
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onUnauthorized]);

  function patchDraft(
    providerId: WebSearchProviderId,
    patch: Partial<{ apiKey: string; showApiKey: boolean }>,
  ) {
    setDrafts((prev) => {
      const existing = prev[providerId] ?? { apiKey: '', showApiKey: false };
      return {
        ...prev,
        [providerId]: { ...existing, ...patch },
      };
    });
  }

  async function refresh() {
    try {
      const fresh = await getWebSearchProviders();
      setData(fresh);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof Error
          ? err.message
          : 'Failed to reload web search providers.',
      );
    }
  }

  async function handleSave(providerId: WebSearchProviderId) {
    const apiKey = drafts[providerId]?.apiKey?.trim();
    if (!apiKey) {
      setError('Paste a key before saving.');
      return;
    }
    setBusyKey(`save:${providerId}`);
    setError(null);
    setNotice(null);
    try {
      await setWebSearchCredential(providerId, apiKey);
      patchDraft(providerId, { apiKey: '', showApiKey: false });
      await refresh();
      setNotice('Saved.');
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(err instanceof Error ? err.message : 'Failed to save key.');
    } finally {
      setBusyKey(null);
    }
  }

  async function handleClear(providerId: WebSearchProviderId) {
    setBusyKey(`clear:${providerId}`);
    setError(null);
    setNotice(null);
    try {
      await clearWebSearchCredential(providerId);
      await refresh();
      setNotice('Key removed.');
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(err instanceof Error ? err.message : 'Failed to remove key.');
    } finally {
      setBusyKey(null);
    }
  }

  async function handleSetActive(providerId: WebSearchProviderId | null) {
    setBusyKey(`active:${providerId ?? 'none'}`);
    setError(null);
    setNotice(null);
    try {
      await setActiveWebSearchProvider(providerId);
      await refresh();
      setNotice(
        providerId ? 'Active provider updated.' : 'Active provider cleared.',
      );
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof Error
          ? err.message
          : 'Failed to update active provider.',
      );
    } finally {
      setBusyKey(null);
    }
  }

  if (loading) {
    return (
      <section className="settings-card">
        <h2>Web Search</h2>
        <p className="settings-copy">Loading web search providers…</p>
      </section>
    );
  }

  const providers = data?.providers ?? [];
  const activeProviderId = data?.activeProviderId ?? null;
  const anyKeyStored = providers.some((p) => p.hasCredential);

  return (
    <section className="settings-card">
      <h2>Web Search</h2>
      <p className="settings-copy">
        Agents call <code>web_search</code> to look things up on the live web.
        Add a key for at least one provider, then pick which one is active for
        your account. Keys are personal — they aren't shared with the workspace.
      </p>

      {error ? (
        <div className="settings-banner settings-banner-error" role="alert">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="settings-banner settings-banner-success" role="status">
          {notice}
        </div>
      ) : null}

      <div className="talk-llm-card-list">
        {providers.map((provider) => {
          const draft = drafts[provider.id] || {
            apiKey: '',
            showApiKey: false,
          };
          const docs = WEB_SEARCH_DOCS[provider.id];
          const placeholder = WEB_SEARCH_PLACEHOLDER[provider.id] ?? 'API key';
          const savingBusy = busyKey === `save:${provider.id}`;
          const clearingBusy = busyKey === `clear:${provider.id}`;
          const activatingBusy = busyKey === `active:${provider.id}`;
          const isActive = activeProviderId === provider.id;

          return (
            <article key={provider.id} className="talk-llm-card">
              <div className="talk-llm-card-header">
                <div>
                  <h4>
                    {provider.name}
                    {isActive ? (
                      <span
                        style={{
                          marginLeft: 8,
                          fontSize: '0.8em',
                          color: '#0a7',
                        }}
                      >
                        ● Active
                      </span>
                    ) : null}
                  </h4>
                  <p className="talk-llm-meta">
                    {docs ? (
                      <a href={docs.url} target="_blank" rel="noreferrer">
                        Get key from {docs.label}
                      </a>
                    ) : null}
                  </p>
                </div>
              </div>

              {provider.hasCredential ? (
                <div className="talk-llm-stored-key">
                  <span>
                    Stored key: <code>{provider.credentialHint}</code>
                  </span>
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() => void handleClear(provider.id)}
                    disabled={clearingBusy}
                  >
                    {clearingBusy ? 'Removing…' : 'Remove key'}
                  </button>
                </div>
              ) : null}

              <label className="agent-form-field">
                <span>
                  {provider.hasCredential ? 'Replace key' : 'API key'}
                </span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type={draft.showApiKey ? 'text' : 'password'}
                    value={draft.apiKey}
                    onChange={(e) =>
                      patchDraft(provider.id, { apiKey: e.target.value })
                    }
                    placeholder={placeholder}
                    style={{ flex: 1 }}
                  />
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() =>
                      patchDraft(provider.id, { showApiKey: !draft.showApiKey })
                    }
                  >
                    {draft.showApiKey ? 'Hide' : 'Show'}
                  </button>
                </div>
              </label>

              <div className="talk-llm-inline-actions">
                <button
                  type="button"
                  className="primary-btn"
                  onClick={() => void handleSave(provider.id)}
                  disabled={savingBusy || !draft.apiKey.trim()}
                >
                  {savingBusy
                    ? 'Saving…'
                    : provider.hasCredential
                      ? 'Update key'
                      : 'Save'}
                </button>
                {provider.hasCredential && !isActive ? (
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() => void handleSetActive(provider.id)}
                    disabled={activatingBusy}
                  >
                    {activatingBusy ? 'Setting…' : 'Set as active'}
                  </button>
                ) : null}
                {isActive ? (
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() => void handleSetActive(null)}
                    disabled={busyKey === 'active:none'}
                  >
                    {busyKey === 'active:none' ? 'Clearing…' : 'Clear active'}
                  </button>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>

      {!anyKeyStored ? (
        <p className="settings-copy" style={{ marginTop: 16 }}>
          No web search key stored yet. The <code>web_search</code> tool will
          return a "configure a provider in Settings" error until you save one
          and mark it active.
        </p>
      ) : !activeProviderId ? (
        <p className="settings-copy" style={{ marginTop: 16 }}>
          You have keys stored but no active provider selected.{' '}
          <strong>Pick one above</strong> to enable agent web search.
        </p>
      ) : null}
    </section>
  );
}

// ─── Agents tab ──────────────────────────────────────────────────────

function AgentsTab({
  onUnauthorized,
  workspaceId,
}: {
  onUnauthorized: () => void;
  workspaceId?: string | null;
}): JSX.Element {
  // Registered agents are scoped to the active workspace; route-level
  // permissions decide whether this user can mutate them.
  const canManage = true;
  const [data, setData] = useState<AiAgentsPageData | null>(null);
  const [agents, setAgents] = useState<RegisteredAgent[]>([]);
  const [mainAgentId, setMainAgentId] = useState<string | null>(null);
  const [mainAgentDraft, setMainAgentDraft] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const [nextData, nextAgents, mainAgent] = await Promise.all([
          getAiAgents({ workspaceId }),
          listRegisteredAgents({ workspaceId }),
          getMainRegisteredAgent({ workspaceId }).catch(() => null),
        ]);
        if (cancelled) return;
        setData(nextData);
        setAgents(nextAgents);
        if (mainAgent) {
          setMainAgentId(mainAgent.id);
          setMainAgentDraft(mainAgent.id);
        } else {
          setMainAgentId(null);
          setMainAgentDraft('');
        }
        setError(null);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        setError(
          err instanceof ApiError ? err.message : 'Failed to load agents.',
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [onUnauthorized, workspaceId]);

  const executorSettings = useMemo(
    () => deriveExecutorSettings(data?.additionalProviders ?? []),
    [data?.additionalProviders],
  );

  const handleSaveMain = async (): Promise<void> => {
    if (!mainAgentDraft || mainAgentDraft === mainAgentId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await updateMainRegisteredAgent(mainAgentDraft, {
        workspaceId,
      });
      setMainAgentId(updated.id);
      setMainAgentDraft(updated.id);
      setNotice('Main agent updated.');
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof ApiError ? err.message : 'Failed to update main agent.',
      );
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <section className="page-state">Loading agents…</section>;
  }

  if (!data) {
    return (
      <section className="settings-banner settings-banner-error" role="alert">
        {error || 'Agents are unavailable.'}
      </section>
    );
  }

  return (
    <>
      {error ? (
        <div className="settings-banner settings-banner-error" role="alert">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="settings-banner settings-banner-success" role="status">
          {notice}
        </div>
      ) : null}

      <AiAgentsSettingsPanel
        providers={data.additionalProviders}
        executorSettings={executorSettings}
        agents={agents}
        mainAgentId={mainAgentId}
        mainAgentDraft={mainAgentDraft}
        canManage={canManage}
        busy={busy}
        workspaceId={workspaceId}
        onUnauthorized={onUnauthorized}
        onAgentsChanged={setAgents}
        onMainAgentDraftChange={setMainAgentDraft}
        onSaveMainAgent={() => void handleSaveMain()}
      />
    </>
  );
}

// ─── Connectors tab ───────────────────────────────────────────────────

function ConnectorsTab({
  onUnauthorized,
  userRole,
  workspaceId,
}: {
  onUnauthorized: () => void;
  userRole: string;
  workspaceId?: string | null;
}): JSX.Element {
  const isAdmin = userRole === 'owner' || userRole === 'admin';
  const [status, setStatus] = useState<ConnectorListStatus>({
    kind: 'loading',
  });
  const [channels, setChannels] = useState<WorkspaceChannel[]>([]);
  const [dataConnectors, setDataConnectors] = useState<
    WorkspaceDataConnector[]
  >([]);
  const [slackInstalls, setSlackInstalls] = useState<WorkspaceSlackInstall[]>(
    [],
  );
  const [modal, setModal] = useState<ConnectorModalState>({ kind: 'closed' });
  const [createKind, setCreateKind] = useState<string>('slack');
  const [deleteState, setDeleteState] = useState<ConnectorDeleteState>({
    kind: 'closed',
  });
  const [formSubmitting, setFormSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [slackBusy, setSlackBusy] = useState<ConnectorSlackBusy>(null);
  const [slackNotice, setSlackNotice] = useState<string | null>(null);
  const [slackError, setSlackError] = useState<string | null>(null);
  const refreshSeq = useRef(0);

  const refresh = useCallback(async () => {
    const seq = refreshSeq.current + 1;
    refreshSeq.current = seq;
    setStatus({ kind: 'loading' });
    try {
      const [nextChannels, nextDataConnectors, nextSlackInstalls] =
        await Promise.all([
          listWorkspaceChannels({ workspaceId }),
          listWorkspaceDataConnectors({ workspaceId }),
          listWorkspaceSlackInstalls({ workspaceId }),
        ]);
      if (seq !== refreshSeq.current) return;
      const byName = (
        a: { displayName: string },
        b: { displayName: string },
      ): number => a.displayName.localeCompare(b.displayName);
      setChannels([...nextChannels].sort(byName));
      setDataConnectors([...nextDataConnectors].sort(byName));
      setSlackInstalls(
        [...nextSlackInstalls].sort((a, b) =>
          a.teamName.localeCompare(b.teamName),
        ),
      );
      setStatus({ kind: 'ready' });
    } catch (err) {
      if (seq !== refreshSeq.current) return;
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setStatus({
        kind: 'error',
        message:
          err instanceof Error ? err.message : 'Failed to load connectors.',
      });
    }
  }, [onUnauthorized, workspaceId]);

  const handleConnectSlackWorkspace = async () => {
    setSlackBusy('connect');
    setSlackError(null);
    setSlackNotice(null);
    try {
      const launch = await connectWorkspaceSlackInstall({ workspaceId });
      const result = await launchSlackInstallPopup(launch.authorizationUrl);
      await refresh();
      setSlackNotice(
        result.teamName
          ? `Connected Slack workspace ${result.teamName}.`
          : 'Slack workspace connected.',
      );
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setSlackError(
        err instanceof Error
          ? err.message
          : 'Could not connect Slack workspace.',
      );
    } finally {
      setSlackBusy(null);
    }
  };

  const handleDisconnectSlackWorkspace = async (
    install: WorkspaceSlackInstall,
  ) => {
    if (install.boundChannelCount > 0) {
      const confirmed = window.confirm(
        `Disconnecting ${install.teamName} will leave ${install.boundChannelCount} channel${install.boundChannelCount === 1 ? '' : 's'} without a credential. Continue?`,
      );
      if (!confirmed) return;
    }
    setSlackBusy({ kind: 'delete', teamId: install.teamId });
    setSlackError(null);
    setSlackNotice(null);
    try {
      await deleteWorkspaceSlackInstall(install.teamId, { workspaceId });
      await refresh();
      setSlackNotice(`Disconnected Slack workspace ${install.teamName}.`);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setSlackError(
        err instanceof Error
          ? err.message
          : 'Could not disconnect Slack workspace.',
      );
    } finally {
      setSlackBusy(null);
    }
  };

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const closeModal = () => {
    setModal({ kind: 'closed' });
    setFormError(null);
    setFormSubmitting(false);
  };

  const handleSlackChannelsAdded = async (count: number) => {
    closeModal();
    await refresh();
    setSlackNotice(
      count === 0
        ? 'No new Slack channels were added.'
        : `Added ${count} Slack channel${count === 1 ? '' : 's'}.`,
    );
  };

  const handleCreateChannelSubmit = async (
    kind: ChannelKind,
    input: {
      displayName: string;
      config: Record<string, unknown>;
      apiKey?: string | null;
      rotateCredential?: boolean;
    },
  ) => {
    setFormSubmitting(true);
    setFormError(null);
    try {
      const created = await createWorkspaceChannel({
        workspaceId,
        kind,
        displayName: input.displayName,
        config: input.config,
      });
      if (input.rotateCredential && input.apiKey !== undefined) {
        await setWorkspaceChannelCredential({
          workspaceId,
          channelId: created.id,
          apiKey: input.apiKey,
        });
      }
      closeModal();
      await refresh();
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setFormError(
        err instanceof Error ? err.message : 'Failed to create channel.',
      );
    } finally {
      setFormSubmitting(false);
    }
  };

  const handleEditChannelSubmit = async (
    channel: WorkspaceChannel,
    input: {
      displayName: string;
      config: Record<string, unknown>;
      apiKey?: string | null;
      rotateCredential?: boolean;
    },
  ) => {
    setFormSubmitting(true);
    setFormError(null);
    try {
      await updateWorkspaceChannel({
        workspaceId,
        channelId: channel.id,
        displayName: input.displayName,
      });
      if (input.rotateCredential && input.apiKey !== undefined) {
        await setWorkspaceChannelCredential({
          workspaceId,
          channelId: channel.id,
          apiKey: input.apiKey,
        });
      }
      closeModal();
      await refresh();
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setFormError(
        err instanceof Error ? err.message : 'Failed to update channel.',
      );
    } finally {
      setFormSubmitting(false);
    }
  };

  const handleCreateDataConnectorSubmit = async (
    kind: DataConnectorKind,
    input: {
      displayName: string;
      config: Record<string, unknown>;
      apiKey?: string | null;
      rotateCredential?: boolean;
    },
  ) => {
    setFormSubmitting(true);
    setFormError(null);
    try {
      const created = await createWorkspaceDataConnector({
        workspaceId,
        kind,
        displayName: input.displayName,
        config: input.config,
      });
      if (input.rotateCredential && input.apiKey !== undefined) {
        await setWorkspaceDataConnectorCredential({
          workspaceId,
          connectorId: created.id,
          apiKey: input.apiKey,
        });
      }
      closeModal();
      await refresh();
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setFormError(
        err instanceof Error ? err.message : 'Failed to create data source.',
      );
    } finally {
      setFormSubmitting(false);
    }
  };

  const handleEditDataConnectorSubmit = async (
    dataConnector: WorkspaceDataConnector,
    input: {
      displayName: string;
      config: Record<string, unknown>;
      apiKey?: string | null;
      rotateCredential?: boolean;
    },
  ) => {
    setFormSubmitting(true);
    setFormError(null);
    try {
      await updateWorkspaceDataConnector({
        workspaceId,
        connectorId: dataConnector.id,
        displayName: input.displayName,
        config: input.config,
      });
      if (input.rotateCredential && input.apiKey !== undefined) {
        await setWorkspaceDataConnectorCredential({
          workspaceId,
          connectorId: dataConnector.id,
          apiKey: input.apiKey,
        });
      }
      closeModal();
      await refresh();
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setFormError(
        err instanceof Error ? err.message : 'Failed to update data source.',
      );
    } finally {
      setFormSubmitting(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (deleteState.kind === 'closed') return;
    setDeleteSubmitting(true);
    try {
      if (deleteState.kind === 'channel') {
        await deleteWorkspaceChannel(deleteState.channel.id, { workspaceId });
      } else {
        await deleteWorkspaceDataConnector(deleteState.dataConnector.id, {
          workspaceId,
        });
      }
      setDeleteState({ kind: 'closed' });
      await refresh();
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      // Surface as inline error on the list; close the modal so the user
      // can see it.
      setDeleteState({ kind: 'closed' });
      setStatus({
        kind: 'error',
        message:
          err instanceof Error ? err.message : 'Failed to delete connector.',
      });
    } finally {
      setDeleteSubmitting(false);
    }
  };

  const handleRetry = (): void => {
    setStatus({ kind: 'loading' });
    void refresh();
  };

  return (
    <ConnectorsSettingsPanel
      isAdmin={isAdmin}
      status={status}
      channels={channels}
      dataConnectors={dataConnectors}
      slackInstalls={slackInstalls}
      modal={modal}
      createKind={createKind}
      deleteState={deleteState}
      formSubmitting={formSubmitting}
      formError={formError}
      deleteSubmitting={deleteSubmitting}
      slackBusy={slackBusy}
      slackNotice={slackNotice}
      slackError={slackError}
      workspaceId={workspaceId}
      onRetry={handleRetry}
      onConnectSlackWorkspace={() => {
        void handleConnectSlackWorkspace();
      }}
      onDisconnectSlackWorkspace={(install) => {
        void handleDisconnectSlackWorkspace(install);
      }}
      onOpenCreateChannel={() => {
        setCreateKind('slack');
        setModal({ kind: 'create-channel' });
      }}
      onOpenEditChannel={(channel) => {
        setModal({ kind: 'edit-channel', channel });
      }}
      onOpenDeleteChannel={(channel) => {
        setDeleteState({ kind: 'channel', channel });
      }}
      onOpenCreateDataConnector={() => {
        setCreateKind('google_docs');
        setModal({ kind: 'create-data-connector' });
      }}
      onOpenEditDataConnector={(dataConnector) => {
        setModal({ kind: 'edit-data-connector', dataConnector });
      }}
      onOpenDeleteDataConnector={(dataConnector) => {
        setDeleteState({ kind: 'data-connector', dataConnector });
      }}
      onCloseModal={closeModal}
      onCreateKindChange={setCreateKind}
      onCreateChannel={handleCreateChannelSubmit}
      onEditChannel={handleEditChannelSubmit}
      onSlackChannelsAdded={handleSlackChannelsAdded}
      onCreateDataConnector={handleCreateDataConnectorSubmit}
      onEditDataConnector={handleEditDataConnectorSubmit}
      onCloseDelete={() => setDeleteState({ kind: 'closed' })}
      onConfirmDelete={() => {
        void handleConfirmDelete();
      }}
    />
  );
}
