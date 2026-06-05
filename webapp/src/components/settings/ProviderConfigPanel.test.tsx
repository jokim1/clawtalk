import { useState } from 'react';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentProviderCard, ProviderCredentialScope } from '../../lib/api';
import {
  ProviderConfigPanel,
  draftKey,
  emptyProviderDraft,
  initProviderDrafts,
  type AnthropicSubscriptionOauthState,
  type ApiKeysSubTab,
  type OpenAiCodexSubscriptionOauthState,
  type ProviderDraft,
} from './ProviderConfigPanel';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ProviderConfigPanel', () => {
  it('routes personal and workspace credential edits through scoped page-owned callbacks', async () => {
    const user = userEvent.setup();
    const provider = buildProvider({
      id: 'provider.anthropic',
      name: 'Claude (Anthropic)',
    });
    const harness = renderProviderConfigHarness({
      providers: [provider],
      isAdmin: true,
    });

    const personalSection = screen
      .getByRole('heading', { name: 'Personal API Keys' })
      .closest('section');
    if (!personalSection) throw new Error('personal section missing');
    fireEvent.change(
      within(personalSection).getByPlaceholderText('sk-ant-...'),
      {
        target: { value: 'sk-ant-personal' },
      },
    );
    await user.click(
      within(personalSection).getByRole('button', { name: 'Save' }),
    );

    await user.click(screen.getByRole('tab', { name: 'Workspace' }));
    const workspaceSection = screen
      .getByRole('heading', { name: 'Workspace API Keys' })
      .closest('section');
    if (!workspaceSection) throw new Error('workspace section missing');
    fireEvent.change(
      within(workspaceSection).getByPlaceholderText('sk-ant-...'),
      {
        target: { value: 'sk-ant-workspace' },
      },
    );
    await user.click(
      within(workspaceSection).getByRole('button', { name: 'Save' }),
    );

    expect(harness.onDraftChange).toHaveBeenCalledWith(
      'user',
      'provider.anthropic',
      { apiKey: 'sk-ant-personal' },
    );
    expect(harness.onDraftChange).toHaveBeenCalledWith(
      'workspace',
      'provider.anthropic',
      { apiKey: 'sk-ant-workspace' },
    );
    expect(harness.onSave).toHaveBeenNthCalledWith(
      1,
      'provider.anthropic',
      'user',
    );
    expect(harness.onSave).toHaveBeenNthCalledWith(
      2,
      'provider.anthropic',
      'workspace',
    );

    await user.click(screen.getByRole('tab', { name: 'Personal' }));
    expect(screen.getByDisplayValue('sk-ant-personal')).toBeInTheDocument();
  });

  it('keeps workspace credentials admin-only while personal credentials stay editable', async () => {
    const user = userEvent.setup();
    const provider = buildOpenAiProvider({
      hasCredential: false,
      workspaceHasCredential: true,
      workspaceCredentialHint: 'workspace key',
      workspaceVerificationStatus: 'verified',
      workspaceLastVerifiedAt: '2026-05-16T12:00:00.000Z',
    });
    renderProviderConfigHarness({
      providers: [provider],
      isAdmin: false,
    });

    const personalSection = screen
      .getByRole('heading', { name: 'Personal API Keys' })
      .closest('section');
    if (!personalSection) throw new Error('personal section missing');
    expect(
      within(personalSection).getByPlaceholderText('sk-...'),
    ).toBeEnabled();

    await user.click(screen.getByRole('tab', { name: 'Workspace' }));
    const workspaceSection = screen
      .getByRole('heading', { name: 'Workspace API Keys' })
      .closest('section');
    if (!workspaceSection) throw new Error('workspace section missing');
    expect(
      within(workspaceSection).getByText(
        /Only workspace admins can change these/,
      ),
    ).toBeInTheDocument();
    expect(
      within(workspaceSection).getByText('workspace key'),
    ).toBeInTheDocument();
    expect(
      within(workspaceSection).queryByPlaceholderText('sk-...'),
    ).not.toBeInTheDocument();
    expect(
      within(workspaceSection).queryByRole('button', {
        name: 'Delete OpenAI workspace credential',
      }),
    ).not.toBeInTheDocument();

    cleanup();
    renderProviderConfigHarness({
      providers: [provider],
      isAdmin: true,
      initialSubTab: 'workspace',
    });
    const adminWorkspaceSection = screen
      .getByRole('heading', { name: 'Workspace API Keys' })
      .closest('section');
    if (!adminWorkspaceSection) throw new Error('workspace section missing');
    expect(
      within(adminWorkspaceSection).getByRole('button', {
        name: 'Delete OpenAI workspace credential',
      }),
    ).toBeInTheDocument();
  });

  it('threads Anthropic OAuth authorization state and code edits through the active scope', async () => {
    const user = userEvent.setup();
    const provider = buildProvider({
      id: 'provider.anthropic',
      name: 'Claude (Anthropic)',
    });
    const key = draftKey('workspace', provider.id);
    const harness = renderProviderConfigHarness({
      providers: [provider],
      isAdmin: true,
      initialSubTab: 'workspace',
      anthropicOauth: {
        [key]: {
          busy: false,
          error: null,
          authorizeUrl: 'https://claude.example/oauth',
          state: 'oauth-state',
          codeDraft: '',
          done: false,
        },
      },
    });

    const workspaceSection = screen
      .getByRole('heading', { name: 'Workspace API Keys' })
      .closest('section');
    if (!workspaceSection) throw new Error('workspace section missing');
    expect(
      within(workspaceSection).getByRole('link', { name: 'claude.ai' }),
    ).toHaveAttribute('href', 'https://claude.example/oauth');
    const completeButton = within(workspaceSection).getByRole('button', {
      name: 'Complete connection',
    });
    expect(completeButton).toBeDisabled();

    await user.type(
      within(workspaceSection).getByLabelText(
        'Paste the code (or full code#state blob)',
      ),
      'code#state',
    );
    expect(harness.onAnthropicCodeDraftChange).toHaveBeenLastCalledWith(
      'workspace',
      'provider.anthropic',
      'code#state',
    );
    expect(completeButton).toBeEnabled();

    await user.click(completeButton);
    await user.click(
      within(workspaceSection).getByRole('button', { name: 'Cancel' }),
    );
    expect(harness.onCompleteAnthropicSubscription).toHaveBeenCalledWith(
      'workspace',
      'provider.anthropic',
    );
    expect(harness.onCancelAnthropicSubscription).toHaveBeenCalledWith(
      'workspace',
      'provider.anthropic',
    );
  });

  it('initializes distinct personal and workspace drafts from each credential scope', () => {
    const provider = buildOpenAiProvider({
      hasCredential: true,
      workspaceHasCredential: false,
    });

    expect(initProviderDrafts([provider])).toMatchObject({
      [draftKey('user', provider.id)]: {
        apiKey: '',
        showApiKey: false,
        expanded: false,
      },
      [draftKey('workspace', provider.id)]: {
        apiKey: '',
        showApiKey: false,
        expanded: true,
      },
    });
  });
});

