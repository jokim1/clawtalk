import { useEffect, useState } from 'react';

import {
  clearWebSearchCredential,
  connectUserGoogleAccount,
  disconnectUserGoogleAccount,
  expandUserGoogleScopes,
  getUserGoogleAccount,
  getWebSearchProviders,
  setActiveWebSearchProvider,
  setWebSearchCredential,
  UnauthorizedError,
  type UserGoogleAccount,
  type WebSearchPageData,
  type WebSearchProviderId,
} from '../../lib/api';
import { launchGoogleAccountPopup } from '../../lib/googleAccountPopup';

const REQUIRED_GOOGLE_TOOL_SCOPES = [
  'drive.readonly',
  'documents',
  'spreadsheets',
];

function isGoogleToolsEnabled(): boolean {
  return import.meta.env.VITE_GOOGLE_TOOLS_ENABLED === 'true';
}

type ToolsSettingsPanelProps = {
  onUnauthorized: () => void;
  workspaceId?: string | null;
};

export function ToolsSettingsPanel({
  onUnauthorized,
  workspaceId,
}: ToolsSettingsPanelProps): JSX.Element {
  return (
    <div className="settings-salon-panel settings-tools-panel">
      <section className="settings-tools-summary" aria-label="Tools overview">
        <div>
          <span>Tool catalog</span>
          <strong>Web + Workspace</strong>
          <em>Keys and OAuth live here</em>
        </div>
        <div>
          <span>Talk controls</span>
          <strong>Per-talk toggles</strong>
          <em>Agents inherit enabled integrations</em>
        </div>
        <div>
          <span>Provider family</span>
          <strong>Web search</strong>
          <em>Provider selected per account</em>
        </div>
      </section>
      {isGoogleToolsEnabled() ? (
        <GoogleAccountSection
          onUnauthorized={onUnauthorized}
          workspaceId={workspaceId}
        />
      ) : null}
      <WebSearchProvidersSection onUnauthorized={onUnauthorized} />
    </div>
  );
}

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
      className="settings-card settings-section settings-tools-section"
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
        <div className="settings-nested-card">
          <p>Select a workspace before connecting Google tools.</p>
        </div>
      ) : loading ? (
        <p>Loading…</p>
      ) : account?.connected ? (
        <div className="settings-nested-card">
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
        <div className="settings-nested-card">
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
