import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RegisteredAgentsPanel } from './RegisteredAgentsPanel';
import {
  listRegisteredAgents,
  type AgentProviderCard,
  type ExecutorSettings,
  type RegisteredAgent,
} from '../lib/api';

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    listRegisteredAgents: vi.fn(),
    createRegisteredAgent: vi.fn(),
    updateRegisteredAgent: vi.fn(),
    deleteRegisteredAgent: vi.fn(),
    dismissAgentModelUpgrade: vi.fn(),
  };
});

const listMock = vi.mocked(listRegisteredAgents);

const PROVIDERS = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    enabled: true,
    hasCredential: true,
    verificationStatus: 'verified',
    modelSuggestions: [
      { modelId: 'claude-opus-4-8', displayName: 'Claude Opus 4.8' },
    ],
  },
] as unknown as AgentProviderCard[];

const EXECUTOR_SETTINGS = {} as unknown as ExecutorSettings;

function buildAgent(overrides: Partial<RegisteredAgent> = {}): RegisteredAgent {
  return {
    id: 'agent-1',
    name: 'Strategist',
    providerId: 'anthropic',
    modelId: 'claude-opus-4-8',
    personaRole: 'Lead',
    description: 'Plans the work',
    enabled: true,
    credentialMode: null,
    executionPreview: { ready: true, message: 'Ready to run.' },
    ...overrides,
  } as unknown as RegisteredAgent;
}

function renderPanel(
  props: Partial<Parameters<typeof RegisteredAgentsPanel>[0]> = {},
) {
  return render(
    <RegisteredAgentsPanel
      providers={PROVIDERS}
      executorSettings={EXECUTOR_SETTINGS}
      containerRuntimeAvailability="ready"
      onUnauthorized={vi.fn()}
      canManage
      mainAgentId={null}
      workspaceId="ws-1"
      {...props}
    />,
  );
}

afterEach(cleanup);

describe('RegisteredAgentsPanel (Salon)', () => {
  it('shows the empty state when there are no agents', async () => {
    listMock.mockResolvedValue([]);
    renderPanel();
    expect(
      await screen.findByText('No registered agents yet.'),
    ).toBeInTheDocument();
  });

  it('lists agents with Salon action buttons and metadata chips', async () => {
    listMock.mockResolvedValue([buildAgent()]);
    renderPanel({ mainAgentId: 'agent-1' });
    expect(await screen.findByText('Strategist')).toBeInTheDocument();
    // Salon Button atoms.
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    // Main agent can't be deleted.
    expect(
      screen.queryByRole('button', { name: 'Delete' }),
    ).not.toBeInTheDocument();
    // Salon Chip metadata.
    expect(screen.getByText('Anthropic')).toBeInTheDocument();
    expect(screen.getByText('Main Agent')).toBeInTheDocument();
  });

  it('offers Delete for non-main agents', async () => {
    listMock.mockResolvedValue([buildAgent()]);
    renderPanel({ mainAgentId: 'other' });
    await screen.findByText('Strategist');
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('opens the create form with a Salon name field', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([]);
    renderPanel();
    await screen.findByText('No registered agents yet.');
    await user.click(screen.getByRole('button', { name: 'Create Agent' }));
    expect(screen.getByPlaceholderText('Agent name')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('hides management controls when canManage is false', async () => {
    listMock.mockResolvedValue([buildAgent()]);
    renderPanel({ canManage: false, mainAgentId: 'other' });
    await screen.findByText('Strategist');
    expect(
      screen.queryByRole('button', { name: 'Create Agent' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Edit' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Delete' }),
    ).not.toBeInTheDocument();
  });
});