function renderProviderConfigHarness(options: {
  providers: AgentProviderCard[];
  isAdmin: boolean;
  initialSubTab?: ApiKeysSubTab;
  drafts?: Record<string, ProviderDraft>;
  anthropicOauth?: Record<string, AnthropicSubscriptionOauthState>;
  openAiCodexOauth?: Record<string, OpenAiCodexSubscriptionOauthState>;
}) {
  const onDraftChange = vi.fn();
  const onSave = vi.fn();
  const onClear = vi.fn();
  const onVerify = vi.fn();
  const onConfigureAgents = vi.fn();
  const onStartAnthropicSubscription = vi.fn();
  const onCompleteAnthropicSubscription = vi.fn();
  const onCancelAnthropicSubscription = vi.fn();
  const onAnthropicCodeDraftChange = vi.fn();
  const onStartOpenAiCodexSubscription = vi.fn();
  const onCancelOpenAiCodexSubscription = vi.fn();

  function Harness() {
    const [subTab, setSubTab] = useState<ApiKeysSubTab>(
      options.initialSubTab ?? 'personal',
    );
    const [drafts, setDrafts] = useState<Record<string, ProviderDraft>>({
      ...initProviderDrafts(options.providers),
      ...(options.drafts ?? {}),
    });
    const [anthropicOauth, setAnthropicOauth] = useState<
      Record<string, AnthropicSubscriptionOauthState>
    >(options.anthropicOauth ?? {});

    const handleDraftChange = (
      scope: ProviderCredentialScope,
      providerId: string,
      patch: Partial<ProviderDraft>,
    ) => {
      onDraftChange(scope, providerId, patch);
      setDrafts((current) => {
        const key = draftKey(scope, providerId);
        const provider = options.providers.find(
          (entry) => entry.id === providerId,
        );
        if (!provider) return current;
        return {
          ...current,
          [key]: {
            ...(current[key] ?? emptyProviderDraft(provider, scope)),
            ...patch,
          },
        };
      });
    };

    const handleAnthropicCodeDraftChange = (
      scope: ProviderCredentialScope,
      providerId: string,
      codeDraft: string,
    ) => {
      onAnthropicCodeDraftChange(scope, providerId, codeDraft);
      setAnthropicOauth((current) => {
        const key = draftKey(scope, providerId);
        const existing = current[key];
        if (!existing) return current;
        return {
          ...current,
          [key]: {
            ...existing,
            codeDraft,
          },
        };
      });
    };

    return (
      <ProviderConfigPanel
        providers={options.providers}
        drafts={drafts}
        busyKey={null}
        subTab={subTab}
        isAdmin={options.isAdmin}
        anthropicOauth={anthropicOauth}
        openAiCodexOauth={options.openAiCodexOauth ?? {}}
        onSubTabChange={setSubTab}
        onDraftChange={handleDraftChange}
        onSave={onSave}
        onClear={onClear}
        onVerify={onVerify}
        onConfigureAgents={onConfigureAgents}
        onStartAnthropicSubscription={onStartAnthropicSubscription}
        onCompleteAnthropicSubscription={onCompleteAnthropicSubscription}
        onCancelAnthropicSubscription={onCancelAnthropicSubscription}
        onAnthropicCodeDraftChange={handleAnthropicCodeDraftChange}
        onStartOpenAiCodexSubscription={onStartOpenAiCodexSubscription}
        onCancelOpenAiCodexSubscription={onCancelOpenAiCodexSubscription}
      />
    );
  }

  render(<Harness />);

  return {
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
  };
}

