import type {
  ChannelKind,
  DataConnectorKind,
  WorkspaceChannel,
  WorkspaceDataConnector,
  WorkspaceSlackInstall,
} from '../../lib/api';
import { GoogleDocsDataConnectorForm } from '../connectors/GoogleDocsDataConnectorForm';
import { GoogleSheetsDataConnectorForm } from '../connectors/GoogleSheetsDataConnectorForm';
import { SlackChannelForm } from '../connectors/SlackChannelForm';
import { SlackChannelPicker } from '../connectors/SlackChannelPicker';
import { ConnectorStatusPill } from '../connectors/StatusPill';
import { resolveConnectorSubtitle } from '../connectors/subtitle';
import { Button, Kbd, Modal, Sheet } from '../../salon';

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

export type ConnectorModalState =
  | { kind: 'closed' }
  | { kind: 'create-channel' }
  | { kind: 'edit-channel'; channel: WorkspaceChannel }
  | { kind: 'create-data-connector' }
  | { kind: 'edit-data-connector'; dataConnector: WorkspaceDataConnector };

export type ConnectorDeleteState =
  | { kind: 'closed' }
  | { kind: 'channel'; channel: WorkspaceChannel }
  | { kind: 'data-connector'; dataConnector: WorkspaceDataConnector };

export type ConnectorListStatus =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'error'; message: string };

export type ConnectorSlackBusy =
  | null
  | 'connect'
  | { kind: 'delete'; teamId: string };

export type ConnectorFormInput = {
  displayName: string;
  config: Record<string, unknown>;
  apiKey?: string | null;
  rotateCredential?: boolean;
};

type ConnectorsSettingsPanelProps = {
  isAdmin: boolean;
  status: ConnectorListStatus;
  channels: WorkspaceChannel[];
  dataConnectors: WorkspaceDataConnector[];
  slackInstalls: WorkspaceSlackInstall[];
  modal: ConnectorModalState;
  createKind: string;
  deleteState: ConnectorDeleteState;
  formSubmitting: boolean;
  formError: string | null;
  deleteSubmitting: boolean;
  slackBusy: ConnectorSlackBusy;
  slackNotice: string | null;
  slackError: string | null;
  workspaceId?: string | null;
  onRetry: () => void;
  onConnectSlackWorkspace: () => void;
  onDisconnectSlackWorkspace: (install: WorkspaceSlackInstall) => void;
  onOpenCreateChannel: () => void;
  onOpenEditChannel: (channel: WorkspaceChannel) => void;
  onOpenDeleteChannel: (channel: WorkspaceChannel) => void;
  onOpenCreateDataConnector: () => void;
  onOpenEditDataConnector: (dataConnector: WorkspaceDataConnector) => void;
  onOpenDeleteDataConnector: (dataConnector: WorkspaceDataConnector) => void;
  onCloseModal: () => void;
  onCreateKindChange: (kind: string) => void;
  onCreateChannel: (
    kind: ChannelKind,
    input: ConnectorFormInput,
  ) => Promise<void>;
  onEditChannel: (
    channel: WorkspaceChannel,
    input: ConnectorFormInput,
  ) => Promise<void>;
  onSlackChannelsAdded: (count: number) => Promise<void> | void;
  onCreateDataConnector: (
    kind: DataConnectorKind,
    input: ConnectorFormInput,
  ) => Promise<void>;
  onEditDataConnector: (
    dataConnector: WorkspaceDataConnector,
    input: ConnectorFormInput,
  ) => Promise<void>;
  onCloseDelete: () => void;
  onConfirmDelete: () => void;
};

