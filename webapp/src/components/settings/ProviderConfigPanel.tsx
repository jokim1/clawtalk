import {
  type AgentProviderCard,
  type ProviderCredentialScope,
  type ProviderVerificationStatus,
} from '../../lib/api';

export type ProviderDraft = {
  apiKey: string;
  showApiKey: boolean;
  expanded: boolean;
};

export type ApiKeysSubTab = 'personal' | 'workspace';

export type AnthropicSubscriptionOauthState = {
  busy: boolean;
  error: string | null;
  authorizeUrl: string | null;
  state: string | null;
  codeDraft: string;
  done: boolean;
};

export type OpenAiCodexSubscriptionOauthPending = {
  state: string;
  userCode: string;
  verificationUrl: string;
  pollIntervalSeconds: number;
};

export type OpenAiCodexSubscriptionOauthState = {
  busy: boolean;
  error: string | null;
  pending: OpenAiCodexSubscriptionOauthPending | null;
  polling: boolean;
};

type ProviderScopeView = {
  hasCredential: boolean;
  credentialHint: string | null;
  verificationStatus: ProviderVerificationStatus;
  lastVerifiedAt: string | null;
  lastVerificationError: string | null;
};

type ProviderConfigPanelProps = {
  providers: AgentProviderCard[];
  drafts: Record<string, ProviderDraft>;
  busyKey: string | null;
  subTab: ApiKeysSubTab;
  isAdmin: boolean;
  anthropicOauth: Record<string, AnthropicSubscriptionOauthState>;
  openAiCodexOauth: Record<string, OpenAiCodexSubscriptionOauthState>;
  onSubTabChange: (subTab: ApiKeysSubTab) => void;
  onDraftChange: (
    scope: ProviderCredentialScope,
    providerId: string,
    patch: Partial<ProviderDraft>,
  ) => void;
  onSave: (providerId: string, scope: ProviderCredentialScope) => void;
  onClear: (providerId: string, scope: ProviderCredentialScope) => void;
  onVerify: (providerId: string, scope: ProviderCredentialScope) => void;
  onConfigureAgents: () => void;
  onStartAnthropicSubscription: (
    scope: ProviderCredentialScope,
    providerId: string,
  ) => void;
  onCompleteAnthropicSubscription: (
    scope: ProviderCredentialScope,
    providerId: string,
  ) => void;
  onCancelAnthropicSubscription: (
    scope: ProviderCredentialScope,
    providerId: string,
  ) => void;
  onAnthropicCodeDraftChange: (
    scope: ProviderCredentialScope,
    providerId: string,
    codeDraft: string,
  ) => void;
  onStartOpenAiCodexSubscription: (
    scope: ProviderCredentialScope,
    providerId: string,
  ) => void;
  onCancelOpenAiCodexSubscription: (
    scope: ProviderCredentialScope,
    providerId: string,
  ) => void;
};

const PROVIDER_DOCS: Record<string, { url: string; label: string }> = {
  'provider.anthropic': {
    url: 'https://console.anthropic.com/settings/keys',
    label: 'Anthropic Console',
  },
  'provider.openai': {
    url: 'https://platform.openai.com/api-keys',
    label: 'OpenAI Platform',
  },
  'provider.gemini': {
    url: 'https://aistudio.google.com/app/apikey',
    label: 'Google AI Studio',
  },
  'provider.nvidia': {
    url: 'https://build.nvidia.com/',
    label: 'NVIDIA Build',
  },
};

const PROVIDER_KEY_PLACEHOLDER: Record<string, string> = {
  'provider.anthropic': 'sk-ant-...',
  'provider.openai': 'sk-...',
  'provider.gemini': 'AIza...',
  'provider.nvidia': 'nvapi-...',
};

export function draftKey(
  scope: ProviderCredentialScope,
  providerId: string,
): string {
  return `${scope}:${providerId}`;
}

