// Per-Talk connectors picker. Drops into TalkDetailPage's 'connectors' tab.
// Toggle ON = link channel/data-connector to this talk. Toggle OFF = unlink.
// Optimistic: snap on click, rollback on failure with a toast message.
// Workspace-disabled rows render as non-interactive with "Disabled by admin".

import { Link } from 'react-router-dom';
import { useEffect, useState } from 'react';

import {
  type ChannelKind,
  type DataConnectorKind,
  type TalkConnectorsView,
  type TalkConnectorChannelRow,
  type TalkConnectorDataConnectorRow,
  UnauthorizedError,
  deleteTalkChannelLink,
  deleteTalkDataConnectorLink,
  getTalkConnectors,
  setTalkChannelLink,
  setTalkDataConnectorLink,
} from '../../lib/api';

import { ConnectorStatusPill } from './StatusPill';

type Props = {
  talkId: string;
  onUnauthorized: () => void;
};

const CHANNEL_KIND_LABELS: Record<ChannelKind, string> = {
  slack: 'Slack',
};

const DATA_CONNECTOR_KIND_LABELS: Record<DataConnectorKind, string> = {
  google_docs: 'Google Docs',
  google_sheets: 'Google Sheets',
};

function channelKindLabel(kind: string): string {
  return CHANNEL_KIND_LABELS[kind as ChannelKind] ?? 'Unsupported channel';
}

function dataConnectorKindLabel(kind: string): string {
  return (
    DATA_CONNECTOR_KIND_LABELS[kind as DataConnectorKind] ??
    'Unsupported data source'
  );
}

function toggleDisabled(row: {
  enabled: boolean;
  hasCredential: boolean;
  linked: boolean;
}): boolean {
  return !row.enabled || (!row.linked && !row.hasCredential);
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; view: TalkConnectorsView }
  | { kind: 'error'; message: string };

export function TalkConnectorsPanel({
  talkId,
  onUnauthorized,
}: Props): JSX.Element {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    void (async () => {
      try {
        const view = await getTalkConnectors(talkId);
        if (cancelled) return;
        setState({ kind: 'ready', view });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        setState({
          kind: 'error',
          message:
            err instanceof Error ? err.message : 'Failed to load connectors.',
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [talkId, onUnauthorized]);

  if (state.kind === 'loading') {
    return (
      <section className="talk-tab-panel" aria-label="Connectors for this talk">
        <p className="page-state">Loading connectors…</p>
      </section>
    );
  }

  if (state.kind === 'error') {
    return (
      <section className="talk-tab-panel" aria-label="Connectors for this talk">
        <p className="page-state error" role="alert">
          {state.message}
        </p>
      </section>
    );
  }

  const view = state.view;

  const toggleChannel = async (channel: TalkConnectorChannelRow) => {
    if (!channel.enabled) return;
    // Optimistic
    setState({
      kind: 'ready',
      view: {
        ...view,
        channels: view.channels.map((c) =>
          c.id === channel.id ? { ...c, linked: !c.linked } : c,
        ),
      },
    });
    try {
      if (channel.linked) {
        await deleteTalkChannelLink({ talkId, channelId: channel.id });
      } else {
        await setTalkChannelLink({ talkId, channelId: channel.id });
      }
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      // Rollback
      setState({ kind: 'ready', view });
      setToast('Couldn’t update connector. Try again.');
      window.setTimeout(() => setToast(null), 3500);
    }
  };

  const toggleDataConnector = async (dc: TalkConnectorDataConnectorRow) => {
    if (!dc.enabled) return;
    setState({
      kind: 'ready',
      view: {
        ...view,
        dataConnectors: view.dataConnectors.map((d) =>
          d.id === dc.id ? { ...d, linked: !d.linked } : d,
        ),
      },
    });
    try {
      if (dc.linked) {
        await deleteTalkDataConnectorLink({ talkId, connectorId: dc.id });
      } else {
        await setTalkDataConnectorLink({ talkId, connectorId: dc.id });
      }
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setState({ kind: 'ready', view });
      setToast('Couldn’t update connector. Try again.');
      window.setTimeout(() => setToast(null), 3500);
    }
  };

  const totalAvailable = view.channels.length + view.dataConnectors.length;
  if (totalAvailable === 0) {
    return (
      <section className="talk-tab-panel" aria-label="Connectors for this talk">
        <h2>Connectors for this talk</h2>
        <p className="page-state">
          No connectors set up yet. Ask your workspace admin to add one in{' '}
          <Link to="/app/settings?tab=connectors">Settings → Connectors</Link>.
        </p>
      </section>
    );
  }

  return (
    <section className="talk-tab-panel" aria-label="Connectors for this talk">
      <h2>Connectors for this talk</h2>

      <div className="talk-connectors-section">
        <header className="agents-panel-header">
          <h3>Channels</h3>
          <Link
            to="/app/settings?tab=connectors"
            className="talk-connectors-section-footer-link"
          >
            Defined in Settings → Connectors
          </Link>
        </header>
        {view.channels.length === 0 ? (
          <p className="page-state">No channels defined for this workspace.</p>
        ) : (
          view.channels.map((channel) => (
            <div
              key={channel.id}
              className="talk-connector-toggle-row"
              role="group"
              aria-label={channel.displayName}
            >
              <button
                type="button"
                role="switch"
                className="talk-connector-toggle"
                aria-checked={channel.linked}
                aria-label={`${
                  channel.linked ? 'Disable' : 'Enable'
                } channel ${channel.displayName} for this talk`}
                onClick={() => void toggleChannel(channel)}
                disabled={toggleDisabled(channel)}
              >
                {channel.linked ? 'On' : 'Off'}
              </button>
              <div className="talk-connector-row-meta">
                <strong>{channel.displayName}</strong>
                <span className="talk-connector-row-kind">
                  {channelKindLabel(channel.kind)}
                </span>
              </div>
              <ConnectorStatusPill
                enabled={channel.enabled}
                hasCredential={channel.hasCredential}
              />
            </div>
          ))
        )}
      </div>

      <div className="talk-connectors-section">
        <header className="agents-panel-header">
          <h3>Data sources</h3>
          <Link
            to="/app/settings?tab=connectors"
            className="talk-connectors-section-footer-link"
          >
            Defined in Settings → Connectors
          </Link>
        </header>
        {view.dataConnectors.length === 0 ? (
          <p className="page-state">
            No data sources defined for this workspace.
          </p>
        ) : (
          view.dataConnectors.map((dc) => (
            <div
              key={dc.id}
              className="talk-connector-toggle-row"
              role="group"
              aria-label={dc.displayName}
            >
              <button
                type="button"
                role="switch"
                className="talk-connector-toggle"
                aria-checked={dc.linked}
                aria-label={`${
                  dc.linked ? 'Disable' : 'Enable'
                } data source ${dc.displayName} for this talk`}
                onClick={() => void toggleDataConnector(dc)}
                disabled={toggleDisabled(dc)}
              >
                {dc.linked ? 'On' : 'Off'}
              </button>
              <div className="talk-connector-row-meta">
                <strong>{dc.displayName}</strong>
                <span className="talk-connector-row-kind">
                  {dataConnectorKindLabel(dc.kind)}
                </span>
              </div>
              <ConnectorStatusPill
                enabled={dc.enabled}
                hasCredential={dc.hasCredential}
              />
            </div>
          ))
        )}
      </div>

      {toast ? (
        <div className="talk-connectors-toast" role="status" aria-live="polite">
          {toast}
        </div>
      ) : null}
    </section>
  );
}
