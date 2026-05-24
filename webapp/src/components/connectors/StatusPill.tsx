// Shared status pill for workspace connectors. Encodes the D11 precedence
// rule so Settings rows and Talk-picker rows show identical state copy.

type Props = {
  enabled: boolean;
  hasCredential: boolean;
  // PR 4 will pass `ready` once per-kind execution is wired; until then
  // both Settings and Talk-picker rows pass undefined.
  ready?: boolean;
};

export function ConnectorStatusPill({
  enabled,
  hasCredential,
  ready,
}: Props): JSX.Element {
  if (!enabled) {
    return (
      <span
        className="connector-status-pill connector-status-pill-disabled"
        aria-label="Disabled by workspace admin"
      >
        Disabled by admin
      </span>
    );
  }
  if (!hasCredential) {
    return (
      <span
        className="connector-status-pill connector-status-pill-credential-missing"
        title="Add a token in Settings → Connectors"
        aria-label="Credential missing"
      >
        ! Credential missing
      </span>
    );
  }
  if (ready) {
    return (
      <span
        className="connector-status-pill connector-status-pill-ready"
        aria-label="Ready"
      >
        Ready
      </span>
    );
  }
  return (
    <span
      className="connector-status-pill connector-status-pill-configuration-only"
      aria-label="Configuration only"
    >
      Configuration only
    </span>
  );
}
