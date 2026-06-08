import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { AgentProfilePage } from './AgentProfilePage';
import {
  ApiError,
  UnauthorizedError,
  getAiAgents,
  getRegisteredAgent,
  type AiAgentsPageData,
  type RegisteredAgent,
} from '../lib/api';

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    getRegisteredAgent: vi.fn(),
    getAiAgents: vi.fn(),
  };
});

const agentMock = vi.mocked(getRegisteredAgent);
const aiMock = vi.mocked(getAiAgents);

const AGENT: RegisteredAgent = {
  id: 'agent-1',
  name: 'Strategist',
  providerId: 'provider.openai',
  modelId: 'gpt-5',
  personaRole: 'Lead',
  systemPrompt: 'You are the strategist.',
  description: 'Plans the work and keeps the Talk on track.',
  enabled: true,
  credentialMode: 'api_key',
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-06T00:00:00.000Z',
  executionPreview: {
    surface: 'main',
    backend: 'direct_http',
    authPath: 'api_key',
    selectedMode: 'api',
    transport: 'direct',
    reasonCode: null,
    routeReason: 'normal',
    ready: true,
    message: 'Ready to run via direct HTTP.',
  },
  supportsVision: true,
  modelAutoUpgradedFrom: null,
  modelAutoUpgradedAt: null,
  modelUpdateAvailable: null,
};

const CATALOG: AiAgentsPageData = {
  defaultClaudeModelId: 'claude-opus-4-8',
  claudeModelSuggestions: [],
  additionalProviders: [
    {
      id: 'provider.openai',
      name: 'OpenAI',
      modelSuggestions: [
        {
          modelId: 'gpt-5',
          displayName: 'GPT-5',
          contextWindowTokens: 0,
          defaultMaxOutputTokens: 0,
        },
      ],
    } as unknown as AiAgentsPageData['additionalProviders'][number],
  ],
};

function renderPage(onUnauthorized = vi.fn()): { onUnauthorized: () => void } {
  render(
    <MemoryRouter initialEntries={['/app/agents/agent-1']}>
      <Routes>
        <Route
          path="/app/agents/:agentId"
          element={
            <AgentProfilePage
              workspaceId="ws-1"
              onUnauthorized={onUnauthorized}
            />
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  return { onUnauthorized };
}

describe('AgentProfilePage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    aiMock.mockResolvedValue(CATALOG);
  });
  afterEach(cleanup);

  it('shows a busy state while the agent is loading', () => {
    agentMock.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByLabelText('Loading agent')).toBeTruthy();
  });

  it('renders the profile with resolved provider + model labels', async () => {
    agentMock.mockResolvedValue(AGENT);
    renderPage();

    expect(await screen.findByText('Strategist')).toBeTruthy();
    // Model display name resolved from the catalog. The catalog is enriched in
    // a second tick (non-blocking), so the friendly label appears after the
    // agent renders.
    expect(await screen.findByText('GPT-5')).toBeTruthy();
    // System prompt surfaced.
    expect(screen.getByText('You are the strategist.')).toBeTruthy();
    // Keyboard-accessible primary action is a real link.
    expect(screen.getByRole('link', { name: 'Edit in Settings' })).toBeTruthy();
  });

  it('renders without waiting on the optional catalog (Codex P2)', async () => {
    agentMock.mockResolvedValue(AGENT);
    aiMock.mockReturnValue(new Promise(() => {})); // catalog never settles

    renderPage();

    // The profile renders on the agent fetch alone; humanized id labels stand
    // in until (if ever) the catalog arrives — it never gates the page.
    expect(await screen.findByText('Strategist')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Edit in Settings' })).toBeTruthy();
  });

  it('shows a not-found state on a 404', async () => {
    agentMock.mockRejectedValue(new ApiError('Missing', 404));
    renderPage();

    expect(await screen.findByText('Agent not found')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to Agents' })).toBeTruthy();
  });

  it('shows an error with a working retry', async () => {
    agentMock.mockRejectedValueOnce(new Error('network down'));
    renderPage();

    expect(await screen.findByText(/load this agent/i)).toBeTruthy();
    expect(screen.getByText('network down')).toBeTruthy();

    agentMock.mockResolvedValue(AGENT);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    expect(await screen.findByText('Strategist')).toBeTruthy();
    expect(agentMock).toHaveBeenCalledTimes(2);
  });

  it('calls onUnauthorized when the session is invalid', async () => {
    agentMock.mockRejectedValue(new UnauthorizedError());
    const { onUnauthorized } = renderPage();

    await vi.waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
  });
});
