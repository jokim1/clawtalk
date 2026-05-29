/**
 * model-lifecycle.ts
 *
 * Decides what to do about an agent whose configured model may be stale:
 *
 *   - 'retired'          → the provider no longer serves this model. The
 *                          agent would fail at run time, so the caller
 *                          auto-upgrades it (and notifies the user).
 *   - 'update_available' → the model still works, but a newer one in the
 *                          same family exists. The caller surfaces a notice
 *                          only — never an automatic change.
 *   - 'ok'               → nothing to do.
 *
 * Scoped to Anthropic for now (Claude IDs are parseable into family +
 * version). Other providers always resolve to 'ok' — the architecture
 * leaves room to add per-provider parsers later.
 *
 * SAFETY: 'retired' is only ever returned when we hold an AUTHORITATIVE
 * model list (`supported.complete` — a successful, non-empty live
 * /v1/models call). A transient/failed/empty discovery must never
 * auto-upgrade a user's agent: with an incomplete list we never return
 * 'retired' (a newer catalog model may still surface as 'update_available').
 */

export type ModelLifecycleStatus = 'ok' | 'update_available' | 'retired';

export interface ModelLifecycleResult {
  status: ModelLifecycleStatus;
  /**
   * For 'update_available': the newer model to offer.
   * For 'retired': the model to upgrade TO (newest supported in the same
   * family), or null when none could be determined — the caller then falls
   * back to a provider default.
   */
  suggestedModelId: string | null;
}

export interface SupportedModels {
  /**
   * The full known catalog — curated rows ∪ raw discovery. Used to find
   * newer siblings and suggestion targets (NOT to decide retirement).
   */
  ids: Set<string>;
  /** Curated subset, preferred when choosing a suggestion target. */
  curated: Set<string>;
  /**
   * The provider's AUTHORITATIVE served set (raw /v1/models). Retirement is
   * judged against this alone — curated rows must never mask a real
   * retirement. Empty unless `complete`.
   */
  served: Set<string>;
  /**
   * True only when `served` came from a complete, NON-EMPTY live discovery.
   * Retirement is concluded only when this is true — a failed, missing, or
   * empty (`data: []`) discovery must never auto-upgrade an agent.
   */
  complete: boolean;
}

/** Two parsed ids are the same model version (family + major.minor),
 *  regardless of any dated snapshot suffix or alias-vs-dated form. */
function sameVersion(a: ParsedClaude | null, b: ParsedClaude): boolean {
  return (
    !!a && a.family === b.family && a.major === b.major && a.minor === b.minor
  );
}

const ANTHROPIC_PROVIDER_ID = 'provider.anthropic';
const CLAUDE_FAMILIES = new Set(['opus', 'sonnet', 'haiku']);

interface ParsedClaude {
  family: string;
  major: number;
  minor: number;
}

/**
 * Parse a Claude model id into family + version, tolerating both naming
 * conventions Anthropic has shipped:
 *   - current:  claude-opus-4-8        / claude-opus-4-8-20260528
 *   - legacy:   claude-3-7-sonnet-20250219
 * A trailing 8-digit date snapshot is ignored for versioning. Returns null
 * for anything we can't confidently parse (caller treats it as 'ok').
 */
export function parseClaudeModelId(modelId: string): ParsedClaude | null {
  if (typeof modelId !== 'string') return null;
  const lower = modelId.toLowerCase();
  if (!lower.startsWith('claude-')) return null;
  const tokens = lower.slice('claude-'.length).split('-');

  let family: string | null = null;
  const versions: number[] = [];
  for (const token of tokens) {
    if (CLAUDE_FAMILIES.has(token)) {
      family = token;
      continue;
    }
    // 8-digit date snapshot (e.g. 20260528) — not a version component.
    if (/^\d{8}$/.test(token)) continue;
    if (/^\d+$/.test(token)) {
      versions.push(parseInt(token, 10));
      continue;
    }
    // Decimal like "2.1" (legacy claude-2.1) — take the integer part as
    // major; treat the fractional digit as minor.
    const decimal = /^(\d+)\.(\d+)$/.exec(token);
    if (decimal) {
      versions.push(parseInt(decimal[1], 10), parseInt(decimal[2], 10));
    }
  }

  if (!family || versions.length === 0) return null;
  return { family, major: versions[0], minor: versions[1] ?? 0 };
}

