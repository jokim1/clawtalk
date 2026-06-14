import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clampSidePanelWidth,
  getSidePanelWidth,
  setSidePanelWidth,
} from './sidePanelWidth';

describe('sidePanelWidth', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('returns the default width when nothing is stored', () => {
    expect(getSidePanelWidth('context')).toBe(400);
  });

  it('round-trips a panel-scoped width', () => {
    setSidePanelWidth('context', 488);

    expect(getSidePanelWidth('context')).toBe(488);
    expect(getSidePanelWidth('agents')).toBe(400);
    expect(window.localStorage.getItem('clawtalk.sidePanelWidth:context')).toBe(
      '488',
    );
  });

  it('clamps stored values to the supported range', () => {
    setSidePanelWidth('context', 80);
    expect(getSidePanelWidth('context')).toBe(320);

    setSidePanelWidth('jobs', 900);
    expect(getSidePanelWidth('jobs')).toBe(640);
  });

  it('supports a narrower dynamic max while resizing', () => {
    expect(clampSidePanelWidth(560, 500)).toBe(500);
    expect(clampSidePanelWidth(220, 500)).toBe(320);
    expect(clampSidePanelWidth(Number.NaN, 350)).toBe(350);
  });

  it('falls back to the default for non-numeric stored values', () => {
    window.localStorage.setItem('clawtalk.sidePanelWidth:context', 'wide');

    expect(getSidePanelWidth('context')).toBe(400);
  });
});
