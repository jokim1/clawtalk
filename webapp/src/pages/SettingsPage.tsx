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
  type WorkspaceChannel,
  type WorkspaceDataConnector,
  type WorkspaceSlackInstall,
  connectWorkspaceSlackInstall,
  createWorkspaceChannel,
  createWorkspaceDataConnector,
  deleteWorkspaceChannel,
  deleteWorkspaceDataConnector,
  deleteWorkspaceSlackInstall,
  getAiAgents,
  getMainRegisteredAgent,
  listRegisteredAgents,
  listWorkspaceChannels,
  listWorkspaceDataConnectors,
  listWorkspaceSlackInstalls,
  saveAiProviderCredential,
  setWorkspaceChannelCredential,
  setWorkspaceDataConnectorCredential,
  UnauthorizedError,
  updateMainRegisteredAgent,
  updateWorkspaceChannel,
  updateWorkspaceDataConnector,
  verifyAiProviderCredential,
} from '../lib/api';
import { launchSlackInstallPopup } from '../lib/slackInstallPopup';
import { ProfileSettingsPanel } from '../components/settings/ProfileSettingsPanel';
import {
  type ApiKeysSubTab,
  type ProviderDraft,
  ProviderConfigPanel,
  initProviderDrafts,
  projectProvider,
  draftKey,
} from '../components/settings/ProviderConfigPanel';
import { AiAgentsSettingsPanel } from '../components/settings/AiAgentsSettingsPanel';
import {
  ConnectorsSettingsPanel,
  type ConnectorDeleteState,
  type ConnectorListStatus,
  type ConnectorModalState,
  type ConnectorSlackBusy,
} from '../components/settings/ConnectorsSettingsPanel';
import { ToolsSettingsPanel } from '../components/settings/ToolsSettingsPanel';
import {
  settingsPageNavigation,
  useProviderSubscriptionOauth,
} from '../components/settings/useProviderSubscriptionOauth';

export { settingsPageNavigation };

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
        <ProfileSettingsPanel
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
        <ToolsSettingsPanel
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

// ─── API Keys tab ────────────────────────────────────────────────────

const PROVIDER_SAVE_POLL_DELAYS_MS = [
  1_500, 1_500, 2_500, 3_500, 5_000, 5_000, 5_000,
];

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
  const subscriptionOauth = useProviderSubscriptionOauth({
    onUnauthorized,
    workspaceId,
  });
  // Personal first — that's where members spend most of their time. Admins
  // still get the workspace tab; non-admins see it read-only (the existing
  // ProviderCredentialCard already enforces canManage=isAdmin for workspace
  // scope).
  const [subTab, setSubTab] = useState<ApiKeysSubTab>('personal');

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
        anthropicOauth={subscriptionOauth.anthropicOauth}
        openAiCodexOauth={subscriptionOauth.openAiCodexOauth}
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
          void subscriptionOauth.startAnthropicSubscription(scope, providerId)
        }
        onCompleteAnthropicSubscription={(scope, providerId) =>
          void subscriptionOauth.completeAnthropicSubscription(scope, providerId)
        }
        onCancelAnthropicSubscription={
          subscriptionOauth.cancelAnthropicSubscription
        }
        onAnthropicCodeDraftChange={(scope, providerId, codeDraft) =>
          subscriptionOauth.updateAnthropicCodeDraft(
            scope,
            providerId,
            codeDraft,
          )
        }
        onStartOpenAiCodexSubscription={(scope, providerId) =>
          void subscriptionOauth.startOpenAiCodexSubscription(scope, providerId)
        }
        onCancelOpenAiCodexSubscription={
          subscriptionOauth.cancelOpenAiCodexSubscription
        }
      />
    </>
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
