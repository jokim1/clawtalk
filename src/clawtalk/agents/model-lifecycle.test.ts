import { describe, expect, it } from 'vitest';

import {
  isModelServed,
  parseClaudeModelId,
  pickNewestClaudeId,
  resolveModelLifecycle,
  type SupportedModels,
} from './model-lifecycle.js';

function supported(
  ids: string[],
  opts?: { curated?: string[]; served?: string[]; complete?: boolean },
): SupportedModels {
  const complete = opts?.complete ?? true;
  return {
    ids: new Set(ids),
    curated: new Set(opts?.curated ?? ids),
    // Default: the served (authoritative) set mirrors ids. Tests that need
    // a curated id absent from the served set pass `served` explicitly.
    served: new Set(complete ? (opts?.served ?? ids) : (opts?.served ?? [])),
    complete,
  };
}

const ANTHROPIC = 'provider.anthropic';

describe('parseClaudeModelId', () => {
  it('parses the current convention (family before version)', () => {
    expect(parseClaudeModelId('claude-opus-4-8')).toEqual({
      family: 'opus',
      major: 4,
      minor: 8,
    });
    expect(parseClaudeModelId('claude-sonnet-4-6')).toEqual({
      family: 'sonnet',
      major: 4,
      minor: 6,
    });
  });

  it('ignores an 8-digit date snapshot', () => {
    expect(parseClaudeModelId('claude-opus-4-8-20260528')).toEqual({
      family: 'opus',
      major: 4,
      minor: 8,
    });
  });

  it('parses the legacy convention (version before family)', () => {
    expect(parseClaudeModelId('claude-3-7-sonnet-20250219')).toEqual({
      family: 'sonnet',
      major: 3,
      minor: 7,
    });
    expect(parseClaudeModelId('claude-3-5-haiku-20241022')).toEqual({
      family: 'haiku',
      major: 3,
      minor: 5,
    });
  });

  it('returns null for non-Claude or familyless/unparseable ids', () => {
    expect(parseClaudeModelId('gpt-5-mini')).toBeNull();
    expect(parseClaudeModelId('claude-unknownfamily')).toBeNull();
    expect(parseClaudeModelId('claude-2.1')).toBeNull(); // no family token
    expect(parseClaudeModelId('')).toBeNull();
  });
});

describe('pickNewestClaudeId', () => {
  it('returns the highest version in a family', () => {
    const s = supported([
      'claude-opus-4-7',
      'claude-opus-4-8',
      'claude-sonnet-4-6',
    ]);
    expect(pickNewestClaudeId('opus', s)).toBe('claude-opus-4-8');
  });

  it('prefers the curated alias over a dated snapshot on a version tie', () => {
    const s = supported(['claude-opus-4-8', 'claude-opus-4-8-20260528'], {
      curated: ['claude-opus-4-8'],
    });
    expect(pickNewestClaudeId('opus', s)).toBe('claude-opus-4-8');
  });

  it('returns null for a family with no supported models', () => {
    expect(
      pickNewestClaudeId('opus', supported(['claude-sonnet-4-6'])),
    ).toBeNull();
  });
});

describe('isModelServed', () => {
  it('matches by family+version against served (alias vs dated agnostic)', () => {
    const s = supported(['claude-opus-4-8'], {
      served: ['claude-opus-4-8-20260528'],
      complete: true,
    });
    expect(isModelServed('claude-opus-4-8', s)).toBe(true);
    expect(isModelServed('claude-opus-4-7', s)).toBe(false);
  });

  it('is false when discovery is incomplete (served empty)', () => {
    const s = supported(['claude-opus-4-8'], { served: [], complete: false });
    expect(isModelServed('claude-opus-4-8', s)).toBe(false);
  });
});

