import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { settingsPageNavigation, SettingsPage } from './SettingsPage';
import type {
  AgentProviderCard,
  AiAgentsPageData,
  RegisteredAgent,
  SessionUser,
  UserGoogleAccount,
  WebSearchProviderCard,
  WebSearchProviderId,
} from '../lib/api';

const TEST_WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';
const SECOND_WORKSPACE_ID = '00000000-0000-4000-8000-000000000002';

describe('SettingsPage', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('defaults to the Profile section and shows the display-name editor', async () => {
    installSettingsFetch();

    render(
      <MemoryRouter initialEntries={['/app/settings']}>
        <SettingsPage
          user={buildSessionUser()}
          userRole="owner"
          onUnauthorized={vi.fn()}
          onUserUpdated={vi.fn()}
        />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'My Profile' });
    expect(
      screen.getByRole('heading', { name: 'Personal Information' }),
    ).toBeTruthy();
  });

  it('saves Profile display-name changes through the session API', async () => {
    const user = userEvent.setup();
    const helpers = installSettingsFetch();
    const onUserUpdated = vi.fn();

    render(
      <MemoryRouter initialEntries={['/app/settings']}>
        <SettingsPage
          user={buildSessionUser()}
          userRole="owner"
          onUnauthorized={vi.fn()}
          onUserUpdated={onUserUpdated}
        />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'My Profile' });
    const nameInput = screen.getByLabelText('Full name');
    await user.clear(nameInput);
    await user.type(nameInput, 'Owner Renamed');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Profile updated.')).toBeTruthy();
    expect(helpers.getProfileUpdateCalls()).toEqual([
      {
        workspaceId: TEST_WORKSPACE_ID,
        body: { displayName: 'Owner Renamed' },
      },
    ]);
    expect(onUserUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: 'Owner Renamed' }),
    );
  });

  it('opens the API Keys tab via ?tab=api-keys, defaults to Personal, and surfaces Workspace via sub-tab', async () => {
    const user = userEvent.setup();
    installSettingsFetch();

    render(
      <MemoryRouter initialEntries={['/app/settings?tab=api-keys']}>
        <SettingsPage
          user={buildSessionUser()}
          userRole="owner"
          onUnauthorized={vi.fn()}
          onUserUpdated={vi.fn()}
        />
      </MemoryRouter>,
    );

    // Personal is the default sub-tab — Workspace heading isn't on the
    // page until the user clicks the Workspace tab.
    await screen.findByRole('heading', { name: 'Personal API Keys' });
    expect(
      screen.queryByRole('heading', { name: 'Workspace API Keys' }),
    ).toBeNull();

    const personalCards = screen
      .getAllByRole('heading', { name: 'Claude (Anthropic)' })
      .map((heading) => heading.closest('article'))
      .filter((node): node is HTMLElement => node !== null);
    expect(personalCards).toHaveLength(1);
    expect(
      within(personalCards[0]).getByPlaceholderText('sk-ant-...'),
    ).toBeTruthy();

    await user.click(screen.getByRole('tab', { name: 'Workspace' }));
    await screen.findByRole('heading', { name: 'Workspace API Keys' });
    expect(
      screen.queryByRole('heading', { name: 'Personal API Keys' }),
    ).toBeNull();

    const workspaceCards = screen
      .getAllByRole('heading', { name: 'Claude (Anthropic)' })
      .map((heading) => heading.closest('article'))
      .filter((node): node is HTMLElement => node !== null);
    expect(workspaceCards).toHaveLength(1);
    expect(
      within(workspaceCards[0]).getByPlaceholderText('sk-ant-...'),
    ).toBeTruthy();
  });

  it('supports keyboard navigation between API key sub-tabs without dangling tab panels', async () => {
    installSettingsFetch();

    render(
      <MemoryRouter initialEntries={['/app/settings?tab=api-keys']}>
        <SettingsPage
          user={buildSessionUser()}
          userRole="owner"
          onUnauthorized={vi.fn()}
          onUserUpdated={vi.fn()}
        />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Personal API Keys' });
    const personalTab = screen.getByRole('tab', { name: 'Personal' });
    const workspaceTab = screen.getByRole('tab', { name: 'Workspace' });
    const personalPanel = document.getElementById('api-keys-personal-panel');
    const workspacePanel = document.getElementById('api-keys-workspace-panel');

    expect(personalPanel).toBeTruthy();
    expect(workspacePanel).toBeTruthy();
    expect(personalPanel?.hidden).toBe(false);
    expect(workspacePanel?.hidden).toBe(true);
    expect(personalTab.getAttribute('aria-controls')).toBe(
      'api-keys-personal-panel',
    );
    expect(workspaceTab.getAttribute('aria-controls')).toBe(
      'api-keys-workspace-panel',
    );
    expect(personalTab.tabIndex).toBe(0);
    expect(workspaceTab.tabIndex).toBe(-1);

    fireEvent.keyDown(personalTab, { key: 'ArrowRight' });
    await screen.findByRole('heading', { name: 'Workspace API Keys' });
    expect(document.activeElement).toBe(workspaceTab);
    expect(personalPanel?.hidden).toBe(true);
    expect(workspacePanel?.hidden).toBe(false);
    expect(personalTab.tabIndex).toBe(-1);
    expect(workspaceTab.tabIndex).toBe(0);

    fireEvent.keyDown(workspaceTab, { key: 'Home' });
    await screen.findByRole('heading', { name: 'Personal API Keys' });
    expect(document.activeElement).toBe(personalTab);
    expect(personalPanel?.hidden).toBe(false);
    expect(workspacePanel?.hidden).toBe(true);
  });

  it('saves a Personal API key with scope=user', async () => {
    const user = userEvent.setup();
    const helpers = installSettingsFetch();

    render(
      <MemoryRouter initialEntries={['/app/settings?tab=api-keys']}>
        <SettingsPage
          user={buildSessionUser()}
          userRole="owner"
          onUnauthorized={vi.fn()}
          onUserUpdated={vi.fn()}
        />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Personal API Keys' });
    const personalSection = screen
      .getByRole('heading', { name: 'Personal API Keys' })
      .closest('section');
    if (!personalSection) throw new Error('Personal section not found');
    const anthropicCard = within(personalSection)
      .getByRole('heading', { name: 'Claude (Anthropic)' })
      .closest('article');
    if (!anthropicCard) throw new Error('Anthropic card not found');

    const input = within(anthropicCard).getByPlaceholderText('sk-ant-...');
    await user.type(input, 'sk-ant-test-key');
    await user.click(
      within(anthropicCard).getByRole('button', { name: 'Save' }),
    );

    expect(
      await screen.findByText(/Claude \(Anthropic\) credential saved\./),
    ).toBeTruthy();
    const calls = helpers.getProviderSaveCalls('provider.anthropic');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      providerId: 'provider.anthropic',
      apiKey: 'sk-ant-test-key',
      scope: 'user',
    });
  });

  it('saves a Workspace API key with scope=workspace as an admin', async () => {
    const user = userEvent.setup();
    const helpers = installSettingsFetch();

    render(
      <MemoryRouter initialEntries={['/app/settings?tab=api-keys']}>
        <SettingsPage
          user={buildSessionUser()}
          userRole="owner"
          onUnauthorized={vi.fn()}
          onUserUpdated={vi.fn()}
        />
      </MemoryRouter>,
    );

    // Personal is the default sub-tab — switch to Workspace first.
    await screen.findByRole('heading', { name: 'Personal API Keys' });
    await user.click(screen.getByRole('tab', { name: 'Workspace' }));
    await screen.findByRole('heading', { name: 'Workspace API Keys' });
    const workspaceSection = screen
      .getByRole('heading', { name: 'Workspace API Keys' })
      .closest('section');
    if (!workspaceSection) throw new Error('Workspace section not found');
    const anthropicCard = within(workspaceSection)
      .getByRole('heading', { name: 'Claude (Anthropic)' })
      .closest('article');
    if (!anthropicCard) throw new Error('Anthropic card not found');

    const input = within(anthropicCard).getByPlaceholderText('sk-ant-...');
    await user.type(input, 'sk-ant-workspace-key');
    await user.click(
      within(anthropicCard).getByRole('button', { name: 'Save' }),
    );

    expect(
      await screen.findByText(
        /Claude \(Anthropic\) workspace credential saved\./,
      ),
    ).toBeTruthy();
    const calls = helpers.getProviderSaveCalls('provider.anthropic');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      providerId: 'provider.anthropic',
      apiKey: 'sk-ant-workspace-key',
      scope: 'workspace',
    });
  });

  it('keeps Personal API key drafts when switching API key sub-tabs', async () => {
    const user = userEvent.setup();
    installSettingsFetch();

    render(
      <MemoryRouter initialEntries={['/app/settings?tab=api-keys']}>
        <SettingsPage
          user={buildSessionUser()}
          userRole="owner"
          onUnauthorized={vi.fn()}
          onUserUpdated={vi.fn()}
        />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Personal API Keys' });
    const personalSection = screen
      .getByRole('heading', { name: 'Personal API Keys' })
      .closest('section');
    if (!personalSection) throw new Error('Personal section not found');
    const anthropicCard = within(personalSection)
      .getByRole('heading', { name: 'Claude (Anthropic)' })
      .closest('article');
    if (!anthropicCard) throw new Error('Anthropic card not found');

    const input = within(anthropicCard).getByPlaceholderText('sk-ant-...');
    await user.type(input, 'sk-ant-unsaved-draft');

    await user.click(screen.getByRole('tab', { name: 'Workspace' }));
    await screen.findByRole('heading', { name: 'Workspace API Keys' });
    await user.click(screen.getByRole('tab', { name: 'Personal' }));
    await screen.findByRole('heading', { name: 'Personal API Keys' });

    expect(screen.getByDisplayValue('sk-ant-unsaved-draft')).toBeTruthy();
  });

  it('keeps ChatGPT subscription device flow when switching API key sub-tabs', async () => {
    const user = userEvent.setup();
    installSettingsFetch();
    vi.spyOn(window, 'open').mockReturnValue(null);

    render(
      <MemoryRouter initialEntries={['/app/settings?tab=api-keys']}>
        <SettingsPage
          user={buildSessionUser()}
          userRole="owner"
          onUnauthorized={vi.fn()}
          onUserUpdated={vi.fn()}
        />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Personal API Keys' });
    await user.click(
      screen.getByRole('button', { name: 'Connect with ChatGPT' }),
    );
    expect(await screen.findByText('CT-1234')).toBeTruthy();

    await user.click(screen.getByRole('tab', { name: 'Workspace' }));
    await screen.findByRole('heading', { name: 'Workspace API Keys' });
    await user.click(screen.getByRole('tab', { name: 'Personal' }));
    await screen.findByRole('heading', { name: 'Personal API Keys' });

    expect(screen.getByText('CT-1234')).toBeTruthy();
  });

  it('polls ChatGPT device flow until authorization completes', async () => {
    const helpers = installSettingsFetch({
      openAiPollIntervalSeconds: 1,
      openAiPollResponses: [
        { status: 'pending' },
        {
          status: 'authorized',
          scope: 'user',
          expiresAt: '2026-05-16T12:05:00.000Z',
        },
      ],
    });
    vi.spyOn(window, 'open').mockReturnValue(null);
    const reloadSpy = vi
      .spyOn(settingsPageNavigation, 'reload')
      .mockImplementation(() => undefined);

    render(
      <MemoryRouter initialEntries={['/app/settings?tab=api-keys']}>
        <SettingsPage
          user={buildSessionUser()}
          userRole="owner"
          onUnauthorized={vi.fn()}
          onUserUpdated={vi.fn()}
        />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Personal API Keys' });
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Connect with ChatGPT' }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText('CT-1234')).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(helpers.getOpenAiPollCalls()).toEqual(['openai-state-1']);
    expect(screen.getByText('CT-1234')).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(helpers.getOpenAiPollCalls()).toEqual([
      'openai-state-1',
      'openai-state-1',
    ]);
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('CT-1234')).toBeNull();
  });

  it('stops ChatGPT device polling and surfaces poll errors', async () => {
    const helpers = installSettingsFetch({
      openAiPollIntervalSeconds: 1,
      openAiPollResponses: [{ status: 'error', message: 'Polling failed.' }],
    });
    vi.spyOn(window, 'open').mockReturnValue(null);

    render(
      <MemoryRouter initialEntries={['/app/settings?tab=api-keys']}>
        <SettingsPage
          user={buildSessionUser()}
          userRole="owner"
          onUnauthorized={vi.fn()}
          onUserUpdated={vi.fn()}
        />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Personal API Keys' });
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Connect with ChatGPT' }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText('CT-1234')).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(helpers.getOpenAiPollCalls()).toEqual(['openai-state-1']);
    expect(screen.getByText('Polling failed.')).toBeTruthy();
    expect(
      screen.getByText('Polling stopped. Restart connection to try again.'),
    ).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(helpers.getOpenAiPollCalls()).toEqual(['openai-state-1']);
  });

  it('completes the Claude subscription flow through the reload seam', async () => {
    const user = userEvent.setup();
    const helpers = installSettingsFetch();
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    const reloadSpy = vi
      .spyOn(settingsPageNavigation, 'reload')
      .mockImplementation(() => undefined);

    render(
      <MemoryRouter initialEntries={['/app/settings?tab=api-keys']}>
        <SettingsPage
          user={buildSessionUser()}
          userRole="owner"
          onUnauthorized={vi.fn()}
          onUserUpdated={vi.fn()}
        />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Personal API Keys' });
    await user.click(screen.getByRole('button', { name: 'Connect with Claude' }));

    expect(openSpy).toHaveBeenCalledWith(
      'https://claude.example/oauth',
      '_blank',
      'noopener,noreferrer',
    );
    expect(helpers.getAnthropicInitiateCalls()).toEqual([
      { scope: 'user', workspaceId: TEST_WORKSPACE_ID },
    ]);

    await user.type(
      await screen.findByLabelText('Paste the code (or full code#state blob)'),
      'claude-code#ignored-state-fragment',
    );
    await user.click(
      screen.getByRole('button', { name: 'Complete connection' }),
    );

    await waitFor(() => expect(reloadSpy).toHaveBeenCalledTimes(1));
    expect(helpers.getAnthropicCompleteCalls()).toEqual([
      { state: 'anthropic-state-1', code: 'claude-code' },
    ]);
  });

  it('opens the Agents tab and lists registered agents from the panel', async () => {
    installSettingsFetch();

    render(
      <MemoryRouter initialEntries={['/app/settings?tab=agents']}>
        <SettingsPage
          user={buildSessionUser()}
          userRole="owner"
          onUnauthorized={vi.fn()}
          onUserUpdated={vi.fn()}
        />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Registered Agents' });
    // Agent cards + the Main Agent section render after the async agents
    // fetch completes; the panel heading shows up first while the rest is
    // still loading, so wait for both pieces explicitly.
    expect(await screen.findByText('Claude Main')).toBeTruthy();
    expect(
      await screen.findByRole('heading', { name: 'Main Agent' }),
    ).toBeTruthy();
  });

  it('saves the selected Main Agent from the Agents tab', async () => {
    const user = userEvent.setup();
    const helpers = installSettingsFetch();

    render(
      <MemoryRouter initialEntries={['/app/settings?tab=agents']}>
        <SettingsPage
          user={buildSessionUser()}
          userRole="owner"
          onUnauthorized={vi.fn()}
          onUserUpdated={vi.fn()}
        />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Main Agent' });
    await user.selectOptions(
      screen.getByLabelText('Select main agent'),
      'agent-research',
    );
    await user.click(screen.getByRole('button', { name: 'Set as Main Agent' }));

    expect(await screen.findByText('Main agent updated.')).toBeTruthy();
    expect(helpers.getMainAgentUpdateCalls()).toEqual(['agent-research']);
  });

  it('keeps a disabled current Main Agent visible in the selector', async () => {
    const registeredAgents = buildRegisteredAgents().map((agent) =>
      agent.id === 'agent-main' ? { ...agent, enabled: false } : agent,
    );
    installSettingsFetch({
      registeredAgents,
      mainAgent: registeredAgents[0],
    });

    render(
      <MemoryRouter initialEntries={['/app/settings?tab=agents']}>
        <SettingsPage
          user={buildSessionUser()}
          userRole="owner"
          onUnauthorized={vi.fn()}
          onUserUpdated={vi.fn()}
        />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Main Agent' });

    const select = screen.getByLabelText(
      'Select main agent',
    ) as HTMLSelectElement;
    expect(select.value).toBe('agent-main');
    expect(
      screen.getByRole('option', {
        name: 'Claude Main (claude-sonnet-4-6) (disabled)',
      }),
    ).toBeTruthy();
  });
});

function installSettingsFetch(options?: {
  registeredAgents?: RegisteredAgent[];
  mainAgent?: RegisteredAgent | null;
  openAiPollIntervalSeconds?: number;
  openAiPollResponses?: Array<
    | { status: 'pending' }
    | {
        status: 'authorized';
        scope: 'user' | 'workspace';
        expiresAt: string;
      }
    | { status: 'error'; message: string }
  >;
}) {
  let snapshot = buildAiAgentsData();
  let registeredAgents = options?.registeredAgents ?? buildRegisteredAgents();
  let mainAgent: RegisteredAgent | null =
    options?.mainAgent ?? registeredAgents[0] ?? null;
  const mainAgentUpdateCalls: string[] = [];
  const openAiPollCalls: string[] = [];
  const openAiPollResponses = [...(options?.openAiPollResponses ?? [])];
  const anthropicInitiateCalls: Array<{
    scope: 'user' | 'workspace';
    workspaceId?: string | null;
  }> = [];
  const anthropicCompleteCalls: Array<{
    state: string;
    code: string;
  }> = [];
  const profileUpdateCalls: Array<{
    workspaceId: string | null;
    body: { displayName?: string };
  }> = [];
  const providerSaveCalls: Record<
    string,
    Array<{
      providerId: string;
      apiKey: string | null;
      scope: 'user' | 'workspace';
    }>
  > = {};

  vi.stubGlobal(
    'fetch',
    vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof request === 'string'
          ? request
          : request instanceof URL
            ? request.toString()
            : request instanceof Request
              ? request.url
              : String(request);
      const parsed = new URL(url, 'http://localhost');
      const path = parsed.pathname;
      const method = init?.method || 'GET';

      if (path === '/api/v1/session/me' && method === 'PATCH') {
        const body = JSON.parse(String(init?.body || '{}')) as {
          displayName?: string;
        };
        const workspaceId = parsed.searchParams.get('workspaceId');
        profileUpdateCalls.push({ workspaceId, body });
        const updatedUser = buildSessionUser({
          displayName: body.displayName ?? 'Owner',
          currentWorkspaceId: workspaceId ?? TEST_WORKSPACE_ID,
        });
        return jsonResponse(200, {
          ok: true,
          data: {
            user: updatedUser,
            workspaces: updatedUser.workspaces,
            currentWorkspaceId: updatedUser.currentWorkspaceId,
          },
        });
      }

      if (path === '/api/v1/agents' && method === 'GET') {
        return jsonResponse(200, { ok: true, data: snapshot });
      }

      if (path === '/api/v1/registered-agents' && method === 'GET') {
        return jsonResponse(200, { ok: true, data: registeredAgents });
      }

      if (path === '/api/v1/registered-agents/main' && method === 'GET') {
        if (!mainAgent) {
          return jsonResponse(404, {
            ok: false,
            error: { code: 'not_found', message: 'No main agent' },
          });
        }
        return jsonResponse(200, { ok: true, data: mainAgent });
      }

      if (path === '/api/v1/registered-agents/main' && method === 'PUT') {
        const body = JSON.parse(String(init?.body || '{}')) as {
          agentId: string;
        };
        mainAgentUpdateCalls.push(body.agentId);
        const nextMain =
          registeredAgents.find((agent) => agent.id === body.agentId) ?? null;
        if (!nextMain) {
          return jsonResponse(404, {
            ok: false,
            error: { code: 'not_found', message: 'Agent not found' },
          });
        }
        mainAgent = nextMain;
        return jsonResponse(200, { ok: true, data: nextMain });
      }

      if (
        path === '/api/v1/agents/providers/provider.anthropic/oauth/initiate' &&
        method === 'POST'
      ) {
        const body = JSON.parse(String(init?.body || '{}')) as {
          scope?: 'user' | 'workspace';
          workspaceId?: string | null;
        };
        anthropicInitiateCalls.push({
          scope: body.scope ?? 'user',
          workspaceId: body.workspaceId,
        });
        return jsonResponse(200, {
          ok: true,
          data: {
            authorizationUrl: 'https://claude.example/oauth',
            state: 'anthropic-state-1',
          },
        });
      }

      if (
        path === '/api/v1/agents/providers/provider.anthropic/oauth/complete' &&
        method === 'POST'
      ) {
        const body = JSON.parse(String(init?.body || '{}')) as {
          state: string;
          code: string;
        };
        anthropicCompleteCalls.push(body);
        return jsonResponse(200, {
          ok: true,
          data: {
            scope: 'user',
            expiresAt: '2026-05-16T12:05:00.000Z',
          },
        });
      }

      if (
        path ===
          '/api/v1/agents/providers/provider.openai_codex/oauth/initiate' &&
        method === 'POST'
      ) {
        return jsonResponse(200, {
          ok: true,
          data: {
            state: 'openai-state-1',
            userCode: 'CT-1234',
            verificationUrl: 'https://openai.example/device',
            pollIntervalSeconds: options?.openAiPollIntervalSeconds ?? 60,
            expiresAt: '2026-05-16T12:05:00.000Z',
          },
        });
      }

      if (
        path === '/api/v1/agents/providers/provider.openai_codex/oauth/poll' &&
        method === 'POST'
      ) {
        const body = JSON.parse(String(init?.body || '{}')) as {
          state: string;
        };
        openAiPollCalls.push(body.state);
        const response = openAiPollResponses.shift() ?? {
          status: 'pending',
        };
        if (response.status === 'error') {
          return jsonResponse(500, {
            ok: false,
            error: {
              code: 'poll_failed',
              message: response.message,
            },
          });
        }
        return jsonResponse(200, {
          ok: true,
          data: response,
        });
      }

      const providerSaveMatch = path.match(
        /\/api\/v1\/agents\/providers\/([^/?]+)$/,
      );
      if (providerSaveMatch && method === 'PUT') {
        const providerId = decodeURIComponent(providerSaveMatch[1]);
        const body = JSON.parse(String(init?.body || '{}')) as {
          providerId: string;
          apiKey: string | null;
          scope?: 'user' | 'workspace';
        };
        const scope = body.scope ?? 'user';
        providerSaveCalls[providerId] = providerSaveCalls[providerId] || [];
        providerSaveCalls[providerId].push({
          providerId: body.providerId,
          apiKey: body.apiKey,
          scope,
        });

        let next: AgentProviderCard | null = null;
        snapshot = {
          ...snapshot,
          additionalProviders: snapshot.additionalProviders.map((entry) => {
            if (entry.id !== providerId) return entry;
            if (scope === 'workspace') {
              next = {
                ...entry,
                workspaceHasCredential: body.apiKey !== null,
                workspaceCredentialHint: body.apiKey ? '••••test' : null,
                workspaceVerificationStatus: body.apiKey
                  ? 'verified'
                  : 'missing',
                workspaceLastVerifiedAt: body.apiKey
                  ? '2026-05-16T12:00:00.000Z'
                  : null,
                workspaceLastVerificationError: null,
              };
            } else {
              next = {
                ...entry,
                hasCredential: body.apiKey !== null,
                credentialHint: body.apiKey ? '••••test' : null,
                verificationStatus: body.apiKey ? 'verified' : 'missing',
                lastVerifiedAt: body.apiKey ? '2026-05-16T12:00:00.000Z' : null,
                lastVerificationError: null,
              };
            }
            return next;
          }),
        };
        return jsonResponse(200, { ok: true, data: { provider: next } });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    }),
  );

  return {
    getProviderSaveCalls: (providerId: string) =>
      providerSaveCalls[providerId] || [],
    getMainAgentUpdateCalls: () => mainAgentUpdateCalls,
    getOpenAiPollCalls: () => openAiPollCalls,
    getAnthropicInitiateCalls: () => anthropicInitiateCalls,
    getAnthropicCompleteCalls: () => anthropicCompleteCalls,
    getProfileUpdateCalls: () => profileUpdateCalls,
  };
}

function buildSessionUser(overrides?: Partial<SessionUser>): SessionUser {
  return {
    id: 'user-1',
    email: 'owner@example.com',
    displayName: 'Owner',
    role: 'owner',
    createdAt: '2026-01-01T00:00:00.000Z',
    currentWorkspaceId:
      overrides?.currentWorkspaceId ?? '00000000-0000-4000-8000-000000000001',
    workspaces: [
      {
        id: '00000000-0000-4000-8000-000000000001',
        name: 'Default Workspace',
        role: overrides?.role ?? 'owner',
        initials: 'DW',
      },
    ],
    ...overrides,
  };
}

function buildAiAgentsData(): AiAgentsPageData {
  return {
    defaultClaudeModelId: 'claude-sonnet-4-6',
    claudeModelSuggestions: [
      {
        modelId: 'claude-sonnet-4-6',
        displayName: 'Claude Sonnet 4.6',
        contextWindowTokens: 200000,
        defaultMaxOutputTokens: 8192,
      },
    ],
    additionalProviders: [
      {
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
      },
      {
        id: 'provider.openai_codex',
        name: 'ChatGPT Codex',
        providerKind: 'openai',
        credentialMode: 'subscription_only',
        apiFormat: 'openai_chat_completions',
        baseUrl: 'https://api.openai.com/v1',
        authScheme: 'bearer',
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
        modelSuggestions: [],
      },
      {
        id: 'provider.openai',
        name: 'OpenAI',
        providerKind: 'openai',
        credentialMode: 'api_key',
        apiFormat: 'openai_chat_completions',
        baseUrl: 'https://api.openai.com/v1',
        authScheme: 'bearer',
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
            modelId: 'gpt-5-mini',
            displayName: 'GPT-5 Mini',
            contextWindowTokens: 128000,
            defaultMaxOutputTokens: 4096,
          },
        ],
      },
      {
        id: 'provider.gemini',
        name: 'Google / Gemini',
        providerKind: 'gemini',
        credentialMode: 'api_key',
        apiFormat: 'openai_chat_completions',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        authScheme: 'bearer',
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
            modelId: 'gemini-2.5-flash',
            displayName: 'Gemini 2.5 Flash',
            contextWindowTokens: 1000000,
            defaultMaxOutputTokens: 8192,
          },
        ],
      },
      {
        id: 'provider.nvidia',
        name: 'NVIDIA Kimi2.5',
        providerKind: 'nvidia',
        credentialMode: 'api_key',
        apiFormat: 'openai_chat_completions',
        baseUrl: 'https://integrate.api.nvidia.com/v1',
        authScheme: 'bearer',
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
            modelId: 'moonshotai/kimi-k2.6',
            displayName: 'Kimi 2.6 (NVIDIA)',
            contextWindowTokens: 262144,
            defaultMaxOutputTokens: 16384,
          },
        ],
      },
    ],
  };
}

