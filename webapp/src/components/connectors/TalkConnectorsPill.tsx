import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import {
  type ChannelKind,
  type DataConnectorKind,
  type TalkConnectorChannelRow,
  type TalkConnectorDataConnectorRow,
  type TalkConnectorsView,
  UnauthorizedError,
  deleteTalkChannelLink,
  deleteTalkDataConnectorLink,
  getTalkConnectors,
  setTalkChannelLink,
  setTalkDataConnectorLink,
} from '../../lib/api';
import { CTIcon, Popover, salon } from '../../salon';

type TalkConnectorsPillProps = {
  talkId: string;
  onUnauthorized: () => void;
  active?: boolean;
};

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; view: TalkConnectorsView }
  | { kind: 'error'; message: string };

type ConnectorPopoverRow =
  | {
      type: 'channel';
      id: string;
      service: string;
      name: string;
      capabilities: string;
      enabled: boolean;
      hasCredential: boolean;
      linked: boolean;
      row: TalkConnectorChannelRow;
    }
  | {
      type: 'dataConnector';
      id: string;
      service: string;
      name: string;
      capabilities: string;
      enabled: boolean;
      hasCredential: boolean;
      linked: boolean;
      row: TalkConnectorDataConnectorRow;
    };

const SETTINGS_CONNECTORS_HREF = '/app/settings?tab=connectors';

const CHANNEL_KIND_LABELS: Record<ChannelKind, string> = {
  slack: 'Slack',
};

const DATA_CONNECTOR_KIND_LABELS: Record<DataConnectorKind, string> = {
  google_docs: 'Drive',
  google_sheets: 'Drive',
};

function channelKindLabel(kind: string): string {
  return CHANNEL_KIND_LABELS[kind as ChannelKind] ?? 'Channel';
}

function dataConnectorKindLabel(kind: string): string {
  return DATA_CONNECTOR_KIND_LABELS[kind as DataConnectorKind] ?? 'Connector';
}

function countConnectors(view: TalkConnectorsView): {
  total: number;
  linked: number;
} {
  const rows = [...view.channels, ...view.dataConnectors];
  return {
    total: rows.length,
    linked: rows.filter((row) => row.linked).length,
  };
}

function toggleDisabled(row: {
  enabled: boolean;
  hasCredential: boolean;
  linked: boolean;
}): boolean {
  return !row.enabled || (!row.linked && !row.hasCredential);
}

function serviceInitial(service: string): string {
  return service.trim().charAt(0).toUpperCase() || 'C';
}

function toPopoverRows(view: TalkConnectorsView): ConnectorPopoverRow[] {
  return [
    ...view.channels.map(
      (channel): ConnectorPopoverRow => ({
        type: 'channel',
        id: channel.id,
        service: channelKindLabel(channel.kind),
        name: channel.displayName,
        capabilities: 'read · post',
        enabled: channel.enabled,
        hasCredential: channel.hasCredential,
        linked: channel.linked,
        row: channel,
      }),
    ),
    ...view.dataConnectors.map(
      (connector): ConnectorPopoverRow => ({
        type: 'dataConnector',
        id: connector.id,
        service: dataConnectorKindLabel(connector.kind),
        name: connector.displayName,
        capabilities: 'read',
        enabled: connector.enabled,
        hasCredential: connector.hasCredential,
        linked: connector.linked,
        row: connector,
      }),
    ),
  ];
}