function isStrictlyNewer(a: ParsedClaude, b: ParsedClaude): boolean {
  if (a.major !== b.major) return a.major > b.major;
  return a.minor > b.minor;
}

/** Whether `modelId`'s (family, version) is present in the authoritative
 *  served set. False when discovery is incomplete (served is empty). */
export function isModelServed(
  modelId: string,
  supported: SupportedModels,
): boolean {
  const current = parseClaudeModelId(modelId);
  if (!current) return false;
  return [...supported.served].some((id) =>
    sameVersion(parseClaudeModelId(id), current),
  );
}

/**
 * Pick the id to upgrade/point an agent TO for `family`: the newest version
 * that is ACTUALLY SERVED (so we never target a curated-only, unserved
 * model), returned as the nicest id for that version — a curated alias
 * (`claude-opus-4-8`) is preferred over the served dated snapshot
 * (`claude-opus-4-8-20260528`). Returns null when the family has no served
 * model (e.g. discovery incomplete, or the whole family retired).
 *
 * Why prefer the curated alias even though only the dated snapshot is in
 * `served`: the alias is a canonical model id we already ship and send to
 * /v1/messages (it's the configured default), so it's inference-valid, and
 * it is STABLER than a dated snapshot — persisting `...-20260528` would
 * silently pin the agent to that exact snapshot, which Anthropic later
 * deprecates even while the alias keeps resolving. We only ever pick an
 * alias whose VERSION is in `served`, so the target is always live.
 */
export function pickNewestClaudeId(
  family: string,
  supported: SupportedModels,
): string | null {
  // 1. Newest version present in the authoritative served set.
  let newestVersion: ParsedClaude | null = null;
  for (const id of supported.served) {
    const parsed = parseClaudeModelId(id);
    if (!parsed || parsed.family !== family) continue;
    if (!newestVersion || isStrictlyNewer(parsed, newestVersion)) {
      newestVersion = parsed;
    }
  }
  if (!newestVersion) return null;

  // 2. Best display id for that served version (curated alias preferred).
  //    Drawn from the full catalog so we can surface the clean alias even
  //    when only the dated snapshot is in `served`.
  let bestId: string | null = null;
  for (const id of supported.ids) {
    const parsed = parseClaudeModelId(id);
    if (!parsed || !sameVersion(parsed, newestVersion)) continue;
    bestId = bestId ? preferId(id, bestId, supported.curated) : id;
  }
  return bestId;
}

/** Tie-break two same-version ids: curated wins, else the non-dated alias,
 *  else the lexically smaller for determinism. */
function preferId(a: string, b: string, curated: Set<string>): string {
  const aCurated = curated.has(a);
  const bCurated = curated.has(b);
  if (aCurated !== bCurated) return aCurated ? a : b;
  const aDated = /-\d{8}$/.test(a);
  const bDated = /-\d{8}$/.test(b);
  if (aDated !== bDated) return aDated ? b : a;
  return a < b ? a : b;
}

export function resolveModelLifecycle(
  providerId: string,
  modelId: string,
  supported: SupportedModels,
): ModelLifecycleResult {
  if (providerId !== ANTHROPIC_PROVIDER_ID) {
    return { status: 'ok', suggestedModelId: null };
  }

  const current = parseClaudeModelId(modelId);
  // Unparseable model id — can't reason about its lifecycle; leave it alone.
  if (!current) return { status: 'ok', suggestedModelId: null };

  // Retirement is judged ONLY against the authoritative served set, matched
  // by (family, version) so an agent's bare alias (claude-opus-4-8) still
  // counts when the served list only carries a dated snapshot
  // (claude-opus-4-8-20260528) — and so a curated row can't mask a real
  // retirement. Concluded only when discovery is complete + non-empty.
  if (supported.complete && !isModelServed(modelId, supported)) {
    return {
      status: 'retired',
      suggestedModelId: pickNewestClaudeId(current.family, supported),
    };
  }

  // Supported (or discovery incomplete — fail open): offer the newest
  // SERVED same-family model if one is strictly newer. pickNewestClaudeId
  // returns null when nothing is served (incomplete discovery), so we never
  // suggest an unconfirmed model.
  const newestId = pickNewestClaudeId(current.family, supported);
  const newest = newestId ? parseClaudeModelId(newestId) : null;
  if (newestId && newest && isStrictlyNewer(newest, current)) {
    return { status: 'update_available', suggestedModelId: newestId };
  }
  return { status: 'ok', suggestedModelId: null };
}