export function ConnectorsSettingsPanel({
  isAdmin,
  status,
  channels,
  dataConnectors,
  slackInstalls,
  modal,
  createKind,
  deleteState,
  formSubmitting,
  formError,
  deleteSubmitting,
  slackBusy,
  slackNotice,
  slackError,
  workspaceId,
  onRetry,
  onConnectSlackWorkspace,
  onDisconnectSlackWorkspace,
  onOpenCreateChannel,
  onOpenEditChannel,
  onOpenDeleteChannel,
  onOpenCreateDataConnector,
  onOpenEditDataConnector,
  onOpenDeleteDataConnector,
  onCloseModal,
  onCreateKindChange,
  onCreateChannel,
  onEditChannel,
  onSlackChannelsAdded,
  onCreateDataConnector,
  onEditDataConnector,
  onCloseDelete,
  onConfirmDelete,
}: ConnectorsSettingsPanelProps): JSX.Element {
  if (status.kind === 'loading') {
    return (
      <section className="page-shell-section">
        <p className="page-state">Loading connectors…</p>
      </section>
    );
  }

  return (
    <>
      <section
        className="page-shell-section connectors-section"
        aria-label="Slack workspaces"
      >
        <header className="agents-panel-header">
          <h2>Slack workspaces</h2>
          {isAdmin ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => {
                void onConnectSlackWorkspace();
              }}
              disabled={slackBusy === 'connect'}
            >
              {slackBusy === 'connect'
                ? 'Opening Slack…'
                : '+ Connect Slack workspace'}
            </button>
          ) : null}
        </header>
        {slackError ? (
          <p className="page-state error" role="alert">
            {slackError}
          </p>
        ) : null}
        {slackNotice ? (
          <p className="page-state" role="status">
            {slackNotice}
          </p>
        ) : null}
        {slackInstalls.length === 0 ? (
          <p className="page-state">
            {isAdmin
              ? 'No Slack workspaces connected yet. Connect a workspace to add channels from it below.'
              : 'No Slack workspaces connected. Ask your workspace admin to connect one.'}
          </p>
        ) : (
          <table className="connector-table">
            <thead>
              <tr>
                <th scope="col">Workspace</th>
                <th scope="col">Channels</th>
                <th scope="col">Installed</th>
                <th scope="col" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {slackInstalls.map((install) => {
                const isDeleting =
                  slackBusy &&
                  typeof slackBusy === 'object' &&
                  slackBusy.teamId === install.teamId;
                return (
                  <tr key={install.teamId}>
                    <td>
                      <div className="connector-row-name">
                        <strong>{install.teamName}</strong>
                        <span className="connector-row-subtitle">
                          {install.teamId}
                        </span>
                      </div>
                    </td>
                    <td>
                      {install.boundChannelCount === 0
                        ? 'No channels yet'
                        : install.boundChannelCount === 1
                          ? '1 channel'
                          : `${install.boundChannelCount} channels`}
                    </td>
                    <td>
                      {new Date(install.installedAt).toLocaleDateString()}
                    </td>
                    <td className="connector-row-actions">
                      {isAdmin ? (
                        <button
                          type="button"
                          className="btn btn-sm btn-danger-outline"
                          aria-label={`Disconnect Slack workspace ${install.teamName}`}
                          onClick={() => {
                            void onDisconnectSlackWorkspace(install);
                          }}
                          disabled={Boolean(isDeleting)}
                        >
                          {isDeleting ? 'Disconnecting…' : 'Disconnect'}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section
        className="page-shell-section connectors-section"
        aria-label="Channels available to talks"
      >
        <header className="agents-panel-header">
          <h2>Channels available to talks</h2>
          {isAdmin ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={onOpenCreateChannel}
            >
              + Add channel
            </button>
          ) : null}
        </header>
        {status.kind === 'error' ? (
          <p className="page-state error" role="alert">
            {status.message}{' '}
            <button type="button" className="btn btn-sm" onClick={onRetry}>
              Retry
            </button>
          </p>
        ) : null}
        {channels.length === 0 ? (
          <p className="page-state">
            {isAdmin
              ? 'No channels yet. Add Slack to make them available across all your talks.'
              : 'No channels available. Ask your workspace admin to add one in Settings → Connectors.'}
          </p>
        ) : (
          <ConnectorTable
            rows={channels.map((channel) => {
              return {
                id: channel.id,
                kindLabel: channelKindLabel(channel.kind),
                displayName: channel.displayName,
                subtitle: resolveConnectorSubtitle(
                  channel.kind,
                  channel.config,
                ),
                boundTalkCount: channel.boundTalkCount,
                enabled: channel.enabled,
                hasCredential: channel.hasCredential,
                onEdit: isAdmin ? () => onOpenEditChannel(channel) : undefined,
                onDelete: isAdmin
                  ? () => onOpenDeleteChannel(channel)
                  : undefined,
                labelNoun: 'Slack channel',
              };
            })}
          />
        )}
      </section>

      <section
        className="page-shell-section connectors-section"
        aria-label="Data sources available to talks"
      >
        <header className="agents-panel-header">
          <h2>Data sources available to talks</h2>
          {isAdmin ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={onOpenCreateDataConnector}
            >
              + Add data source
            </button>
          ) : null}
        </header>
        {dataConnectors.length === 0 ? (
          <p className="page-state">
            {isAdmin
              ? 'No data sources yet. Add Google Docs or Sheets to make them available across all your talks.'
              : 'No data sources available. Ask your workspace admin to add one.'}
          </p>
        ) : (
          <ConnectorTable
            rows={dataConnectors.map((dc) => ({
              id: dc.id,
              kindLabel: dataConnectorKindLabel(dc.kind),
              displayName: dc.displayName,
              subtitle: resolveConnectorSubtitle(dc.kind, dc.config),
              boundTalkCount: dc.boundTalkCount,
              enabled: dc.enabled,
              hasCredential: dc.hasCredential,
              onEdit: isAdmin ? () => onOpenEditDataConnector(dc) : undefined,
              onDelete: isAdmin
                ? () => onOpenDeleteDataConnector(dc)
                : undefined,
              labelNoun: 'Data source',
            }))}
          />
        )}
        {!isAdmin ? (
          <p className="page-state-footer">
            Workspace admins manage connectors in Settings.
          </p>
        ) : null}
      </section>

      {modal.kind !== 'closed' ? (
        <Modal
          onClose={onCloseModal}
          width={560}
          ariaLabel="Connector settings"
        >
          <div style={{ padding: '20px' }}>
            <ConnectorModalContent
              modal={modal}
              createKind={createKind}
              setCreateKind={onCreateKindChange}
              submitting={formSubmitting}
              error={formError}
              slackInstalls={slackInstalls}
              workspaceId={workspaceId}
              onCancel={onCloseModal}
              onCreateChannel={onCreateChannel}
              onEditChannel={onEditChannel}
              onSlackChannelsAdded={onSlackChannelsAdded}
              onCreateDataConnector={onCreateDataConnector}
              onEditDataConnector={onEditDataConnector}
            />
          </div>
        </Modal>
      ) : null}

      {deleteState.kind !== 'closed' ? (
        <Sheet
          width={460}
          onClose={() => {
            if (!deleteSubmitting) onCloseDelete();
          }}
          title={`Delete ${
            deleteState.kind === 'channel'
              ? deleteState.channel.displayName
              : deleteState.dataConnector.displayName
          }?`}
          headerAccessory={<Kbd>Esc</Kbd>}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={onCloseDelete}
                disabled={deleteSubmitting}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  void onConfirmDelete();
                }}
                disabled={deleteSubmitting}
              >
                {deleteSubmitting ? 'Deleting…' : 'Delete connector'}
              </Button>
            </>
          }
        >
          <p style={{ margin: 0, color: 'var(--salon-ink-2, #6b6660)' }}>
            Deleting removes this connector from{' '}
            {deleteState.kind === 'channel'
              ? deleteState.channel.boundTalkCount
              : deleteState.dataConnector.boundTalkCount}{' '}
            talks. Talk histories stay intact. This cannot be undone.
          </p>
        </Sheet>
      ) : null}
    </>
  );
}

type ConnectorTableRow = {
  id: string;
  kindLabel: string;
  displayName: string;
  subtitle: string | null;
  boundTalkCount: number;
  enabled: boolean;
  hasCredential: boolean;
  labelNoun: string;
  onEdit?: () => void;
  onDelete?: () => void;
};

function ConnectorTable({ rows }: { rows: ConnectorTableRow[] }): JSX.Element {
  return (
    <table className="connector-table">
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Kind</th>
          <th scope="col">Used by</th>
          <th scope="col">Status</th>
          <th scope="col" aria-label="Actions" />
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>
            <td>
              <div className="connector-row-name">
                <strong>{row.displayName}</strong>
                {row.subtitle ? (
                  <span className="connector-row-subtitle">{row.subtitle}</span>
                ) : null}
              </div>
            </td>
            <td>{row.kindLabel}</td>
            <td>
              {row.boundTalkCount === 0
                ? 'Not yet linked'
                : row.boundTalkCount === 1
                  ? 'Used by 1 talk'
                  : `Used by ${row.boundTalkCount} talks`}
            </td>
            <td>
              <ConnectorStatusPill
                enabled={row.enabled}
                hasCredential={row.hasCredential}
              />
            </td>
            <td className="connector-row-actions">
              {row.onEdit ? (
                <button
                  type="button"
                  className="btn btn-sm"
                  aria-label={`Edit ${row.labelNoun}: ${row.displayName}`}
                  onClick={row.onEdit}
                >
                  Edit
                </button>
              ) : null}
              {row.onDelete ? (
                <button
                  type="button"
                  className="btn btn-sm btn-danger-outline"
                  aria-label={`Delete ${row.labelNoun}: ${row.displayName}`}
                  onClick={row.onDelete}
                >
                  Delete
                </button>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ConnectorModalContent({
  modal,
  createKind,
  setCreateKind,
  submitting,
  error,
  slackInstalls,
  workspaceId,
  onCancel,
  onCreateChannel,
  onEditChannel,
  onSlackChannelsAdded,
  onCreateDataConnector,
  onEditDataConnector,
}: {
  modal: Exclude<ConnectorModalState, { kind: 'closed' }>;
  createKind: string;
  setCreateKind: (kind: string) => void;
  submitting: boolean;
  error: string | null;
  slackInstalls: WorkspaceSlackInstall[];
  workspaceId?: string | null;
  onCancel: () => void;
  onCreateChannel: (
    kind: ChannelKind,
    input: ConnectorFormInput,
  ) => Promise<void>;
  onEditChannel: (
    channel: WorkspaceChannel,
    input: ConnectorFormInput,
  ) => Promise<void>;
  onSlackChannelsAdded: (count: number) => Promise<void> | void;
  onCreateDataConnector: (
    kind: DataConnectorKind,
    input: ConnectorFormInput,
  ) => Promise<void>;
  onEditDataConnector: (
    dc: WorkspaceDataConnector,
    input: ConnectorFormInput,
  ) => Promise<void>;
}): JSX.Element {
  if (modal.kind === 'create-channel') {
    return (
      <>
        <h3>Add channel</h3>
        <SlackChannelPicker
          installs={slackInstalls}
          workspaceId={workspaceId}
          onAdded={(count) => {
            void onSlackChannelsAdded(count);
          }}
          onCancel={onCancel}
        />
      </>
    );
  }
  if (modal.kind === 'edit-channel') {
    const channel = modal.channel;
    if (channel.kind !== 'slack') {
      return (
        <>
          <h3>Edit channel</h3>
          <p className="page-state">
            This channel kind is no longer supported.
          </p>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onCancel}
          >
            Close
          </button>
        </>
      );
    }
    return (
      <>
        <h3>Edit channel</h3>
        <SlackChannelForm
          mode="edit"
          initial={channel}
          submitting={submitting}
          error={error}
          installs={slackInstalls}
          onSubmit={(input) => onEditChannel(channel, input)}
          onCancel={onCancel}
        />
      </>
    );
  }
  if (modal.kind === 'create-data-connector') {
    return (
      <>
        <h3>Add data source</h3>
        <label className="form-field">
          <span className="form-field-label">Data source kind</span>
          <select
            value={createKind}
            onChange={(event) => setCreateKind(event.target.value)}
            disabled={submitting}
          >
            <option value="google_docs">Google Docs</option>
            <option value="google_sheets">Google Sheets</option>
          </select>
        </label>
        {createKind === 'google_docs' ? (
          <GoogleDocsDataConnectorForm
            mode="create"
            submitting={submitting}
            error={error}
            onSubmit={(input) => onCreateDataConnector('google_docs', input)}
            onCancel={onCancel}
          />
        ) : (
          <GoogleSheetsDataConnectorForm
            mode="create"
            submitting={submitting}
            error={error}
            onSubmit={(input) => onCreateDataConnector('google_sheets', input)}
            onCancel={onCancel}
          />
        )}
      </>
    );
  }
  const dc = modal.dataConnector;
  if (dc.kind !== 'google_docs' && dc.kind !== 'google_sheets') {
    return (
      <>
        <h3>Edit data source</h3>
        <p className="page-state">
          This data source kind is no longer supported.
        </p>
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          Close
        </button>
      </>
    );
  }
  return (
    <>
      <h3>Edit data source</h3>
      {dc.kind === 'google_docs' ? (
        <GoogleDocsDataConnectorForm
          mode="edit"
          initial={dc}
          submitting={submitting}
          error={error}
          onSubmit={(input) => onEditDataConnector(dc, input)}
          onCancel={onCancel}
        />
      ) : (
        <GoogleSheetsDataConnectorForm
          mode="edit"
          initial={dc}
          submitting={submitting}
          error={error}
          onSubmit={(input) => onEditDataConnector(dc, input)}
          onCancel={onCancel}
        />
      )}
    </>
  );
}