export function TalkConnectorsPill({
  talkId,
  onUnauthorized,
  active = false,
}: TalkConnectorsPillProps): JSX.Element {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    void (async () => {
      try {
        const view = await getTalkConnectors(talkId);
        if (!cancelled) setState({ kind: 'ready', view });
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

  const counts =
    state.kind === 'ready'
      ? countConnectors(state.view)
      : { total: 0, linked: 0 };
  const boundLabel = `${counts.linked} of ${counts.total} bound`;

  const showTransientError = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 3500);
  };

  const toggleChannel = async (channel: TalkConnectorChannelRow) => {
    if (state.kind !== 'ready' || toggleDisabled(channel)) return;
    const previousView = state.view;
    const nextLinked = !channel.linked;
    setState({
      kind: 'ready',
      view: {
        ...previousView,
        channels: previousView.channels.map((candidate) =>
          candidate.id === channel.id
            ? { ...candidate, linked: nextLinked }
            : candidate,
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
      setState({ kind: 'ready', view: previousView });
      showTransientError('Couldn’t update connector. Try again.');
    }
  };

  const toggleDataConnector = async (
    connector: TalkConnectorDataConnectorRow,
  ) => {
    if (state.kind !== 'ready' || toggleDisabled(connector)) return;
    const previousView = state.view;
    const nextLinked = !connector.linked;
    setState({
      kind: 'ready',
      view: {
        ...previousView,
        dataConnectors: previousView.dataConnectors.map((candidate) =>
          candidate.id === connector.id
            ? { ...candidate, linked: nextLinked }
            : candidate,
        ),
      },
    });
    try {
      if (connector.linked) {
        await deleteTalkDataConnectorLink({
          talkId,
          connectorId: connector.id,
        });
      } else {
        await setTalkDataConnectorLink({ talkId, connectorId: connector.id });
      }
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setState({ kind: 'ready', view: previousView });
      showTransientError('Couldn’t update connector. Try again.');
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`talk-orchestration-trigger talk-connectors-pill${
          open || active ? ' talk-orchestration-trigger-open' : ''
        }`}
        onClick={() => {
          setAnchorRect(triggerRef.current?.getBoundingClientRect() ?? null);
          setOpen((current) => !current);
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Connectors, ${boundLabel}`}
        title={`${boundLabel} in this Talk`}
      >
        <span className="talk-orchestration-trigger-icon" aria-hidden="true">
          <CTIcon name="globe" size={13} strokeWidth={1.7} />
        </span>
        <span className="talk-orchestration-trigger-text">Connectors</span>
        <span
          className={`talk-tab-badge${
            counts.linked > 0 ? ' talk-tab-badge-on' : ''
          }`}
          aria-hidden="true"
        >
          {counts.linked}
        </span>
      </button>

      {open ? (
        <Popover
          anchorRect={anchorRect}
          onClose={() => setOpen(false)}
          width={320}
          ariaLabel="Connectors in this Talk"
        >
          <div className="talk-connectors-popover">
            <header className="talk-connectors-popover-header">
              <span className="talk-connectors-popover-icon" aria-hidden="true">
                <CTIcon name="globe" size={13} stroke={salon.ink2} />
              </span>
              <span className="talk-connectors-popover-title">
                Connectors in this Talk
              </span>
              <span className="talk-connectors-popover-count">
                {boundLabel}
              </span>
            </header>

            {state.kind === 'loading' ? (
              <p className="talk-connectors-popover-state">
                Loading connectors…
              </p>
            ) : null}

            {state.kind === 'error' ? (
              <p className="talk-connectors-popover-state error" role="alert">
                {state.message}
              </p>
            ) : null}

            {state.kind === 'ready' ? (
              <>
                <p className="talk-connectors-popover-copy">
                  External services this Talk is wired into. Manage
                  workspace-wide connections in{' '}
                  <Link
                    to={SETTINGS_CONNECTORS_HREF}
                    onClick={() => setOpen(false)}
                  >
                    Settings → Connectors
                  </Link>
                  .
                </p>

                {counts.total === 0 ? (
                  <p className="talk-connectors-popover-empty">
                    No connectors set up yet.
                  </p>
                ) : (
                  <ul className="talk-connectors-popover-list">
                    {toPopoverRows(state.view).map((row) => {
                      const disabled = toggleDisabled(row);
                      const switchLabel = `${
                        row.linked ? 'Disable' : 'Enable'
                      } ${row.service} ${row.name} for this Talk`;
                      return (
                        <li
                          key={`${row.type}-${row.id}`}
                          className={`talk-connectors-popover-row${
                            disabled
                              ? ' talk-connectors-popover-row-disabled'
                              : ''
                          }`}
                        >
                          <span
                            className="talk-connectors-popover-avatar"
                            aria-hidden="true"
                          >
                            {serviceInitial(row.service)}
                          </span>
                          <span className="talk-connectors-popover-row-text">
                            <span className="talk-connectors-popover-row-name">
                              {row.service} · {row.name}
                            </span>
                            <span className="talk-connectors-popover-row-meta">
                              {row.capabilities}
                            </span>
                          </span>
                          <button
                            type="button"
                            role="switch"
                            className="talk-connectors-popover-switch"
                            aria-checked={row.linked}
                            aria-label={switchLabel}
                            disabled={disabled}
                            onClick={() => {
                              if (row.type === 'channel') {
                                void toggleChannel(row.row);
                              } else {
                                void toggleDataConnector(row.row);
                              }
                            }}
                          >
                            <span aria-hidden="true" />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}

                {toast ? (
                  <div
                    className="talk-connectors-toast"
                    role="status"
                    aria-live="polite"
                  >
                    {toast}
                  </div>
                ) : null}
              </>
            ) : null}

            <footer className="talk-connectors-popover-footer">
              <Link
                to={SETTINGS_CONNECTORS_HREF}
                className="talk-connectors-popover-add"
                onClick={() => setOpen(false)}
              >
                <CTIcon name="plus" size={12} strokeWidth={1.7} />
                Add connection
              </Link>
              <button
                type="button"
                className="talk-connectors-popover-done"
                onClick={() => setOpen(false)}
              >
                Done
              </button>
            </footer>
          </div>
        </Popover>
      ) : null}
    </>
  );
}