export function projectProvider(
  provider: AgentProviderCard,
  scope: ProviderCredentialScope,
): ProviderScopeView {
  if (scope === 'workspace') {
    return {
      hasCredential: provider.workspaceHasCredential,
      credentialHint: provider.workspaceCredentialHint,
      verificationStatus: provider.workspaceVerificationStatus,
      lastVerifiedAt: provider.workspaceLastVerifiedAt,
      lastVerificationError: provider.workspaceLastVerificationError,
    };
  }
  return {
    hasCredential: provider.hasCredential,
    credentialHint: provider.credentialHint,
    verificationStatus: provider.verificationStatus,
    lastVerifiedAt: provider.lastVerifiedAt,
    lastVerificationError: provider.lastVerificationError,
  };
}

export function initProviderDrafts(
  providers: AgentProviderCard[],
): Record<string, ProviderDraft> {
  const drafts: Record<string, ProviderDraft> = {};
  for (const provider of providers) {
    drafts[draftKey('user', provider.id)] = emptyProviderDraft(
      provider,
      'user',
    );
    drafts[draftKey('workspace', provider.id)] = emptyProviderDraft(
      provider,
      'workspace',
    );
  }
  return drafts;
}

export function emptyProviderDraft(
  provider: AgentProviderCard,
  scope: ProviderCredentialScope,
): ProviderDraft {
  const view = projectProvider(provider, scope);
  return {
    apiKey: '',
    showApiKey: false,
    expanded: !view.hasCredential,
  };
}

export function emptyAnthropicSubscriptionOauthState(): AnthropicSubscriptionOauthState {
  return {
    busy: false,
    error: null,
    authorizeUrl: null,
    state: null,
    codeDraft: '',
    done: false,
  };
}

export function emptyOpenAiCodexSubscriptionOauthState(): OpenAiCodexSubscriptionOauthState {
  return {
    busy: false,
    error: null,
    pending: null,
    polling: false,
  };
}

export function ProviderConfigPanel({
  providers,
  drafts,
  busyKey,
  subTab,
  isAdmin,
  anthropicOauth,
  openAiCodexOauth,
  onSubTabChange,
  onDraftChange,
  onSave,
  onClear,
  onVerify,
  onConfigureAgents,
  onStartAnthropicSubscription,
  onCompleteAnthropicSubscription,
  onCancelAnthropicSubscription,
  onAnthropicCodeDraftChange,
  onStartOpenAiCodexSubscription,
  onCancelOpenAiCodexSubscription,
}: ProviderConfigPanelProps): JSX.Element {
  const personalTabId = 'api-keys-personal-tab';
  const workspaceTabId = 'api-keys-workspace-tab';
  const personalPanelId = 'api-keys-personal-panel';
  const workspacePanelId = 'api-keys-workspace-panel';

  return (
    <>
      <div
        className="settings-subtabs"
        role="tablist"
        aria-label="API keys scope"
      >
        <button
          type="button"
          role="tab"
          id={personalTabId}
          aria-selected={subTab === 'personal'}
          aria-controls={personalPanelId}
          className={
            subTab === 'personal'
              ? 'settings-subtab settings-subtab-active'
              : 'settings-subtab'
          }
          onClick={() => onSubTabChange('personal')}
        >
          Personal
        </button>
        <button
          type="button"
          role="tab"
          id={workspaceTabId}
          aria-selected={subTab === 'workspace'}
          aria-controls={workspacePanelId}
          className={
            subTab === 'workspace'
              ? 'settings-subtab settings-subtab-active'
              : 'settings-subtab'
          }
          onClick={() => onSubTabChange('workspace')}
        >
          Workspace
        </button>
      </div>

      {subTab === 'personal' ? (
        <ProviderScopePanel
          id={personalPanelId}
          labelledBy={personalTabId}
          scope="user"
          title="Personal API Keys"
          description="Personal keys override the workspace key when set. Use these when you want to bill against your own provider account."
          providers={providers}
          drafts={drafts}
          busyKey={busyKey}
          anthropicOauth={anthropicOauth}
          openAiCodexOauth={openAiCodexOauth}
          canManage
          onDraftChange={onDraftChange}
          onSave={onSave}
          onClear={onClear}
          onVerify={onVerify}
          onConfigureAgents={onConfigureAgents}
          onStartAnthropicSubscription={onStartAnthropicSubscription}
          onCompleteAnthropicSubscription={onCompleteAnthropicSubscription}
          onCancelAnthropicSubscription={onCancelAnthropicSubscription}
          onAnthropicCodeDraftChange={onAnthropicCodeDraftChange}
          onStartOpenAiCodexSubscription={onStartOpenAiCodexSubscription}
          onCancelOpenAiCodexSubscription={onCancelOpenAiCodexSubscription}
        />
      ) : (
        <ProviderScopePanel
          id={workspacePanelId}
          labelledBy={workspaceTabId}
          scope="workspace"
          title="Workspace API Keys"
          description={
            isAdmin
              ? "Workspace-shared keys are visible to every member and used when a member hasn't supplied a personal key of their own. Set them here as the workspace admin."
              : "Workspace-shared keys are visible to every member and used when a member hasn't supplied a personal key of their own. Only workspace admins can change these."
          }
          providers={providers}
          drafts={drafts}
          busyKey={busyKey}
          anthropicOauth={anthropicOauth}
          openAiCodexOauth={openAiCodexOauth}
          canManage={isAdmin}
          onDraftChange={onDraftChange}
          onSave={onSave}
          onClear={onClear}
          onVerify={onVerify}
          onConfigureAgents={onConfigureAgents}
          onStartAnthropicSubscription={onStartAnthropicSubscription}
          onCompleteAnthropicSubscription={onCompleteAnthropicSubscription}
          onCancelAnthropicSubscription={onCancelAnthropicSubscription}
          onAnthropicCodeDraftChange={onAnthropicCodeDraftChange}
          onStartOpenAiCodexSubscription={onStartOpenAiCodexSubscription}
          onCancelOpenAiCodexSubscription={onCancelOpenAiCodexSubscription}
        />
      )}
    </>
  );
}

