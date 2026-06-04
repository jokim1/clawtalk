// Per-kind subtitle resolver for workspace connectors (D12 — 2026-05-24).
// Identifier-only: human names from Slack/Google APIs are PR 4
// work, which requires the credential + a network call. Identifier-only
// is honest, falsifiable, debug-friendly today.
//
// Used in both Settings → Connectors rows and the Talk Connectors picker
// so the subtitle stays consistent across surfaces.

export function resolveConnectorSubtitle(
  kind: string,
  config: Record<string, unknown> | null | undefined,
): string | null {
  const cfg = config ?? {};

  if (kind === 'slack') {
    const ws = typeof cfg.workspace_id === 'string' ? cfg.workspace_id : null;
    const ch = typeof cfg.channel_id === 'string' ? cfg.channel_id : null;
    if (ws && ch) return `workspace ${ws} · channel ${ch}`;
    if (ws) return `workspace ${ws}`;
    return null;
  }

  if (kind === 'google_docs' || kind === 'google_sheets') {
    const folder = typeof cfg.folder_id === 'string' ? cfg.folder_id : null;
    return folder ? `folder ${folder}` : 'no folder set';
  }

  return null;
}
