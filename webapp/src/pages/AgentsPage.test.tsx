import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { AgentsPage } from './AgentsPage';
import {
  ApiError,
  getAiAgents,
  listRegisteredAgents,
  type AiAgentsPageData,
  type RegisteredAgent,
} from '../lib/api';

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    listRegisteredAgents: vi.fn(),
    getAiAgents: vi.fn(),
  };
});

const listMock = vi.mocked(listRegisteredAgents);
const aiMock = vi.mocked(getAiAgents);

function buildAgent(overrides: Partial<RegisteredAgent> = {}): RegisteredAgent {
  return {
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
    ...overrides,
  };
}

const CATALOG: AiAgentsPageData = {
  defaultClaudeModelId: '',
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
    },
  ],
} as unknown as AiAgentsPageData;

function renderPage() {
  return render(
    <MemoryRouter>
      <AgentsPage workspaceId="ws-1" onUnauthorized={() => {}} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  listMock.mockReset();
  aiMock.mockReset();
  aiMock.mockResolvedValue(CATALOG);
});

afterEach(cleanup);

describe('AgentsPage', () => {
  it('renders the roster with profile links and resolved labels', async () => {
    listMock.mockResolvedValue([
      buildAgent(),
      buildAgent({ id: 'agent-2', name: 'Critic', enabled: false }),
    ]);
    renderPage();

    const card = await screen.findByRole('link', {
      name: 'Strategist — view profile',
    });
    expect(card.getAttribute('href')).toBe('/app/agents/agent-1');
    expect((await screen.findAllByText('GPT-5')).length).toBe(2);
    expect(screen.getByText('disabled')).toBeTruthy();
    // Add-slot links to the Settings management surface.
    expect(
      screen.getByRole('link', { name: /Add a new agent/i }).getAttribute(
        'href',
      ),
    ).toContain('/app/settings?tab=agents');
  });

  it('renders the roster even when catalog enrichment fails', async () => {
    listMock.mockResolvedValue([buildAgent()]);
    aiMock.mockRejectedValue(new Error('catalog down'));
    renderPage();

    expect(
      await screen.findByRole('link', { name: 'Strategist — view profile' }),
    ).toBeTruthy();
    // Falls back to the raw model id.
    expect(screen.getByText('gpt-5')).toBeTruthy();
  });

  it('shows the empty state with a create CTA', async () => {
    listMock.mockResolvedValue([]);
    renderPage();

    expect(await screen.findByText('No agents yet')).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: 'Create your first agent' })
        .getAttribute('href'),
    ).toContain('/app/settings?tab=agents');
  });

  it('shows an error state and retries', async () => {
    listMock.mockRejectedValueOnce(new ApiError('boom', 500, 'server_error'));
    listMock.mockResolvedValueOnce([buildAgent()]);
    renderPage();

    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(
      await screen.findByRole('link', { name: 'Strategist — view profile' }),
    ).toBeTruthy();
  });
});
