/**
 * Home surface — pure presentation helpers (no JSX, unit-testable).
 *
 * Maps the read-only Home API payloads (see webapp/src/lib/api.ts) onto Salon
 * visual tokens: severity / priority badges, kind glyphs, stat formatting, and
 * action routing. The reference design lives in prototype/home-shared.jsx and
 * docs/07-homepage-system-design.md.
 */
import type { CTIconName } from '../../salon';
import type {
  HomeAction,
  HomeInboxSeverity,
  HomeInboxType,
  HomeNewsImpact,
  HomeRecommendationKind,
  HomeRecommendationPriority,
} from '../../lib/api';

export type BadgeTone = {
  label: string;
  bg: string;
  fg: string;
};

/** Inbox severity → badge palette (docs/07 §6.6). */
export const INBOX_SEVERITY_BADGE: Record<HomeInboxSeverity, BadgeTone> = {
  blocking: { label: 'Blocking', bg: '#fbecec', fg: '#7b2a30' },
  action: { label: 'Action', bg: '#faf1de', fg: '#7e5418' },
  info: { label: 'Info', bg: 'var(--salon-paper-2, #f4ecdb)', fg: '#5a534a' },
};

/** Recommendation priority → badge palette (docs/07 §7.9). */
export const REC_PRIORITY_BADGE: Record<HomeRecommendationPriority, BadgeTone> =
  {
    decide: { label: 'Decide', bg: '#fbecec', fg: '#7b2a30' },
    improve: { label: 'Improve', bg: '#faf1de', fg: '#7e5418' },
    tidy: { label: 'Tidy', bg: 'var(--salon-paper-2, #f4ecdb)', fg: '#5a534a' },
  };

/** Recommendation kind → Salon stroke icon. */
export const REC_KIND_ICON: Record<HomeRecommendationKind, CTIconName> = {
  setup: 'settings',
  'failed-run': 'bolt',
  unresolved: 'bolt',
  synthesis: 'sparkle',
  'pending-edit': 'doc',
  doc: 'doc',
  'cross-link': 'paperclip',
  tool: 'globe',
  'news-context': 'globe',
  'agent-change': 'sparkle',
  recap: 'sparkle',
  'archive-cleanup': 'folder',
  'forge-suggestion': 'bolt',
  job: 'play',
  'prompt-suggestion': 'chat',
};

/** Inbox item type → Salon stroke icon. */
export const INBOX_TYPE_ICON: Record<HomeInboxType, CTIconName> = {
  agent_replied: 'chat',
  round_completed: 'check',
  agent_asks_user: 'chat',
  run_failed: 'x',
  doc_edits_ready: 'doc',
  connector_needs_auth: 'globe',
  news_context_added: 'globe',
  long_running_run: 'play',
  system_limit_reached: 'bolt',
  forge_run_needs_review: 'eye',
  job_output_ready: 'check',
  job_blocked: 'pause',
};

/** Human label for a news impact tag. */
export function newsImpactLabel(impact: HomeNewsImpact): string {
  const map: Record<HomeNewsImpact, string> = {
    changes_assumption: 'Changes assumption',
    adds_evidence: 'Adds evidence',
    updates_competitor: 'Competitor',
    introduces_risk: 'Risk',
    provides_tactic: 'Tactic',
    topic_update: 'Update',
    community_signal: 'Signal',
    background_only: 'Background',
  };
  return map[impact] ?? 'Update';
}

/**
 * Compact stat formatting: 1234 → "1.2k", 2_400_000 → "2.4M". Whole numbers
 * under 1000 render as-is. Negatives and non-finite values fall back to "0".
 */
export function formatStatValue(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) {
    const k = value / 1000;
    return `${trimDecimal(k)}k`;
  }
  const m = value / 1_000_000;
  return `${trimDecimal(m)}M`;
}

function trimDecimal(n: number): string {
  // One decimal place, but drop a trailing ".0".
  const fixed = n.toFixed(1);
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
}

/** Truncate a Talk/title to keep chips on one line. */
export function truncate(text: string, max = 30): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1))}…`;
}

export function readString(
  source: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  if (!source) return null;
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Extract a Talk reference (id + best-available title) from a provenance or
 * target bag. Returns null when no `talkId` is present.
 */
export function talkRef(
  source: Record<string, unknown> | null | undefined,
): { talkId: string; title: string } | null {
  const talkId = readString(source, 'talkId');
  if (!talkId) return null;
  const title =
    readString(source, 'talkTitle') ?? readString(source, 'title') ?? 'Talk';
  return { talkId, title };
}

/** Resolve an inbox/recommendation target object to an in-app route, if any. */
export function targetToPath(
  target: Record<string, unknown> | null | undefined,
): string | null {
  const talkId = readString(target, 'talkId');
  if (talkId) return `/app/talks/${encodeURIComponent(talkId)}`;
  const kind = readString(target, 'kind');
  if (kind === 'connector') return '/app/settings?tab=connectors';
  if (kind === 'system') return '/app/settings';
  return null;
}

export type ActionBehavior =
  | { kind: 'nav'; to: string; label: string }
  | { kind: 'href'; href: string; label: string }
  | { kind: 'disabled'; reason: string; label: string };

/** Shown on actions whose mutation endpoint is not implemented yet. */
export const HOME_WRITE_PENDING_REASON =
  'Lifecycle actions arrive with the Home write API.';

/**
 * Classify a Home action into a UI behavior. Navigation-shaped actions (open a
 * Talk / external URL) work against the read-only API today; mutation-only
 * actions (dismiss/snooze/resolve/add-to-context) resolve to a disabled control
 * that explains the pending write API rather than silently doing nothing.
 */
/** True only for http(s) URLs — blocks javascript:/data:/custom-scheme hrefs. */
export function isSafeHttpUrl(url: string | null | undefined): boolean {
  return typeof url === 'string' && /^https?:\/\//i.test(url.trim());
}

export function classifyAction(
  action: HomeAction | null | undefined,
  fallback?: { to?: string | null },
): ActionBehavior {
  const label = action?.label?.trim() || 'Open';
  if (action) {
    const url = readString(action.payload, 'url');
    if (url && isSafeHttpUrl(url)) {
      return { kind: 'href', href: url, label };
    }
    const talkId = readString(action.payload, 'talkId');
    if (talkId)
      return {
        kind: 'nav',
        to: `/app/talks/${encodeURIComponent(talkId)}`,
        label,
      };
  }
  if (fallback?.to) return { kind: 'nav', to: fallback.to, label };
  return { kind: 'disabled', reason: HOME_WRITE_PENDING_REASON, label };
}

export type SnoozePreset = { label: string; until: string };

/**
 * Snooze duration presets relative to `now`. "Tomorrow" / "Next week" land at
 * 09:00 local so an item resurfaces at the start of a working block rather than
 * an arbitrary minute. All three are strictly in the future (the write API
 * rejects past/over-a-year timestamps).
 */
export function snoozePresets(now: Date): SnoozePreset[] {
  const inOneHour = new Date(now.getTime() + 60 * 60 * 1000);

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);

  const nextWeek = new Date(now);
  nextWeek.setDate(nextWeek.getDate() + 7);
  nextWeek.setHours(9, 0, 0, 0);

  return [
    { label: 'In 1 hour', until: inOneHour.toISOString() },
    { label: 'Tomorrow', until: tomorrow.toISOString() },
    { label: 'Next week', until: nextWeek.toISOString() },
  ];
}

/** First-letter initials (max 2) for a curator/avatar glyph. */
export function initials(text: string, max = 1): string {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '·';
  return parts
    .slice(0, max)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}
