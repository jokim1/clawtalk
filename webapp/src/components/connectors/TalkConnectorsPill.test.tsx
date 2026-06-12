import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TalkConnectorsPill } from './TalkConnectorsPill';

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
  const dataConnectorPutCalls: Array<{
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
        /\/api\/v1\/talks\/([^/?]+)\/connector-bindings$/,
      );
      if (connectorsMatch && method === 'GET') {
        return jsonResponse(200, {
          ok: true,
          data: { channels, dataConnectors },
        });
      }

      const channelLinkMatch = url.match(
        /\/api\/v1\/talks\/([^/?]+)\/channel-bindings\/([^/?]+)$/,
      );
      if (channelLinkMatch && method === 'PUT') {
        channelPutCalls.push({
          talkId: decodeURIComponent(channelLinkMatch[1]),
          channelId: decodeURIComponent(channelLinkMatch[2]),
        });
        return jsonResponse(200, { ok: true, data: { linked: true } });
      }

      const dcLinkMatch = url.match(
        /\/api\/v1\/talks\/([^/?]+)\/source-bindings\/([^/?]+)$/,
      );
      if (dcLinkMatch && method === 'PUT') {
        dataConnectorPutCalls.push({
          talkId: decodeURIComponent(dcLinkMatch[1]),
          connectorId: decodeURIComponent(dcLinkMatch[2]),
        });
        return jsonResponse(200, { ok: true, data: { linked: true } });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    }),
  );

  return { channelPutCalls, dataConnectorPutCalls };
}

describe('TalkConnectorsPill', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('opens a connector dropdown with bound count and Add connection link', async () => {
    installFetch({
      channels: [
        {
          id: 'slack-pricing',
          kind: 'slack',
          displayName: '#pricing',
          enabled: true,
          hasCredential: true,
          linked: true,
        },
      ],
      dataConnectors: [
        {
          id: 'drive-pricing',
          kind: 'google_docs',
          displayName: '/pricing-v2/',
          enabled: true,
          hasCredential: true,
          linked: true,
        },
        {
          id: 'drive-research',
          kind: 'google_sheets',
          displayName: 'Research sheet',
          enabled: true,
          hasCredential: true,
          linked: false,
        },
      ],
    });
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <TalkConnectorsPill talkId="talk-1" onUnauthorized={vi.fn()} />
      </MemoryRouter>,
    );

    const trigger = await screen.findByRole('button', {
      name: 'Connectors, 2 of 3 bound',
    });
    await user.click(trigger);

    expect(
      await screen.findByRole('dialog', { name: 'Connectors in this Talk' }),
    ).toBeTruthy();
    expect(screen.getByText('2 of 3 bound')).toBeTruthy();
    expect(screen.getByText('Slack · #pricing')).toBeTruthy();
    expect(screen.getByText('Drive · /pricing-v2/')).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: /Add connection/ })
        .getAttribute('href'),
    ).toBe('/app/settings?tab=connectors');
  });

  it('optimistically updates the toolbar count when enabling a connector', async () => {
    const calls = installFetch({
      channels: [
        {
          id: 'slack-eng',
          kind: 'slack',
          displayName: '#eng',
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
        <TalkConnectorsPill talkId="talk-1" onUnauthorized={vi.fn()} />
      </MemoryRouter>,
    );

    await user.click(
      await screen.findByRole('button', {
        name: 'Connectors, 0 of 1 bound',
      }),
    );
    await user.click(
      screen.getByRole('switch', {
        name: 'Enable Slack #eng for this Talk',
      }),
    );

    expect(calls.channelPutCalls).toEqual([
      { talkId: 'talk-1', channelId: 'slack-eng' },
    ]);
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Connectors, 1 of 1 bound' }),
      ).toBeTruthy();
    });
  });
});
