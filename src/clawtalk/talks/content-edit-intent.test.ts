import { describe, expect, it } from 'vitest';

import {
  isContentEditIntent,
  lastUserMessageText,
} from './content-edit-intent.js';

describe('isContentEditIntent', () => {
  it('fires when @doc and an edit verb appear in the same sentence', () => {
    expect(isContentEditIntent('@doc add a summary paragraph at the end')).toBe(
      true,
    );
    expect(isContentEditIntent('please rewrite @doc to be tighter')).toBe(true);
    expect(isContentEditIntent('fix the typos in @doc')).toBe(true);
    expect(isContentEditIntent('replace paragraph 3 of @doc with this')).toBe(
      true,
    );
    expect(isContentEditIntent('extend @doc with a closing CTA')).toBe(true);
    expect(isContentEditIntent('shorten the intro of @doc')).toBe(true);
    expect(isContentEditIntent('delete the third paragraph of @doc')).toBe(
      true,
    );
    expect(isContentEditIntent('polish @doc')).toBe(true);
    expect(isContentEditIntent('revise @doc to remove jargon')).toBe(true);
  });

  it('matches verb morphology (added, editing, rewrote, etc.)', () => {
    expect(isContentEditIntent('we edited @doc — please reflect changes')).toBe(
      true,
    );
    expect(
      isContentEditIntent('rewrote @doc, let me know what you think'),
    ).toBe(true);
    expect(isContentEditIntent('appending some notes to @doc')).toBe(true);
  });

  it('does NOT fire when @doc is mentioned without an edit verb', () => {
    expect(isContentEditIntent('what does @doc say about pricing?')).toBe(
      false,
    );
    expect(isContentEditIntent('@doc')).toBe(false);
    expect(isContentEditIntent('summarize @doc for me')).toBe(false);
    expect(isContentEditIntent('evaluate @doc against the brief')).toBe(false);
    expect(isContentEditIntent('analyze the tone of @doc')).toBe(false);
    expect(isContentEditIntent('what are your thoughts on @doc?')).toBe(false);
    expect(isContentEditIntent('critique @doc as harshly as you can')).toBe(
      false,
    );
    expect(isContentEditIntent('compare @doc to the latest GPT version')).toBe(
      false,
    );
  });

  it('does NOT fire when @doc is absent', () => {
    expect(isContentEditIntent('add a summary paragraph at the end')).toBe(
      false,
    );
    expect(isContentEditIntent('rewrite the intro to be tighter')).toBe(false);
    expect(isContentEditIntent('please fix the typos')).toBe(false);
  });

  it('does NOT cross sentence boundaries when looking for edit verbs', () => {
    // "@doc" is in the first sentence; "add" is in the second. The
    // user is referencing @doc for analysis, then asking for an
    // unrelated edit to something else. Shouldn't gate.
    expect(
      isContentEditIntent(
        'what does @doc say about pricing? then add a TODO to my notes.',
      ),
    ).toBe(false);
  });

  it('matches across bullet lists by treating each line independently', () => {
    const msg = [
      "Here's what I want:",
      '- evaluate @doc tone',
      '- add a closing paragraph to @doc',
    ].join('\n');
    // Second bullet has @doc + add => edit intent.
    expect(isContentEditIntent(msg)).toBe(true);
  });

  it('handles empty / null / undefined input cleanly', () => {
    expect(isContentEditIntent('')).toBe(false);
    expect(isContentEditIntent('   ')).toBe(false);
  });

  it('does not match edit-verb substrings inside larger words', () => {
    // "additional" contains "add" — must not match.
    expect(
      isContentEditIntent('@doc has additional context worth noting'),
    ).toBe(false);
    // "extension" contains "extend" — must not match.
    expect(isContentEditIntent('@doc is an extension of the prior brief')).toBe(
      false,
    );
  });
});

describe('lastUserMessageText', () => {
  it('returns the last user message string content', () => {
    expect(
      lastUserMessageText([
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second' },
      ]),
    ).toBe('second');
  });

  it('concatenates multimodal text parts', () => {
    expect(
      lastUserMessageText([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hello' },
            { type: 'image_url', url: 'x' },
            { type: 'text', text: 'world' },
          ],
        },
      ]),
    ).toBe('hello\nworld');
  });

  it('returns empty string when no user message exists', () => {
    expect(lastUserMessageText([{ role: 'assistant', content: 'reply' }])).toBe(
      '',
    );
    expect(lastUserMessageText([])).toBe('');
  });
});
