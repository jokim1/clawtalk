import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { TalkConnectorsPanel } from './TalkConnectorsPanel';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type Channel = {
  id: string;
  kind: 'slack';
  displayName: string;
  enabled: boolean;
  hasCredential: boolean;
  linked: boolean;
};

type DataConnector = {
  id: string;
  kind: 'google_docs' | 'google_sheets';
  displayName: string;
  enabled: boolean;
  hasCredential: boolean;
  linked: boolean;
};

function installFetch(seed: {
  channels: Channel[];
  dataConnectors: DataConnector[];
}) {
  const channels = [...seed.channels];
  const dataConnectors = [...seed.dataConnectors];
  const channelPutCalls: Array<{ talkId: string; channelId: string }> = [];
  const channelDeleteCalls: Array<{ talkId: string; channelId: string }> = [];
  const dataConnectorPutCalls: Array<{
    talkId: string;
    connectorId: string;
  }> = [];
  const dataConnectorDeleteCalls: Array<{
    talkId: string;
    connectorId: string;
  }> = [];

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

      const connectorsMatch = url.match(
        /\/api\/v1\/talks\/([^/?]+)\/connectors$/,
      );
      if (connectorsMatch && method === 'GET') {
        return jsonResponse(200, {
          ok: true,
          data: { channels, dataConnectors },
        });
      }

      const channelLinkMatch = url.match(
        /\/api\/v1\/talks\/([^/?]+)\/connectors\/channels\/([^/?]+)$/,
      );
      if (channelLinkMatch && method === 'PUT') {
        channelPutCalls.push({
          talkId: decodeURIComponent(channelLinkMatch[1]),
          channelId: decodeURIComponent(channelLinkMatch[2]),
        });
        return jsonResponse(200, { ok: true, data: { linked: true } });
      }
      if (channelLinkMatch && method === 'DELETE') {
        channelDeleteCalls.push({
          talkId: decodeURIComponent(channelLinkMatch[1]),
          channelId: decodeURIComponent(channelLinkMatch[2]),
        });
        return jsonResponse(200, { ok: true, data: { unlinked: true } });
      }

      const dcLinkMatch = url.match(
        /\/api\/v1\/talks\/([^/?]+)\/connectors\/data-connectors\/([^/?]+)$/,
      );
      if (dcLinkMatch && method === 'PUT') {
        dataConnectorPutCalls.push({
          talkId: decodeURIComponent(dcLinkMatch[1]),
          connectorId: decodeURIComponent(dcLinkMatch[2]),
        });
        return jsonResponse(200, { ok: true, data: { linked: true } });
      }
      if (dcLinkMatch && method === 'DELETE') {
        dataConnectorDeleteCalls.push({
          talkId: decodeURIComponent(dcLinkMatch[1]),
          connectorId: decodeURIComponent(dcLinkMatch[2]),
        });
        return jsonResponse(200, { ok: true, data: { unlinked: true } });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    }),
  );

  return {
    channelPutCalls,
    channelDeleteCalls,
    dataConnectorPutCalls,
    dataConnectorDeleteCalls,
  };
}

describe('TalkConnectorsPanel', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders Channels and Data sources sections with toggle rows', async () => {
    installFetch({
      channels: [
        {
          id: 'ch-1',
          kind: 'slack',
          displayName: 'Eng Slack',
          enabled: true,
          hasCredential: true,
          linked: false,
        },
      ],
      dataConnectors: [
        {
          id: 'dc-1',
          kind: 'google_sheets',
          displayName: 'Metrics sheet',
          enabled: true,
          hasCredential: true,
          linked: true,
        },
      ],
    });

    render(
      <MemoryRouter>
        <TalkConnectorsPanel talkId="talk-1" onUnauthorized={vi.fn()} />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Connectors for this talk' });
    expect(screen.getByRole('heading', { name: 'Channels' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Data sources' })).toBeTruthy();
    expect(screen.getByText('Eng Slack')).toBeTruthy();
    expect(screen.getByText('Metrics sheet')).toBeTruthy();

    const slackToggle = screen.getByRole('switch', {
      name: /Enable channel Eng Slack/,
    });
    expect(slackToggle.getAttribute('aria-checked')).toBe('false');

    const googleSheetsToggle = screen.getByRole('switch', {
      name: /Disable data source Metrics sheet/,
    });
    expect(googleSheetsToggle.getAttribute('aria-checked')).toBe('true');
  });

  it('toggle ON calls PUT against the talk-channel link endpoint', async () => {
    const calls = installFetch({
      channels: [
        {
          id: 'ch-1',
          kind: 'slack',
          displayName: 'Eng Slack',
          enabled: true,
          hasCredential: true,
          linked: false,
        },
      ],
      dataConnectors: [],
    });
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <TalkConnectorsPanel talkId="talk-1" onUnauthorized={vi.fn()} />
      </MemoryRouter>,
    );

    await screen.findByText('Eng Slack');
    await user.click(
      screen.getByRole('switch', { name: /Enable channel Eng Slack/ }),
    );

    expect(calls.channelPutCalls).toEqual([
      { talkId: 'talk-1', channelId: 'ch-1' },
    ]);
  });

  it('blocks enabling missing credentials but still allows unlinking', async () => {
    const calls = installFetch({
      channels: [
        {
          id: 'ch-missing',
          kind: 'slack',
          displayName: 'Missing Slack',
          enabled: true,
          hasCredential: false,
          linked: false,
        },
      ],
      dataConnectors: [
        {
          id: 'dc-linked-missing',
          kind: 'google_docs',
          displayName: 'Broken Docs',
          enabled: true,
          hasCredential: false,
          linked: true,
        },
      ],
    });
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <TalkConnectorsPanel talkId="talk-1" onUnauthorized={vi.fn()} />
      </MemoryRouter>,
    );

    await screen.findByText('Missing Slack');
    expect(screen.getAllByLabelText('Credential missing')).toHaveLength(2);
    expect(
      screen.getByRole('switch', { name: /Enable channel Missing Slack/ }),
    ).toBeDisabled();

    const linkedMissing = screen.getByRole('switch', {
      name: /Disable data source Broken Docs/,
    });
    expect(linkedMissing).not.toBeDisabled();
    await user.click(linkedMissing);

    expect(calls.dataConnectorDeleteCalls).toEqual([
      { talkId: 'talk-1', connectorId: 'dc-linked-missing' },
    ]);
  });

  it('empty state nudges users to Settings → Connectors', async () => {
    installFetch({ channels: [], dataConnectors: [] });

    render(
      <MemoryRouter>
        <TalkConnectorsPanel talkId="talk-1" onUnauthorized={vi.fn()} />
      </MemoryRouter>,
    );

    await screen.findByText(/No connectors set up yet/);
    expect(
      screen.getByRole('link', { name: 'Settings → Connectors' }),
    ).toBeTruthy();
  });
});
