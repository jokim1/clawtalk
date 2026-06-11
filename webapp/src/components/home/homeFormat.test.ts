import { describe, expect, it } from 'vitest';

import {
  classifyAction,
  formatStatValue,
  HOME_WRITE_PENDING_REASON,
  INBOX_SEVERITY_BADGE,
  isSafeHttpUrl,
  newsImpactLabel,
  newsThumbPalette,
  REC_PRIORITY_BADGE,
  relativeAge,
  snoozePresets,
  talkRef,
  targetToPath,
  truncate,
} from './homeFormat';

describe('formatStatValue', () => {
  it('formats small, thousands, and millions ranges', () => {
    expect(formatStatValue(0)).toBe('0');
    expect(formatStatValue(42)).toBe('42');
    expect(formatStatValue(999)).toBe('999');
    expect(formatStatValue(1000)).toBe('1k');
    expect(formatStatValue(1234)).toBe('1.2k');
    expect(formatStatValue(2_400_000)).toBe('2.4M');
  });

  it('guards against negative / non-finite values', () => {
    expect(formatStatValue(-5)).toBe('0');
    expect(formatStatValue(Number.NaN)).toBe('0');
    expect(formatStatValue(Number.POSITIVE_INFINITY)).toBe('0');
  });
});

describe('classifyAction', () => {
  it('routes URL payloads to an external href', () => {
    expect(
      classifyAction({
        type: 'open_url',
        label: 'Open',
        payload: { url: 'https://example.com/x' },
      }),
    ).toEqual({ kind: 'href', href: 'https://example.com/x', label: 'Open' });
  });

  it('routes talkId payloads to in-app navigation', () => {
    expect(
      classifyAction({
        type: 'open_talk',
        label: 'Open at turn',
        payload: { talkId: 't1' },
      }),
    ).toMatchObject({
      kind: 'nav',
      to: '/app/talks/t1',
      label: 'Open at turn',
    });
  });

  it('routes document edit actions to the native Documents surface', () => {
    expect(
      classifyAction({
        type: 'open_document_edit',
        label: 'Review edit',
        payload: { documentId: 'doc/42', editId: 'edit-1' },
      }),
    ).toMatchObject({
      kind: 'nav',
      to: '/app/documents/doc%2F42',
      label: 'Review edit',
    });

    expect(
      classifyAction({
        type: 'open_document_edit',
        label: 'Review edits',
        payload: {},
      }),
    ).toMatchObject({
      kind: 'nav',
      to: '/app/documents',
      label: 'Review edits',
    });
  });

  it('uses the fallback nav target when the action has no own target', () => {
    expect(classifyAction(null, { to: '/app/talks/t2' })).toMatchObject({
      kind: 'nav',
      to: '/app/talks/t2',
    });
  });

  it('disables mutation-only actions with the pending-write reason', () => {
    expect(
      classifyAction({ type: 'dismiss', label: 'Dismiss', payload: {} }),
    ).toEqual({
      kind: 'disabled',
      reason: HOME_WRITE_PENDING_REASON,
      label: 'Dismiss',
    });
  });

  it('ignores non-http url payloads', () => {
    expect(
      classifyAction({
        type: 'x',
        label: 'Go',
        payload: { url: 'javascript:alert(1)' },
      }),
    ).toEqual({
      kind: 'disabled',
      reason: HOME_WRITE_PENDING_REASON,
      label: 'Go',
    });
  });

  it('percent-encodes talk ids so a crafted id cannot reshape the route', () => {
    expect(
      classifyAction({
        type: 'open',
        label: 'Open',
        payload: { talkId: 'a/b?c' },
      }),
    ).toMatchObject({ kind: 'nav', to: '/app/talks/a%2Fb%3Fc' });
  });
});

describe('isSafeHttpUrl', () => {
  it('accepts http(s) and rejects dangerous schemes', () => {
    expect(isSafeHttpUrl('https://example.com')).toBe(true);
    expect(isSafeHttpUrl('http://example.com')).toBe(true);
    expect(isSafeHttpUrl('  https://trimmed.example  ')).toBe(true);
    expect(isSafeHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeHttpUrl('data:text/html,x')).toBe(false);
    expect(isSafeHttpUrl('ftp://example.com')).toBe(false);
    expect(isSafeHttpUrl('')).toBe(false);
    expect(isSafeHttpUrl(null)).toBe(false);
  });
});

