import { describe, expect, it } from 'vitest';

import { getSourceDisplayRef, isRawUuidSourceRef } from './sourceDisplay';

describe('sourceDisplay', () => {
  it('detects exact raw UUID source refs case-insensitively and ignores surrounding whitespace', () => {
    expect(isRawUuidSourceRef('0C111111-2222-4333-8444-555555555555')).toBe(
      true,
    );
    expect(isRawUuidSourceRef(' 0c111111-2222-4333-8444-555555555555 ')).toBe(
      true,
    );
  });

  it('does not treat source refs with UUID substrings as raw UUID refs', () => {
    expect(
      isRawUuidSourceRef('source-0c111111-2222-4333-8444-555555555555'),
    ).toBe(false);
    expect(isRawUuidSourceRef('S1')).toBe(false);
  });

  it('returns existing non-UUID refs unchanged', () => {
    expect(getSourceDisplayRef({ sourceRef: 'S12' }, 4)).toBe('S12');
    expect(getSourceDisplayRef({ sourceRef: 'source-alpha' }, 4)).toBe(
      'source-alpha',
    );
  });

  it('converts raw UUID refs into one-based labels from the rendered display index', () => {
    expect(
      getSourceDisplayRef(
        { sourceRef: '0c111111-2222-4333-8444-555555555555' },
        2,
      ),
    ).toBe('Source 3');
  });

  it('clamps invalid display indexes to Source 1 rather than leaking invalid labels', () => {
    expect(
      getSourceDisplayRef(
        { sourceRef: '0c111111-2222-4333-8444-555555555555' },
        Number.NaN,
      ),
    ).toBe('Source 1');
    expect(
      getSourceDisplayRef(
        { sourceRef: '0c111111-2222-4333-8444-555555555555' },
        -4,
      ),
    ).toBe('Source 1');
  });
});
