import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentProviderCard,
  ExecutorSettings,
  RegisteredAgent,
} from '../../lib/api';

const { registeredAgentsPanelMock } = vi.hoisted(() => ({
  registeredAgentsPanelMock: vi.fn(),
}));

vi.mock('../RegisteredAgentsPanel', () => ({
  RegisteredAgentsPanel: (props: Record<string, unknown>) => {
    registeredAgentsPanelMock(props);
    return <div data-testid="registered-agents-panel" />;
  },
}));

import { AiAgentsSettingsPanel } from './AiAgentsSettingsPanel';

afterEach(() => {
  cleanup();
  registeredAgentsPanelMock.mockClear();
});

describe('AiAgentsSettingsPanel', () => {
  it('keeps the registered-agents surface presentationally wired through the settings panel', () => {
    const providers = [buildProvider()];
    const executorSettings = buildExecutorSettings();
    const onUnauthorized = vi.fn();
    const onAgentsChanged = vi.fn();

    render(
      <AiAgentsSettingsPanel
        providers={providers}
        executorSettings={executorSettings}
        agents={buildAgents()}
        mainAgentId="agent-main"
        mainAgentDraft="agent-research"
        canManage={false}
        busy={false}
        workspaceId="workspace-1"
        onUnauthorized={onUnauthorized}
        onAgentsChanged={onAgentsChanged}
        onMainAgentDraftChange={() => undefined}
        onSaveMainAgent={() => undefined}
      />,
    );

    expect(screen.getByTestId('registered-agents-panel')).toBeInTheDocument();
    expect(registeredAgentsPanelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        providers,
        executorSettings,
        containerRuntimeAvailability: 'unavailable',
        canManage: false,
        mainAgentId: 'agent-main',
        workspaceId: 'workspace-1',
        onUnauthorized,
        onAgentsChanged,
      }),
    );
  });

  it('shows enabled agents plus the disabled selected main-agent draft, but not unrelated disabled agents', () => {
    const agents = [
      buildAgent({
        id: 'agent-main',
        name: 'Claude Main',
        modelId: 'claude-sonnet-4-6',
        enabled: true,
      }),
      buildAgent({
        id: 'agent-disabled-selected',
        name: 'Disabled Current',
        modelId: 'claude-haiku-4-6',
        enabled: false,
        executionPreview: buildExecutionPreview({
          ready: false,
          message: 'Disabled Current cannot run because its model is disabled.',
        }),
      }),
      buildAgent({
        id: 'agent-disabled-other',
        name: 'Disabled Other',
        modelId: 'claude-opus-4-6',
        enabled: false,
      }),
    ];

    render(
      <AiAgentsSettingsPanel
        providers={[buildProvider()]}
        executorSettings={buildExecutorSettings()}
        agents={agents}
        mainAgentId="agent-main"
        mainAgentDraft="agent-disabled-selected"
        canManage
        busy={false}
        workspaceId="workspace-1"
        onUnauthorized={() => undefined}
        onAgentsChanged={() => undefined}
        onMainAgentDraftChange={() => undefined}
        onSaveMainAgent={() => undefined}
      />,
    );

    const select = screen.getByLabelText('Select main agent');
    expect(
      within(select).getByRole('option', {
        name: 'Claude Main (claude-sonnet-4-6)',
      }),
    ).toBeInTheDocument();
    expect(
      within(select).getByRole('option', {
        name: 'Disabled Current (claude-haiku-4-6) (disabled)',
      }),
    ).toBeDisabled();
    expect(
      within(select).queryByRole('option', {
        name: 'Disabled Other (claude-opus-4-6) (disabled)',
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'Disabled Current cannot run because its model is disabled.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Set as Main Agent' }),
    ).toBeDisabled();
  });

  it('only saves when an enabled, changed main-agent draft is selected and management is allowed', async () => {
    const user = userEvent.setup();
    const onMainAgentDraftChange = vi.fn();
    const onSaveMainAgent = vi.fn();

    const { rerender } = render(
      <AiAgentsSettingsPanel
        providers={[buildProvider()]}
        executorSettings={buildExecutorSettings()}
        agents={buildAgents()}
        mainAgentId="agent-main"
        mainAgentDraft="agent-research"
        canManage
        busy={false}
        workspaceId="workspace-1"
        onUnauthorized={() => undefined}
        onAgentsChanged={() => undefined}
        onMainAgentDraftChange={onMainAgentDraftChange}
        onSaveMainAgent={onSaveMainAgent}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Set as Main Agent' }));
    expect(onSaveMainAgent).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText('Select main agent'), {
      target: { value: 'agent-main' },
    });
    expect(onMainAgentDraftChange).toHaveBeenCalledWith('agent-main');

    rerender(
      <AiAgentsSettingsPanel
        providers={[buildProvider()]}
        executorSettings={buildExecutorSettings()}
        agents={buildAgents()}
        mainAgentId="agent-main"
        mainAgentDraft="agent-main"
        canManage
        busy={false}
        workspaceId="workspace-1"
        onUnauthorized={() => undefined}
        onAgentsChanged={() => undefined}
        onMainAgentDraftChange={onMainAgentDraftChange}
        onSaveMainAgent={onSaveMainAgent}
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Set as Main Agent' }),
    ).toBeDisabled();

    rerender(
      <AiAgentsSettingsPanel
        providers={[buildProvider()]}
        executorSettings={buildExecutorSettings()}
        agents={buildAgents()}
        mainAgentId="agent-main"
        mainAgentDraft="agent-research"
        canManage={false}
        busy={false}
        workspaceId="workspace-1"
        onUnauthorized={() => undefined}
        onAgentsChanged={() => undefined}
        onMainAgentDraftChange={onMainAgentDraftChange}
        onSaveMainAgent={onSaveMainAgent}
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Set as Main Agent' }),
    ).toBeDisabled();
  });
});