describe('resolveModelLifecycle', () => {
  it('is a no-op for non-Anthropic providers', () => {
    expect(
      resolveModelLifecycle('provider.openai', 'gpt-5-mini', supported([])),
    ).toEqual({ status: 'ok', suggestedModelId: null });
  });

  it('returns ok when the model is the newest in its family', () => {
    const s = supported(['claude-opus-4-8', 'claude-sonnet-4-6']);
    expect(resolveModelLifecycle(ANTHROPIC, 'claude-opus-4-8', s)).toEqual({
      status: 'ok',
      suggestedModelId: null,
    });
  });

  it('flags update_available when a newer same-family model exists', () => {
    const s = supported(['claude-opus-4-7', 'claude-opus-4-8']);
    expect(resolveModelLifecycle(ANTHROPIC, 'claude-opus-4-7', s)).toEqual({
      status: 'update_available',
      suggestedModelId: 'claude-opus-4-8',
    });
  });

  it('does NOT cross families for update_available', () => {
    // A Sonnet agent must not be told to "update" to a newer Opus.
    const s = supported(['claude-sonnet-4-6', 'claude-opus-4-8']);
    expect(resolveModelLifecycle(ANTHROPIC, 'claude-sonnet-4-6', s)).toEqual({
      status: 'ok',
      suggestedModelId: null,
    });
  });

  it('flags retired + suggests newest same-family when list is authoritative', () => {
    // opus-4-7 is gone from the authoritative list; opus-4-8 remains.
    const s = supported(['claude-opus-4-8', 'claude-sonnet-4-6'], {
      complete: true,
    });
    expect(resolveModelLifecycle(ANTHROPIC, 'claude-opus-4-7', s)).toEqual({
      status: 'retired',
      suggestedModelId: 'claude-opus-4-8',
    });
  });

  it('NEVER auto-retires (or suggests) when the list is incomplete', () => {
    const s = supported(['claude-opus-4-8'], { complete: false });
    // opus-4-7 absent from the (untrusted) list — must NOT auto-upgrade, and
    // since nothing is authoritatively served, no suggestion either.
    expect(resolveModelLifecycle(ANTHROPIC, 'claude-opus-4-7', s)).toEqual({
      status: 'ok',
      suggestedModelId: null,
    });
  });

  it('does NOT retire a still-supported legacy model', () => {
    // A claude-3-7-sonnet agent is fine if 3.7 is still in the served list.
    const s = supported(['claude-3-7-sonnet-20250219', 'claude-opus-4-8'], {
      complete: true,
    });
    const r = resolveModelLifecycle(ANTHROPIC, 'claude-3-7-sonnet-20250219', s);
    expect(r.status).toBe('ok');
  });

  it('retires with a null target when no same-family model survives', () => {
    // haiku family fully gone; caller will fall back to a provider default.
    const s = supported(['claude-opus-4-8'], { complete: true });
    expect(resolveModelLifecycle(ANTHROPIC, 'claude-haiku-4-5', s)).toEqual({
      status: 'retired',
      suggestedModelId: null,
    });
  });

  it('treats a model on a dated snapshot of the newest version as ok', () => {
    const s = supported(['claude-opus-4-8', 'claude-opus-4-8-20260528']);
    expect(
      resolveModelLifecycle(ANTHROPIC, 'claude-opus-4-8-20260528', s).status,
    ).toBe('ok');
  });

  it('does NOT retire a bare alias when only a dated snapshot is served', () => {
    // Agent uses claude-opus-4-8 (the alias); /v1/models only lists the
    // dated snapshot. Same (family, version) → still supported, not retired.
    const s = supported(['claude-opus-4-8'], {
      served: ['claude-opus-4-8-20260528'],
      curated: ['claude-opus-4-8'],
      complete: true,
    });
    expect(resolveModelLifecycle(ANTHROPIC, 'claude-opus-4-8', s).status).toBe(
      'ok',
    );
  });

  it('upgrades a retired model to a SERVED version, never a curated-only newer one', () => {
    // curated lists opus-4-9 but Anthropic only serves up to opus-4-8.
    const s = supported(['claude-opus-4-8', 'claude-opus-4-9'], {
      curated: ['claude-opus-4-8', 'claude-opus-4-9'],
      served: ['claude-opus-4-8'],
      complete: true,
    });
    // opus-4-7 retired → target must be 4-8 (served), not 4-9 (curated-only).
    expect(resolveModelLifecycle(ANTHROPIC, 'claude-opus-4-7', s)).toEqual({
      status: 'retired',
      suggestedModelId: 'claude-opus-4-8',
    });
  });

  it('does NOT suggest a curated-only unserved model as an update', () => {
    const s = supported(['claude-opus-4-8', 'claude-opus-4-9'], {
      curated: ['claude-opus-4-8', 'claude-opus-4-9'],
      served: ['claude-opus-4-8'],
      complete: true,
    });
    // Agent on the newest SERVED model; 4-9 is curated-only → no nudge.
    expect(resolveModelLifecycle(ANTHROPIC, 'claude-opus-4-8', s)).toEqual({
      status: 'ok',
      suggestedModelId: null,
    });
  });

  it('retires a CURATED model when the served set no longer carries it', () => {
    // Curated rows must not mask a real retirement: opus-4-7 is curated but
    // absent from the authoritative served set → retired, upgrade to 4-8.
    const s = supported(['claude-opus-4-7', 'claude-opus-4-8'], {
      curated: ['claude-opus-4-7', 'claude-opus-4-8'],
      served: ['claude-opus-4-8'],
      complete: true,
    });
    expect(resolveModelLifecycle(ANTHROPIC, 'claude-opus-4-7', s)).toEqual({
      status: 'retired',
      suggestedModelId: 'claude-opus-4-8',
    });
  });

  it('is ok (not retired) on an incomplete/empty discovery when nothing is newer', () => {
    // The empty-/failed-discovery guard: complete=false ⇒ served ignored,
    // and with no newer catalog model the agent is simply ok.
    const s = supported(['claude-opus-4-8'], {
      served: [],
      complete: false,
    });
    expect(resolveModelLifecycle(ANTHROPIC, 'claude-opus-4-8', s)).toEqual({
      status: 'ok',
      suggestedModelId: null,
    });
  });
});