function buildRegisteredAgents(): RegisteredAgent[] {
  return [
    {
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
      executionPreview: {
        surface: 'main',
        backend: 'direct_http',
        authPath: 'api_key',
        selectedMode: 'api',
        transport: 'direct',
        reasonCode: null,
        routeReason: 'normal',
        ready: true,
        message: 'Main will use Anthropic direct HTTP with an API key.',
      },
      supportsVision: true,
      modelAutoUpgradedFrom: null,
      modelAutoUpgradedAt: null,
      modelUpdateAvailable: null,
    },
    {
      id: 'agent-research',
      name: 'Research Agent',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      personaRole: 'researcher',
      systemPrompt: null,
      description: null,
      enabled: true,
      credentialMode: null,
      createdAt: '2026-03-06T00:00:00.000Z',
      updatedAt: '2026-03-06T00:00:00.000Z',
      executionPreview: {
        surface: 'main',
        backend: 'direct_http',
        authPath: 'api_key',
        selectedMode: 'api',
        transport: 'direct',
        reasonCode: null,
        routeReason: 'normal',
        ready: true,
        message:
          'Research Agent will use Anthropic direct HTTP with an API key.',
      },
      supportsVision: true,
      modelAutoUpgradedFrom: null,
      modelAutoUpgradedAt: null,
      modelUpdateAvailable: null,
    },
  ];
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// ─── GoogleAccountSection (PR1, flag-gated) ─────────────────────────

describe('GoogleAccountSection (flag-gated)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function installToolsFetch(opts: {
    connected: boolean;
    scopes?: string[];
    webSearchProviders?: WebSearchProviderCard[];
    activeProviderId?: WebSearchProviderId | null;
  }) {
    let account: UserGoogleAccount = opts.connected
      ? {
          connected: true,
          email: 'tester@example.com',
          displayName: 'Tester',
          scopes: opts.scopes ?? [
            'drive.readonly',
            'documents',
            'spreadsheets',
          ],
          accessExpiresAt: '2026-12-31T00:00:00.000Z',
        }
      : {
          connected: false,
          email: null,
          displayName: null,
          scopes: [],
          accessExpiresAt: null,
        };
    let webSearchProviders = opts.webSearchProviders ?? [];
    let activeProviderId = opts.activeProviderId ?? null;
    const webSearchSaveCalls: Array<{
      providerId: WebSearchProviderId;
      apiKey: string;
    }> = [];
    const activeProviderCalls: Array<WebSearchProviderId | null> = [];
    const googleConnectCalls: Array<{ scopes: string[] }> = [];
    const googleExpandCalls: Array<{ scopes: string[] }> = [];
    const googleDisconnectCalls: string[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof request === 'string'
            ? request
            : request instanceof URL
              ? request.toString()
              : request instanceof Request
                ? request.url
                : String(request);
        const method = init?.method || 'GET';
        const path = new URL(url, 'http://localhost').pathname;

        if (url.endsWith('/api/v1/agents') && method === 'GET') {
          return jsonResponse(200, { ok: true, data: buildAiAgentsData() });
        }
        if (url.endsWith('/api/v1/registered-agents') && method === 'GET') {
          return jsonResponse(200, { ok: true, data: buildRegisteredAgents() });
        }
        if (
          url.endsWith('/api/v1/registered-agents/main') &&
          method === 'GET'
        ) {
          return jsonResponse(200, {
            ok: true,
            data: buildRegisteredAgents()[0],
          });
        }
        if (path === '/api/v1/web-search/providers' && method === 'GET') {
          return jsonResponse(200, {
            ok: true,
            data: {
              providers: webSearchProviders,
              activeProviderId,
            },
          });
        }
        const webSearchProviderMatch = path.match(
          /\/api\/v1\/web-search\/providers\/([^/?]+)$/,
        );
        if (webSearchProviderMatch && method === 'PUT') {
          const providerId = decodeURIComponent(
            webSearchProviderMatch[1],
          ) as WebSearchProviderId;
          const body = JSON.parse(String(init?.body || '{}')) as {
            apiKey: string;
          };
          webSearchSaveCalls.push({ providerId, apiKey: body.apiKey });
          webSearchProviders = webSearchProviders.map((provider) =>
            provider.id === providerId
              ? {
                  ...provider,
                  hasCredential: true,
                  credentialHint: '••••test',
                }
              : provider,
          );
          return jsonResponse(200, { ok: true, data: { saved: true } });
        }
        if (path === '/api/v1/web-search/active' && method === 'PUT') {
          const body = JSON.parse(String(init?.body || '{}')) as {
            providerId: WebSearchProviderId | null;
          };
          activeProviderId = body.providerId;
          activeProviderCalls.push(activeProviderId);
          webSearchProviders = webSearchProviders.map((provider) => ({
            ...provider,
            isActive: provider.id === activeProviderId,
          }));
          return jsonResponse(200, {
            ok: true,
            data: { activeProviderId },
          });
        }
        if (path === '/api/v1/me/google-account' && method === 'GET') {
          expect(
            new URL(url, 'http://localhost').searchParams.get('workspaceId'),
          ).toBe(TEST_WORKSPACE_ID);
          return jsonResponse(200, {
            ok: true,
            data: { googleAccount: account },
          });
        }
        if (
          path === '/api/v1/me/google-account/connect' &&
          method === 'POST'
        ) {
          const body = JSON.parse(String(init?.body || '{}')) as {
            scopes?: string[];
          };
          googleConnectCalls.push({ scopes: body.scopes ?? [] });
          account = {
            connected: true,
            email: 'tester@example.com',
            displayName: 'Tester',
            scopes: body.scopes ?? [],
            accessExpiresAt: '2026-12-31T00:00:00.000Z',
          };
          return jsonResponse(200, {
            ok: true,
            data: {
              authorizationUrl: 'https://google.example/connect',
              expiresInSec: 300,
            },
          });
        }
        if (
          path === '/api/v1/me/google-account/expand-scopes' &&
          method === 'POST'
        ) {
          const body = JSON.parse(String(init?.body || '{}')) as {
            scopes?: string[];
          };
          googleExpandCalls.push({ scopes: body.scopes ?? [] });
          account = {
            ...account,
            connected: true,
            scopes: body.scopes ?? [],
          };
          return jsonResponse(200, {
            ok: true,
            data: {
              authorizationUrl: 'https://google.example/expand',
              expiresInSec: 300,
            },
          });
        }
        if (
          path === '/api/v1/me/google-account/disconnect' &&
          method === 'POST'
        ) {
          googleDisconnectCalls.push(TEST_WORKSPACE_ID);
          account = {
            connected: false,
            email: null,
            displayName: null,
            scopes: [],
            accessExpiresAt: null,
          };
          return jsonResponse(200, {
            ok: true,
            data: { disconnected: true },
          });
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      }),
    );

    return {
      getWebSearchSaveCalls: () => webSearchSaveCalls,
      getActiveProviderCalls: () => activeProviderCalls,
      getGoogleConnectCalls: () => googleConnectCalls,
      getGoogleExpandCalls: () => googleExpandCalls,
      getGoogleDisconnectCalls: () => googleDisconnectCalls,
    };
  }

  it('does NOT render the Google account section when the flag is unset', async () => {
    vi.stubEnv('VITE_GOOGLE_TOOLS_ENABLED', '');
    installToolsFetch({ connected: false });

    render(
      <MemoryRouter initialEntries={['/app/settings?tab=tools']}>
        <SettingsPage
          user={buildSessionUser()}
          userRole="owner"
          onUnauthorized={vi.fn()}
          onUserUpdated={vi.fn()}
        />
      </MemoryRouter>,
    );

    // The Tools section should render, but the Google account section
    // should NOT be present.
    await screen.findByRole('heading', { name: 'Tools' });
    expect(screen.queryByTestId('google-account-section')).toBeNull();
  });

  it('renders connect button when flag is on and account is disconnected', async () => {
    vi.stubEnv('VITE_GOOGLE_TOOLS_ENABLED', 'true');
    installToolsFetch({ connected: false });

    render(
      <MemoryRouter initialEntries={['/app/settings?tab=tools']}>
        <SettingsPage
          user={buildSessionUser()}
          userRole="owner"
          onUnauthorized={vi.fn()}
          onUserUpdated={vi.fn()}
        />
      </MemoryRouter>,
    );

    const section = await screen.findByTestId('google-account-section');
    expect(
      within(section).getByText(/No Google account connected/i),
    ).toBeTruthy();
    expect(
      within(section).getByRole('button', { name: /Connect Google account/i }),
    ).toBeTruthy();
    expect(
      within(section).queryByRole('button', { name: /Disconnect/i }),
    ).toBeNull();
  });

  it('renders disconnect button and email when flag is on and account is connected', async () => {
    vi.stubEnv('VITE_GOOGLE_TOOLS_ENABLED', 'true');
    installToolsFetch({ connected: true });

    render(
      <MemoryRouter initialEntries={['/app/settings?tab=tools']}>
        <SettingsPage
          user={buildSessionUser()}
          userRole="owner"
          onUnauthorized={vi.fn()}
          onUserUpdated={vi.fn()}
        />
      </MemoryRouter>,
    );

    const section = await screen.findByTestId('google-account-section');
    expect(within(section).getByText(/tester@example.com/)).toBeTruthy();
    expect(
      within(section).getByRole('button', { name: /Disconnect/i }),
    ).toBeTruthy();
    // Connect button should NOT be rendered when already connected (D4 UI gate)
    expect(
      within(section).queryByRole('button', {
        name: /Connect Google account/i,
      }),
    ).toBeNull();
  });

  it('Google tools: connects and disconnects through the action handlers', async () => {
    const user = userEvent.setup();
    vi.stubEnv('VITE_GOOGLE_TOOLS_ENABLED', 'true');
    const helpers = installToolsFetch({ connected: false });
    vi.spyOn(window, 'open').mockReturnValue({ closed: false } as Window);

    render(
      <MemoryRouter initialEntries={['/app/settings?tab=tools']}>
        <SettingsPage
          user={buildSessionUser()}
          userRole="owner"
          onUnauthorized={vi.fn()}
          onUserUpdated={vi.fn()}
        />
      </MemoryRouter>,
    );

    const section = await screen.findByTestId('google-account-section');
    await user.click(
      within(section).getByRole('button', { name: /Connect Google account/i }),
    );
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        data: { type: 'clawtalk:google-account-link', status: 'success' },
      }),
    );

    expect(await within(section).findByText('Google account connected.')).toBeTruthy();
    expect(helpers.getGoogleConnectCalls()).toEqual([
      { scopes: ['drive.readonly', 'documents', 'spreadsheets'] },
    ]);
    expect(within(section).getByText(/tester@example.com/)).toBeTruthy();

    await user.click(within(section).getByRole('button', { name: /Disconnect/i }));

    expect(
      await within(section).findByText('Google account disconnected.'),
    ).toBeTruthy();
    expect(helpers.getGoogleDisconnectCalls()).toEqual([TEST_WORKSPACE_ID]);
    expect(
      within(section).getByRole('button', { name: /Connect Google account/i }),
    ).toBeTruthy();
  });

  it('Google tools: re-requests missing required scopes', async () => {
    const user = userEvent.setup();
    vi.stubEnv('VITE_GOOGLE_TOOLS_ENABLED', 'true');
    const helpers = installToolsFetch({
      connected: true,
      scopes: ['drive.readonly'],
    });
    vi.spyOn(window, 'open').mockReturnValue({ closed: false } as Window);

    render(
      <MemoryRouter initialEntries={['/app/settings?tab=tools']}>
        <SettingsPage
          user={buildSessionUser()}
          userRole="owner"
          onUnauthorized={vi.fn()}
          onUserUpdated={vi.fn()}
        />
      </MemoryRouter>,
    );

    const section = await screen.findByTestId('google-account-section');
    expect(
      within(section).getByText(/Missing required scopes for Google Drive tools/),
    ).toBeTruthy();
    await user.click(
      within(section).getByRole('button', { name: /Re-request scopes/i }),
    );
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        data: { type: 'clawtalk:google-account-link', status: 'success' },
      }),
    );

    expect(await within(section).findByText('Scopes updated.')).toBeTruthy();
    expect(helpers.getGoogleExpandCalls()).toEqual([
      { scopes: ['drive.readonly', 'documents', 'spreadsheets'] },
    ]);
    expect(
      within(section).queryByText(
        /Missing required scopes for Google Drive tools/,
      ),
    ).toBeNull();
  });

  it('Tools tab: saves a web search key and marks the provider active', async () => {
    const user = userEvent.setup();
    vi.stubEnv('VITE_GOOGLE_TOOLS_ENABLED', '');
    const helpers = installToolsFetch({
      connected: false,
      webSearchProviders: [
        {
          id: 'web_search.tavily',
          name: 'Tavily',
          baseUrl: 'https://api.tavily.com',
          enabled: true,
          hasCredential: false,
          credentialHint: null,
          isActive: false,
        },
      ],
    });

    render(
      <MemoryRouter initialEntries={['/app/settings?tab=tools']}>
        <SettingsPage
          user={buildSessionUser()}
          userRole="owner"
          onUnauthorized={vi.fn()}
          onUserUpdated={vi.fn()}
        />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Web Search' });
    const tavilyCard = screen
      .getByRole('heading', { name: 'Tavily' })
      .closest('article');
    if (!tavilyCard) throw new Error('Tavily card not found');

    await user.type(
      within(tavilyCard).getByPlaceholderText('tvly-...'),
      'tvly-test-key',
    );
    await user.click(within(tavilyCard).getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Saved.')).toBeTruthy();
    expect(helpers.getWebSearchSaveCalls()).toEqual([
      { providerId: 'web_search.tavily', apiKey: 'tvly-test-key' },
    ]);

    await user.click(
      await screen.findByRole('button', { name: 'Set as active' }),
    );

    expect(await screen.findByText('Active provider updated.')).toBeTruthy();
    expect(helpers.getActiveProviderCalls()).toEqual(['web_search.tavily']);
    expect(screen.getByText('● Active')).toBeTruthy();
  });

  // ─── Connectors tab ──────────────────────────────────────────────────

  it('Connectors tab: admin sees both sections with bound-talk counts and status pills', async () => {
    installConnectorsFetch({
      channels: [
        {
          id: 'ch-1',
          kind: 'slack',
          displayName: 'Eng Slack',
          config: { workspace_id: 'T123', channel_id: 'C123' },
          hasCredential: false,
          enabled: true,
          boundTalkCount: 2,
          createdAt: '2026-05-22T00:00:00Z',
          updatedAt: '2026-05-22T00:00:00Z',
          createdBy: null,
          updatedBy: null,
        },
      ],
      dataConnectors: [
        {
          id: 'dc-1',
          kind: 'google_docs',
          displayName: 'Team docs',
          config: { folder_id: 'folder-1' },
          hasCredential: true,
          enabled: true,
          boundTalkCount: 0,
          createdAt: '2026-05-22T00:00:00Z',
          updatedAt: '2026-05-22T00:00:00Z',
          createdBy: null,
          updatedBy: null,
        },
      ],
    });

    render(
      <MemoryRouter initialEntries={['/app/settings?tab=connectors']}>
        <SettingsPage
          user={buildSessionUser()}
          userRole="owner"
          onUnauthorized={vi.fn()}
          onUserUpdated={vi.fn()}
        />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Channels available to talks' });
    expect(
      screen.getByRole('heading', { name: 'Data sources available to talks' }),
    ).toBeTruthy();
    expect(screen.getByText('Eng Slack')).toBeTruthy();
    expect(screen.getByText('Used by 2 talks')).toBeTruthy();
    // Slack channel has no credential → amber pill
    expect(screen.getByLabelText('Credential missing')).toBeTruthy();
    // Google Docs has credential + enabled → Configuration only pill
    expect(screen.getByLabelText('Configuration only')).toBeTruthy();
  });

  it('Connectors tab: admin sees connected Slack workspaces with bound-channel counts', async () => {
    installConnectorsFetchByWorkspace({
      [TEST_WORKSPACE_ID]: {
        channels: [],
        dataConnectors: [],
        slackInstalls: [
          {
            teamId: 'T123',
            teamName: 'ClawTalk HQ',
            installedAt: '2026-05-22T00:00:00Z',
            boundChannelCount: 2,
          },
        ],
      },
    });

    render(
      <MemoryRouter initialEntries={['/app/settings?tab=connectors']}>
        <SettingsPage
          user={buildSessionUser()}
          userRole="owner"
          onUnauthorized={vi.fn()}
          onUserUpdated={vi.fn()}
        />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Slack workspaces' });
    expect(screen.getByText('ClawTalk HQ')).toBeTruthy();
    expect(screen.getByText('T123')).toBeTruthy();
    expect(screen.getByText('2 channels')).toBeTruthy();
    expect(
      screen.getByRole('button', {
        name: 'Disconnect Slack workspace ClawTalk HQ',
      }),
    ).toBeTruthy();
  });

  it('Connectors tab: trusts API credential status for Slack channels', async () => {
    installConnectorsFetch({
      channels: [
        {
          id: 'ch-1',
          kind: 'slack',
          displayName: 'Eng Slack',
          config: { teamId: 'T123', channel_id: 'C123' },
          hasCredential: true,
          enabled: true,
          boundTalkCount: 0,
          createdAt: '2026-05-22T00:00:00Z',
          updatedAt: '2026-05-22T00:00:00Z',
          createdBy: null,
          updatedBy: null,
        },
      ],
      dataConnectors: [],
    });

    render(
      <MemoryRouter initialEntries={['/app/settings?tab=connectors']}>
        <SettingsPage
          user={buildSessionUser()}
          userRole="owner"
          onUnauthorized={vi.fn()}
          onUserUpdated={vi.fn()}
        />
      </MemoryRouter>,
    );

    await screen.findByText('Eng Slack');
    expect(screen.getByLabelText('Configuration only')).toBeTruthy();
    expect(screen.queryByLabelText('Credential missing')).toBeNull();
  });

  it('Connectors tab: reloads connector rows when the current workspace changes', async () => {
    const helpers = installConnectorsFetchByWorkspace({
      [TEST_WORKSPACE_ID]: {
        channels: [
          {
            id: 'ch-workspace-a',
            kind: 'slack',
            displayName: 'Workspace A Slack',
            config: { teamId: 'T-A', channel_id: 'C-A' },
            hasCredential: true,
            enabled: true,
            boundTalkCount: 0,
            createdAt: '2026-05-22T00:00:00Z',
            updatedAt: '2026-05-22T00:00:00Z',
            createdBy: null,
            updatedBy: null,
          },
        ],
        dataConnectors: [],
      },
      [SECOND_WORKSPACE_ID]: {
        channels: [
          {
            id: 'ch-workspace-b',
            kind: 'slack',
            displayName: 'Workspace B Slack',
            config: { teamId: 'T-B', channel_id: 'C-B' },
            hasCredential: true,
            enabled: true,
            boundTalkCount: 0,
            createdAt: '2026-05-22T00:00:00Z',
            updatedAt: '2026-05-22T00:00:00Z',
            createdBy: null,
            updatedBy: null,
          },
        ],
        dataConnectors: [],
      },
    });
    const onUnauthorized = vi.fn();
    const onUserUpdated = vi.fn();
    const workspaces = [
      {
        id: TEST_WORKSPACE_ID,
        name: 'Workspace A',
        role: 'owner' as const,
        initials: 'WA',
      },
      {
        id: SECOND_WORKSPACE_ID,
        name: 'Workspace B',
        role: 'owner' as const,
        initials: 'WB',
      },
    ];

    const view = render(
      <MemoryRouter initialEntries={['/app/settings?tab=connectors']}>
        <SettingsPage
          user={buildSessionUser({
            currentWorkspaceId: TEST_WORKSPACE_ID,
            workspaces,
          })}
          userRole="owner"
          onUnauthorized={onUnauthorized}
          onUserUpdated={onUserUpdated}
        />
      </MemoryRouter>,
    );

    await screen.findByText('Workspace A Slack');

    view.rerender(
      <MemoryRouter initialEntries={['/app/settings?tab=connectors']}>
        <SettingsPage
          user={buildSessionUser({
            currentWorkspaceId: SECOND_WORKSPACE_ID,
            workspaces,
          })}
          userRole="owner"
          onUnauthorized={onUnauthorized}
          onUserUpdated={onUserUpdated}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Workspace B Slack')).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByText('Workspace A Slack')).toBeNull(),
    );
    expect(helpers.getWorkspaceIds()).toEqual(
      expect.arrayContaining([TEST_WORKSPACE_ID, SECOND_WORKSPACE_ID]),
    );
  });

  it('Connectors tab: member sees rows but no Add/Edit/Delete affordances', async () => {
    installConnectorsFetch({
      channels: [
        {
          id: 'ch-1',
          kind: 'slack',
          displayName: 'Eng Slack',
          config: {},
          hasCredential: true,
          enabled: true,
          boundTalkCount: 0,
          createdAt: '2026-05-22T00:00:00Z',
          updatedAt: '2026-05-22T00:00:00Z',
          createdBy: null,
          updatedBy: null,
        },
      ],
      dataConnectors: [],
    });

    render(
      <MemoryRouter initialEntries={['/app/settings?tab=connectors']}>
        <SettingsPage
          user={buildSessionUser()}
          userRole="member"
          onUnauthorized={vi.fn()}
          onUserUpdated={vi.fn()}
        />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Channels available to talks' });
    expect(screen.queryByRole('button', { name: '+ Add channel' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Edit Slack/i })).toBeNull();
  });

  it('Connectors tab: Delete shows confirmation modal naming the bound talk count', async () => {
    const helpers = installConnectorsFetch({
      channels: [
        {
          id: 'ch-1',
          kind: 'slack',
          displayName: 'Eng Slack',
          config: {},
          hasCredential: true,
          enabled: true,
          boundTalkCount: 3,
          createdAt: '2026-05-22T00:00:00Z',
          updatedAt: '2026-05-22T00:00:00Z',
          createdBy: null,
          updatedBy: null,
        },
      ],
      dataConnectors: [],
    });
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/app/settings?tab=connectors']}>
        <SettingsPage
          user={buildSessionUser()}
          userRole="owner"
          onUnauthorized={vi.fn()}
          onUserUpdated={vi.fn()}
        />
      </MemoryRouter>,
    );

    await screen.findByText('Eng Slack');
    await user.click(
      screen.getByRole('button', {
        name: /Delete Slack channel: Eng Slack/,
      }),
    );

    expect(
      screen.getByRole('heading', { name: /Delete Eng Slack/ }),
    ).toBeTruthy();
    expect(
      screen.getByText(/removes this connector from 3 talks/),
    ).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Delete connector' }));

    expect(helpers.getDeleteChannelCalls()).toContain('ch-1');
  });
});

type WorkspaceChannelFixture = {
  id: string;
  kind: 'slack';
  displayName: string;
  config: Record<string, unknown>;
  hasCredential: boolean;
  enabled: boolean;
  boundTalkCount: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
};

type WorkspaceDataConnectorFixture = {
  id: string;
  kind: 'google_docs' | 'google_sheets';
  displayName: string;
  config: Record<string, unknown>;
  hasCredential: boolean;
  enabled: boolean;
  boundTalkCount: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
};

function installConnectorsFetch(seed: {
  channels: WorkspaceChannelFixture[];
  dataConnectors: WorkspaceDataConnectorFixture[];
}) {
  let channels = [...seed.channels];
  let dataConnectors = [...seed.dataConnectors];
  const deleteChannelCalls: string[] = [];
  const deleteDataConnectorCalls: string[] = [];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof request === 'string'
          ? request
          : request instanceof URL
            ? request.toString()
            : request instanceof Request
              ? request.url
              : String(request);
      const method = init?.method || 'GET';
      const parsed = new URL(url, 'http://localhost');
      const path = parsed.pathname;
      expect(parsed.searchParams.get('workspaceId')).toBe(TEST_WORKSPACE_ID);

      if (path === '/api/v1/workspace/channels' && method === 'GET') {
        return jsonResponse(200, {
          ok: true,
          data: { channels },
        });
      }
      if (path === '/api/v1/workspace/data-connectors' && method === 'GET') {
        return jsonResponse(200, {
          ok: true,
          data: { dataConnectors },
        });
      }
      if (
        path === '/api/v1/workspace/connectors/slack/installs' &&
        method === 'GET'
      ) {
        return jsonResponse(200, { ok: true, data: { installs: [] } });
      }
      const deleteChannelMatch = path.match(
        /\/api\/v1\/workspace\/channels\/([^/?]+)$/,
      );
      if (deleteChannelMatch && method === 'DELETE') {
        const id = decodeURIComponent(deleteChannelMatch[1]);
        deleteChannelCalls.push(id);
        channels = channels.filter((c) => c.id !== id);
        return jsonResponse(200, { ok: true, data: { deleted: true } });
      }
      const deleteDcMatch = path.match(
        /\/api\/v1\/workspace\/data-connectors\/([^/?]+)$/,
      );
      if (deleteDcMatch && method === 'DELETE') {
        const id = decodeURIComponent(deleteDcMatch[1]);
        deleteDataConnectorCalls.push(id);
        dataConnectors = dataConnectors.filter((d) => d.id !== id);
        return jsonResponse(200, { ok: true, data: { deleted: true } });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    }),
  );

  return {
    getDeleteChannelCalls: () => deleteChannelCalls,
    getDeleteDataConnectorCalls: () => deleteDataConnectorCalls,
  };
}