function buildProvider(): AgentProviderCard {
  return {
    id: 'provider.anthropic',
    name: 'Claude (Anthropic)',
    providerKind: 'anthropic',
    credentialMode: 'api_key',
    apiFormat: 'anthropic_messages',
    baseUrl: 'https://api.anthropic.com',
    authScheme: 'x_api_key',
    enabled: true,
    hasCredential: true,
    credentialHint: 'stored',
    verificationStatus: 'verified',
    lastVerifiedAt: '2026-05-16T12:00:00.000Z',
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
  };
}

function buildExecutorSettings(): ExecutorSettings {
  return {
    configuredAliasMap: {},
    effectiveAliasMap: {},
    defaultAlias: 'claude-sonnet-4-6',
    executorAuthMode: 'api_key',
    authModeSource: 'settings',
    hasApiKey: true,
    hasOauthToken: false,
    hasAuthToken: false,
    apiKeySource: 'stored',
    oauthTokenSource: null,
    authTokenSource: null,
    apiKeyHint: 'stored',
    oauthTokenHint: null,
    authTokenHint: null,
    activeCredentialConfigured: true,
    verificationStatus: 'verified',
    lastVerifiedAt: '2026-05-16T12:00:00.000Z',
    lastVerificationError: null,
    anthropicBaseUrl: 'https://api.anthropic.com',
    isConfigured: true,
    configVersion: 1,
    lastUpdatedAt: '2026-05-16T12:00:00.000Z',
    lastUpdatedBy: null,
    configErrors: [],
  };
}

function buildAgents(): RegisteredAgent[] {
  return [
    buildAgent({
      id: 'agent-main',
      name: 'Claude Main',
      modelId: 'claude-sonnet-4-6',
    }),
    buildAgent({
      id: 'agent-research',
      name: 'Research Agent',
      modelId: 'claude-sonnet-4-6',
    }),
  ];
}

function buildAgent(overrides: Partial<RegisteredAgent>): RegisteredAgent {
  return {
    id: 'agent-main',
    name: 'Claude Main',
    providerId: 'provider.anthropic',
    modelId: 'claude-sonnet-4-6',
    personaRole: 'assistant',
    systemPrompt: null,
    description: null,
    enabled: true,
    credentialMode: null,
    createdAt: '2026-03-06T00:00:00.000Z',
    updatedAt: '2026-03-06T00:00:00.000Z',
    executionPreview: buildExecutionPreview(),
    supportsVision: true,
    modelAutoUpgradedFrom: null,
    modelAutoUpgradedAt: null,
    modelUpdateAvailable: null,
    ...overrides,
  };
}

function buildExecutionPreview(
  overrides?: Partial<RegisteredAgent['executionPreview']>,
): RegisteredAgent['executionPreview'] {
  return {
    surface: 'main',
    backend: 'direct_http',
    authPath: 'api_key',
    selectedMode: 'api',
    transport: 'direct',
    reasonCode: null,
    routeReason: 'normal',
    ready: true,
    message: 'Main will use Anthropic direct HTTP with an API key.',
    ...overrides,
  };
}