function buildProvider(
  overrides?: Partial<AgentProviderCard>,
): AgentProviderCard {
  return {
    id: 'provider.anthropic',
    name: 'Claude (Anthropic)',
    providerKind: 'anthropic',
    credentialMode: 'api_key',
    apiFormat: 'anthropic_messages',
    baseUrl: 'https://api.anthropic.com',
    authScheme: 'x_api_key',
    enabled: true,
    hasCredential: false,
    credentialHint: null,
    verificationStatus: 'missing',
    lastVerifiedAt: null,
    lastVerificationError: null,
    workspaceHasCredential: false,
    workspaceCredentialHint: null,
    workspaceVerificationStatus: 'missing',
    workspaceLastVerifiedAt: null,
    workspaceLastVerificationError: null,
    hasPersonalSubscription: false,
    personalSubscriptionExpiresAt: null,
    hasWorkspaceSubscription: false,
    workspaceSubscriptionExpiresAt: null,
    modelSuggestions: [
      {
        modelId: 'claude-sonnet-4-6',
        displayName: 'Claude Sonnet 4.6',
        contextWindowTokens: 200000,
        defaultMaxOutputTokens: 8192,
      },
    ],
    ...overrides,
  };
}

function buildOpenAiProvider(
  overrides?: Partial<AgentProviderCard>,
): AgentProviderCard {
  return buildProvider({
    id: 'provider.openai',
    name: 'OpenAI',
    providerKind: 'openai',
    apiFormat: 'openai_chat_completions',
    baseUrl: 'https://api.openai.com/v1',
    authScheme: 'bearer',
    modelSuggestions: [
      {
        modelId: 'gpt-4.1',
        displayName: 'GPT-4.1',
        contextWindowTokens: 1047576,
        defaultMaxOutputTokens: 32768,
      },
    ],
    ...overrides,
  });
}