function installConnectorsFetchByWorkspace(
  seed: Record<
    string,
    {
      channels: WorkspaceChannelFixture[];
      dataConnectors: WorkspaceDataConnectorFixture[];
      slackInstalls?: Array<{
        teamId: string;
        teamName: string;
        installedAt: string;
        boundChannelCount: number;
      }>;
    }
  >,
) {
  const workspaceIds: string[] = [];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof request === 'string'
          ? request
          : request instanceof URL
            ? request.toString()
            : request instanceof Request
              ? request.url
              : String(request);
      const method = init?.method || 'GET';
      const parsed = new URL(url, 'http://localhost');
      const path = parsed.pathname;
      const workspaceId = parsed.searchParams.get('workspaceId') ?? '';
      const dataset = seed[workspaceId];
      workspaceIds.push(workspaceId);
      if (!dataset) {
        throw new Error(`Unexpected workspaceId: ${workspaceId}`);
      }

      if (path === '/api/v1/workspace/channels' && method === 'GET') {
        return jsonResponse(200, {
          ok: true,
          data: { channels: dataset.channels },
        });
      }
      if (path === '/api/v1/workspace/data-connectors' && method === 'GET') {
        return jsonResponse(200, {
          ok: true,
          data: { dataConnectors: dataset.dataConnectors },
        });
      }
      if (
        path === '/api/v1/workspace/connectors/slack/installs' &&
        method === 'GET'
      ) {
        return jsonResponse(200, {
          ok: true,
          data: { installs: dataset.slackInstalls ?? [] },
        });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    }),
  );

  return {
    getWorkspaceIds: () => workspaceIds,
  };
}