function ProviderScopePanel({
  id,
  labelledBy,
  scope,
  title,
  description,
  providers,
  drafts,
  busyKey,
  anthropicOauth,
  openAiCodexOauth,
  canManage,
  onDraftChange,
  onSave,
  onClear,
  onVerify,
  onConfigureAgents,
  onStartAnthropicSubscription,
  onCompleteAnthropicSubscription,
  onCancelAnthropicSubscription,
  onAnthropicCodeDraftChange,
  onStartOpenAiCodexSubscription,
  onCancelOpenAiCodexSubscription,
}: {
  id: string;
  labelledBy: string;
  scope: ProviderCredentialScope;
  title: string;
  description: string;
  providers: AgentProviderCard[];
  drafts: Record<string, ProviderDraft>;
  busyKey: string | null;
  anthropicOauth: Record<string, AnthropicSubscriptionOauthState>;
  openAiCodexOauth: Record<string, OpenAiCodexSubscriptionOauthState>;
  canManage: boolean;
  onDraftChange: (
    scope: ProviderCredentialScope,
    providerId: string,
    patch: Partial<ProviderDraft>,
  ) => void;
  onSave: (providerId: string, scope: ProviderCredentialScope) => void;
  onClear: (providerId: string, scope: ProviderCredentialScope) => void;
  onVerify: (providerId: string, scope: ProviderCredentialScope) => void;
  onConfigureAgents: () => void;
  onStartAnthropicSubscription: (
    scope: ProviderCredentialScope,
    providerId: string,
  ) => void;
  onCompleteAnthropicSubscription: (
    scope: ProviderCredentialScope,
    providerId: string,
  ) => void;
  onCancelAnthropicSubscription: (
    scope: ProviderCredentialScope,
    providerId: string,
  ) => void;
  onAnthropicCodeDraftChange: (
    scope: ProviderCredentialScope,
    providerId: string,
    codeDraft: string,
  ) => void;
  onStartOpenAiCodexSubscription: (
    scope: ProviderCredentialScope,
    providerId: string,
  ) => void;
  onCancelOpenAiCodexSubscription: (
    scope: ProviderCredentialScope,
    providerId: string,
  ) => void;
}): JSX.Element {
  return (
    <section
      className="settings-card"
      role="tabpanel"
      id={id}
      aria-labelledby={labelledBy}
    >
      <h2>{title}</h2>
      <p className="settings-copy">{description}</p>

      {providers.length === 0 ? (
        <p className="settings-copy">
          No providers are enabled for this workspace.
        </p>
      ) : (
        <div className="talk-llm-card-list">
          {providers.map((provider) => (
            <ProviderCredentialCard
              key={`${scope}:${provider.id}`}
              scope={scope}
              provider={provider}
              draft={
                drafts[draftKey(scope, provider.id)] ||
                emptyProviderDraft(provider, scope)
              }
              canManage={canManage}
              busySave={busyKey === `save:${scope}:${provider.id}`}
              busyVerify={busyKey === `verify:${scope}:${provider.id}`}
              anthropicOauth={
                anthropicOauth[draftKey(scope, provider.id)] ||
                emptyAnthropicSubscriptionOauthState()
              }
              openAiCodexOauth={
                openAiCodexOauth[draftKey(scope, provider.id)] ||
                emptyOpenAiCodexSubscriptionOauthState()
              }
              onDraftChange={(patch) =>
                onDraftChange(scope, provider.id, patch)
              }
              onSave={() => onSave(provider.id, scope)}
              onClear={() => onClear(provider.id, scope)}
              onVerify={() => onVerify(provider.id, scope)}
              onConfigureAgents={onConfigureAgents}
              onStartAnthropicSubscription={() =>
                onStartAnthropicSubscription(scope, provider.id)
              }
              onCompleteAnthropicSubscription={() =>
                onCompleteAnthropicSubscription(scope, provider.id)
              }
              onCancelAnthropicSubscription={() =>
                onCancelAnthropicSubscription(scope, provider.id)
              }
              onAnthropicCodeDraftChange={(codeDraft) =>
                onAnthropicCodeDraftChange(scope, provider.id, codeDraft)
              }
              onStartOpenAiCodexSubscription={() =>
                onStartOpenAiCodexSubscription(scope, provider.id)
              }
              onCancelOpenAiCodexSubscription={() =>
                onCancelOpenAiCodexSubscription(scope, provider.id)
              }
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ProviderCredentialCard({
  scope,
  provider,
  draft,
  canManage,
  busySave,
  busyVerify,
  anthropicOauth,
  openAiCodexOauth,
  onDraftChange,
  onSave,
  onClear,
  onVerify,
  onConfigureAgents,
  onStartAnthropicSubscription,
  onCompleteAnthropicSubscription,
  onCancelAnthropicSubscription,
  onAnthropicCodeDraftChange,
  onStartOpenAiCodexSubscription,
  onCancelOpenAiCodexSubscription,
}: {
  scope: ProviderCredentialScope;
  provider: AgentProviderCard;
  draft: ProviderDraft;
  canManage: boolean;
  busySave: boolean;
  busyVerify: boolean;
  anthropicOauth: AnthropicSubscriptionOauthState;
  openAiCodexOauth: OpenAiCodexSubscriptionOauthState;
  onDraftChange: (patch: Partial<ProviderDraft>) => void;
  onSave: () => void;
  onClear: () => void;
  onVerify: () => void;
  onConfigureAgents: () => void;
  onStartAnthropicSubscription: () => void;
  onCompleteAnthropicSubscription: () => void;
  onCancelAnthropicSubscription: () => void;
  onAnthropicCodeDraftChange: (codeDraft: string) => void;
  onStartOpenAiCodexSubscription: () => void;
  onCancelOpenAiCodexSubscription: () => void;
}): JSX.Element {
  const view = projectProvider(provider, scope);
  const docs = PROVIDER_DOCS[provider.id];
  const modelCount = provider.modelSuggestions.length;
  const placeholder = PROVIDER_KEY_PLACEHOLDER[provider.id] || 'sk-...';
  const disabled = !canManage || busySave || busyVerify;
  const scopeLabel = scope === 'workspace' ? 'workspace' : 'personal';
  const showApiKeySection = provider.credentialMode !== 'subscription_only';

  return (
    <article className="talk-llm-card">
      <div className="talk-llm-card-header">
        <div>
          <h4>{provider.name}</h4>
          <p className="talk-llm-meta">
            {docs ? (
              <a href={docs.url} target="_blank" rel="noreferrer">
                Get key from {docs.label}
              </a>
            ) : showApiKeySection ? (
              'Configure an API key to use this provider in talks.'
            ) : (
              'Subscription-only provider — connect via OAuth below.'
            )}
          </p>
        </div>
        {showApiKeySection ? (
          <span className={verificationChipClass(view.verificationStatus)}>
            {formatVerification(view.verificationStatus)}
          </span>
        ) : null}
      </div>

      {showApiKeySection && view.hasCredential ? (
        <div className="talk-llm-stored-key">
          <div>
            <strong>{view.credentialHint || 'Stored in settings'}</strong>
            <p className="talk-llm-meta">
              Last verified {formatDateTime(view.lastVerifiedAt)}
            </p>
            {view.lastVerificationError ? (
              <p className="talk-llm-meta">{view.lastVerificationError}</p>
            ) : null}
            {modelCount > 0 ? (
              <p className="talk-llm-meta">
                {modelCount} model{modelCount === 1 ? '' : 's'} available
                {provider.liveModelDiscovery?.status === 'ok'
                  ? ' (live + curated)'
                  : ''}
                {' — '}
                <button
                  type="button"
                  className="talk-llm-link-button"
                  onClick={onConfigureAgents}
                >
                  Configure agents →
                </button>
              </p>
            ) : null}
          </div>
          {canManage ? (
            <button
              type="button"
              className="icon-btn danger-btn"
              onClick={onClear}
              disabled={disabled}
              aria-label={`Delete ${provider.name} ${scopeLabel} credential`}
            >
              ×
            </button>
          ) : null}
        </div>
      ) : null}

      {showApiKeySection && canManage ? (
        <details
          className="talk-llm-update-disclosure"
          open={draft.expanded}
          onToggle={(event) =>
            onDraftChange({
              expanded: (event.currentTarget as HTMLDetailsElement).open,
            })
          }
        >
          <summary>{view.hasCredential ? 'Update key' : 'Configure'}</summary>
          <div className="talk-llm-grid">
            <label className="talk-llm-field-span">
              <span>API key</span>
              <div className="talk-llm-secret-input">
                <input
                  type={draft.showApiKey ? 'text' : 'password'}
                  value={draft.apiKey}
                  placeholder={placeholder}
                  onChange={(event) =>
                    onDraftChange({ apiKey: event.target.value })
                  }
                  disabled={disabled}
                />
                <button
                  type="button"
                  className="talk-llm-eye-toggle"
                  onClick={() =>
                    onDraftChange({ showApiKey: !draft.showApiKey })
                  }
                  disabled={disabled}
                  aria-label={
                    draft.showApiKey
                      ? `Hide ${provider.name} API key`
                      : `Show ${provider.name} API key`
                  }
                >
                  {draft.showApiKey ? 'Hide' : 'Show'}
                </button>
              </div>
            </label>
            {provider.id === 'provider.nvidia' ? (
              <p className="talk-llm-meta talk-llm-field-span">
                On NVIDIA Build, click <strong>Generate API Key</strong>, then
                copy the <code>nvapi-…</code> token from the Python snippet (it
                appears in the <code>Authorization</code> header).
              </p>
            ) : null}
            <div className="talk-llm-inline-actions">
              <button
                type="button"
                className="primary-btn"
                onClick={onSave}
                disabled={disabled || !draft.apiKey.trim()}
              >
                {busySave ? 'Saving…' : view.hasCredential ? 'Update' : 'Save'}
              </button>
              {view.hasCredential ? (
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={onVerify}
                  disabled={disabled}
                >
                  {busyVerify ? 'Verifying…' : 'Re-verify'}
                </button>
              ) : null}
            </div>
          </div>
        </details>
      ) : null}

      {provider.id === 'provider.anthropic' ? (
        <AnthropicSubscriptionSection
          scope={scope}
          provider={provider}
          canManage={canManage}
          oauth={anthropicOauth}
          onConnect={onStartAnthropicSubscription}
          onComplete={onCompleteAnthropicSubscription}
          onCancel={onCancelAnthropicSubscription}
          onCodeDraftChange={onAnthropicCodeDraftChange}
        />
      ) : null}
      {provider.id === 'provider.openai_codex' ? (
        <OpenAiCodexSubscriptionSection
          scope={scope}
          provider={provider}
          canManage={canManage}
          oauth={openAiCodexOauth}
          onConnect={onStartOpenAiCodexSubscription}
          onCancel={onCancelOpenAiCodexSubscription}
        />
      ) : null}
    </article>
  );
}

function AnthropicSubscriptionSection({
  scope,
  provider,
  canManage,
  oauth,
  onConnect,
  onComplete,
  onCancel,
  onCodeDraftChange,
}: {
  scope: ProviderCredentialScope;
  provider: AgentProviderCard;
  canManage: boolean;
  oauth: AnthropicSubscriptionOauthState;
  onConnect: () => void;
  onComplete: () => void;
  onCancel: () => void;
  onCodeDraftChange: (codeDraft: string) => void;
}): JSX.Element {
  const hasSubscription =
    scope === 'workspace'
      ? provider.hasWorkspaceSubscription
      : provider.hasPersonalSubscription;
  const expiresAt =
    scope === 'workspace'
      ? provider.workspaceSubscriptionExpiresAt
      : provider.personalSubscriptionExpiresAt;

  return (
    <section
      style={{
        marginTop: '1rem',
        paddingTop: '0.75rem',
        borderTop: '1px solid var(--border-color, #e3eaf5)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div>
          <strong>Claude subscription</strong>
          <p className="talk-llm-meta">
            {hasSubscription
              ? `Connected · refreshes automatically${
                  expiresAt
                    ? ` (current token expires ${formatDateTime(expiresAt)})`
                    : ''
                }`
              : 'Connect a Claude Pro or Max account so this provider works without a console API key.'}
          </p>
        </div>
        {canManage && !oauth.authorizeUrl && !oauth.done ? (
          <button
            type="button"
            className="secondary-btn"
            onClick={onConnect}
            disabled={oauth.busy}
          >
            {oauth.busy
              ? 'Starting…'
              : hasSubscription
                ? 'Reconnect with Claude'
                : 'Connect with Claude'}
          </button>
        ) : null}
      </div>
      {oauth.authorizeUrl && !oauth.done ? (
        <div className="talk-llm-grid" style={{ marginTop: '0.5rem' }}>
          <p className="talk-llm-meta">
            A new tab opened to{' '}
            <a href={oauth.authorizeUrl} target="_blank" rel="noreferrer">
              claude.ai
            </a>
            . Sign in and approve access, then paste the code shown on{' '}
            <code>console.anthropic.com</code> back here.
          </p>
          <label className="talk-llm-field-span">
            <span>Paste the code (or full code#state blob)</span>
            <input
              type="text"
              value={oauth.codeDraft}
              onChange={(event) => onCodeDraftChange(event.target.value)}
              placeholder="…#…"
              disabled={oauth.busy}
            />
          </label>
          <div className="talk-llm-inline-actions">
            <button
              type="button"
              className="primary-btn"
              onClick={onComplete}
              disabled={oauth.busy || !oauth.codeDraft.trim()}
            >
              {oauth.busy ? 'Completing…' : 'Complete connection'}
            </button>
            <button
              type="button"
              className="secondary-btn"
              onClick={onCancel}
              disabled={oauth.busy}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {oauth.error ? (
        <p className="talk-llm-meta error-text" role="alert">
          {oauth.error}
        </p>
      ) : null}
    </section>
  );
}

function OpenAiCodexSubscriptionSection({
  scope,
  provider,
  canManage,
  oauth,
  onConnect,
  onCancel,
}: {
  scope: ProviderCredentialScope;
  provider: AgentProviderCard;
  canManage: boolean;
  oauth: OpenAiCodexSubscriptionOauthState;
  onConnect: () => void;
  onCancel: () => void;
}): JSX.Element {
  const hasSubscription =
    scope === 'workspace'
      ? provider.hasWorkspaceSubscription
      : provider.hasPersonalSubscription;
  const expiresAt =
    scope === 'workspace'
      ? provider.workspaceSubscriptionExpiresAt
      : provider.personalSubscriptionExpiresAt;

  const statusMessage = oauth.error
    ? 'Polling stopped. Restart connection to try again.'
    : oauth.polling
      ? 'Waiting for you to authorize on OpenAI… this page refreshes when done.'
      : 'Ready.';

  return (
    <section
      style={{
        marginTop: '1rem',
        paddingTop: '0.75rem',
        borderTop: '1px solid var(--border-color, #e3eaf5)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div>
          <strong>ChatGPT subscription</strong>
          <p className="talk-llm-meta">
            {hasSubscription
              ? `Connected · refreshes automatically${
                  expiresAt
                    ? ` (current token expires ${formatDateTime(expiresAt)})`
                    : ''
                }`
              : 'Connect a ChatGPT Plus or Pro account. Note: inference adapter for Codex Responses is still in progress — auth lands here first.'}
          </p>
        </div>
        {canManage && !oauth.pending ? (
          <button
            type="button"
            className="secondary-btn"
            onClick={onConnect}
            disabled={oauth.busy}
          >
            {oauth.busy
              ? 'Starting…'
              : hasSubscription
                ? 'Reconnect with ChatGPT'
                : 'Connect with ChatGPT'}
          </button>
        ) : null}
      </div>
      {oauth.pending ? (
        <div
          className="talk-llm-grid"
          style={{ marginTop: '0.5rem', gap: '0.5rem' }}
        >
          <p className="talk-llm-meta">
            Open{' '}
            <a
              href={oauth.pending.verificationUrl}
              target="_blank"
              rel="noreferrer"
            >
              {oauth.pending.verificationUrl}
            </a>{' '}
            and enter this code:
          </p>
          <div
            style={{
              fontSize: '1.5rem',
              fontFamily: 'monospace',
              letterSpacing: '0.25rem',
              padding: '0.5rem',
              background: 'var(--surface-alt, #f3f6fb)',
              borderRadius: '6px',
              textAlign: 'center',
            }}
          >
            {oauth.pending.userCode}
          </div>
          <p className="talk-llm-meta">{statusMessage}</p>
          <div className="talk-llm-inline-actions">
            <button type="button" className="secondary-btn" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {oauth.error ? (
        <p className="talk-llm-meta error-text" role="alert">
          {oauth.error}
        </p>
      ) : null}
    </section>
  );
}

function formatDateTime(value: string | null): string {
  if (!value) return 'Never';
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toLocaleString();
}

function formatVerification(status: ProviderVerificationStatus): string {
  switch (status) {
    case 'verified':
      return 'Verified';
    case 'invalid':
      return 'Invalid';
    case 'verifying':
      return 'Verifying…';
    case 'rate_limited':
      return 'Rate limited';
    case 'unavailable':
      return 'Unavailable';
    case 'not_verified':
      return 'Needs verification';
    case 'missing':
    default:
      return 'Not configured';
  }
}

function verificationChipClass(status: ProviderVerificationStatus): string {
  switch (status) {
    case 'verified':
      return 'talk-agent-chip talk-agent-chip-success';
    case 'invalid':
      return 'talk-agent-chip talk-agent-chip-error';
    case 'unavailable':
    case 'rate_limited':
      return 'talk-agent-chip talk-agent-chip-warning';
    default:
      return 'talk-agent-chip';
  }
}