describe('targetToPath', () => {
  it('maps talk / connector / system targets, else null', () => {
    expect(targetToPath({ talkId: 't1' })).toBe('/app/talks/t1');
    expect(targetToPath({ talkId: 'x/y' })).toBe('/app/talks/x%2Fy');
    expect(targetToPath({ kind: 'document', documentId: 'doc/42' })).toBe(
      '/app/documents/doc%2F42',
    );
    expect(targetToPath({ kind: 'document' })).toBe('/app/documents');
    expect(targetToPath({ kind: 'connector' })).toBe(
      '/app/settings?tab=connectors',
    );
    expect(targetToPath({ kind: 'system' })).toBe('/app/settings');
    expect(targetToPath({ kind: 'news' })).toBeNull();
    expect(targetToPath(null)).toBeNull();
  });
});

describe('talkRef', () => {
  it('reads id + best-available title, else null', () => {
    expect(talkRef({ talkId: 't1', talkTitle: 'Pricing' })).toEqual({
      talkId: 't1',
      title: 'Pricing',
    });
    expect(talkRef({ talkId: 't1' })).toEqual({ talkId: 't1', title: 'Talk' });
    expect(talkRef({})).toBeNull();
    expect(talkRef(null)).toBeNull();
  });
});

describe('badge + impact tables', () => {
  it('covers severities, priorities, and an impact label', () => {
    expect(INBOX_SEVERITY_BADGE.blocking.label).toBe('Blocking');
    expect(INBOX_SEVERITY_BADGE.info.label).toBe('Info');
    expect(REC_PRIORITY_BADGE.decide.label).toBe('Decide');
    expect(REC_PRIORITY_BADGE.tidy.label).toBe('Tidy');
    expect(newsImpactLabel('changes_assumption')).toBe('Changes assumption');
  });
});

describe('truncate', () => {
  it('keeps short strings and ellipsizes long ones', () => {
    expect(truncate('short', 30)).toBe('short');
    expect(truncate('x'.repeat(40), 10)).toHaveLength(10);
    expect(truncate('x'.repeat(40), 10).endsWith('…')).toBe(true);
  });
});

describe('snoozePresets', () => {
  it('returns three strictly-future ISO presets in ascending order', () => {
    const now = new Date('2026-06-07T15:30:00Z');
    const presets = snoozePresets(now);

    expect(presets.map((p) => p.label)).toEqual([
      'In 1 hour',
      'Tomorrow',
      'Next week',
    ]);

    const times = presets.map((p) => Date.parse(p.until));
    expect(times.every((t) => Number.isFinite(t) && t > now.getTime())).toBe(
      true,
    );
    expect(times[0]).toBeLessThan(times[1]);
    expect(times[1]).toBeLessThan(times[2]);
    // "In 1 hour" is exactly one hour out.
    expect(times[0]).toBe(now.getTime() + 60 * 60 * 1000);
  });
});

describe('relativeAge', () => {
  const now = new Date('2026-06-11T12:00:00.000Z');

  it('formats minutes, hours, days, and weeks', () => {
    expect(relativeAge('2026-06-11T11:59:40.000Z', now)).toBe('now');
    expect(relativeAge('2026-06-11T11:55:00.000Z', now)).toBe('5 m ago');
    expect(relativeAge('2026-06-11T09:00:00.000Z', now)).toBe('3 h ago');
    expect(relativeAge('2026-06-09T12:00:00.000Z', now)).toBe('2 d ago');
    expect(relativeAge('2026-05-28T12:00:00.000Z', now)).toBe('2 w ago');
  });

  it('returns null for missing or invalid timestamps', () => {
    expect(relativeAge(null, now)).toBeNull();
    expect(relativeAge(undefined, now)).toBeNull();
    expect(relativeAge('not-a-date', now)).toBeNull();
  });
});

describe('newsThumbPalette', () => {
  it('is deterministic per source', () => {
    const a = newsThumbPalette('TechCrunch', null);
    const b = newsThumbPalette('TechCrunch', null);
    expect(a).toEqual(b);
    expect(a.bg).toMatch(/^#/);
    expect(a.fg).toMatch(/^#/);
  });

  it('prefers the favicon mark and falls back to source initials', () => {
    expect(newsThumbPalette('TechCrunch', 'TC').mark).toBe('TC');
    expect(newsThumbPalette('Hacker News', null).mark).toBe('HN');
    expect(newsThumbPalette(null, null).mark).toBe('·');
  });
});
