import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clearTalkScroll, loadTalkScroll, saveTalkScroll } from './talkScroll';

describe('talkScroll', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('returns null when no state was saved', () => {
    expect(loadTalkScroll('talk-a')).toBeNull();
  });

  it('round-trips per Talk', () => {
    saveTalkScroll('talk-a', { offset: 240, atBottom: false });
    saveTalkScroll('talk-b', { offset: 99, atBottom: false });
    expect(loadTalkScroll('talk-a')).toEqual({
      offset: 240,
      atBottom: false,
    });
    expect(loadTalkScroll('talk-b')).toEqual({
      offset: 99,
      atBottom: false,
    });
  });

  it('overwrites the saved state on repeat save', () => {
    saveTalkScroll('talk-a', { offset: 10, atBottom: false });
    saveTalkScroll('talk-a', { offset: 999, atBottom: true });
    expect(loadTalkScroll('talk-a')).toEqual({
      offset: 999,
      atBottom: true,
    });
  });

  it('clamps negative offsets to zero', () => {
    saveTalkScroll('talk-a', { offset: -50, atBottom: false });
    expect(loadTalkScroll('talk-a')?.offset).toBe(0);
  });

  it('returns null for corrupt JSON', () => {
    window.localStorage.setItem('clawtalk.scroll:talk-a', '{not json');
    expect(loadTalkScroll('talk-a')).toBeNull();
  });

  it('returns null when atBottom is missing', () => {
    window.localStorage.setItem(
      'clawtalk.scroll:talk-a',
      JSON.stringify({ offset: 100 }),
    );
    expect(loadTalkScroll('talk-a')).toBeNull();
  });

  it('clearTalkScroll removes the saved entry', () => {
    saveTalkScroll('talk-a', { offset: 120, atBottom: false });
    clearTalkScroll('talk-a');
    expect(loadTalkScroll('talk-a')).toBeNull();
  });

  it('migrates the previous Talk-keyed rail entry', () => {
    window.localStorage.setItem(
      'clawtalk.scroll:talk-a:talk-a',
      JSON.stringify({ offset: 77, atBottom: false }),
    );

    expect(loadTalkScroll('talk-a')).toEqual({ offset: 77, atBottom: false });
    expect(window.localStorage.getItem('clawtalk.scroll:talk-a')).toBe(
      JSON.stringify({ offset: 77, atBottom: false }),
    );
    expect(
      window.localStorage.getItem('clawtalk.scroll:talk-a:talk-a'),
    ).toBeNull();
  });

  it('migrates older per-rail entries for the same Talk', () => {
    window.localStorage.setItem(
      'clawtalk.scroll:talk-a:legacy-rail',
      JSON.stringify({ offset: 33, atBottom: false }),
    );

    expect(loadTalkScroll('talk-a')).toEqual({ offset: 33, atBottom: false });
    expect(window.localStorage.getItem('clawtalk.scroll:talk-a')).toBe(
      JSON.stringify({ offset: 33, atBottom: false }),
    );
    expect(
      window.localStorage.getItem('clawtalk.scroll:talk-a:legacy-rail'),
    ).toBeNull();
  });
});
