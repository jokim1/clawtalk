import { describe, expect, it } from 'vitest';

import {
  createTalkResponseStreamSanitizer,
  stripInternalTalkResponseText,
  stripLeadingAgentLabel,
} from './internal-tags.js';

// Feed text through the streaming sanitizer one character at a time and
// return the concatenated visible output — the worst case for a leading-label
// buffer, since the label arrives byte by byte.
function streamCharByChar(text: string, nickname?: string | null): string {
  const sanitizer = createTalkResponseStreamSanitizer(nickname);
  let out = '';
  for (const char of text) out += sanitizer.push(char);
  return out;
}

describe('stripLeadingAgentLabel', () => {
  it('strips a single leading self-label line', () => {
    expect(
      stripLeadingAgentLabel(
        '[Strategy Lead]\nThesis: launch at $49.',
        'Strategy Lead',
      ),
    ).toBe('Thesis: launch at $49.');
  });

  it('strips a doubled leading self-label and the blank line after it', () => {
    expect(
      stripLeadingAgentLabel(
        '[Strategy Lead]\n[Strategy Lead]\n\nThesis: go.',
        'Strategy Lead',
      ),
    ).toBe('Thesis: go.');
  });

  it('tolerates padding inside the brackets', () => {
    expect(
      stripLeadingAgentLabel('[ Strategy Lead ]\nBody', 'Strategy Lead'),
    ).toBe('Body');
  });

  it('leaves a non-matching speaker name untouched', () => {
    const text = '[Editor]\nThesis from the editor.';
    expect(stripLeadingAgentLabel(text, 'Strategy Lead')).toBe(text);
  });

  it('never strips a bracketed token that is not the leading line', () => {
    const text = 'See [Strategy Lead]\nfor context.';
    expect(stripLeadingAgentLabel(text, 'Strategy Lead')).toBe(text);
  });

  it('does not strip an inline bracket without a trailing newline', () => {
    const text = '[Strategy Lead] says hello';
    expect(stripLeadingAgentLabel(text, 'Strategy Lead')).toBe(text);
  });

  it('escapes regex-special characters in the nickname', () => {
    expect(stripLeadingAgentLabel('[C++ (Critic)]\nBody', 'C++ (Critic)')).toBe(
      'Body',
    );
  });

  it('is a no-op without a nickname', () => {
    expect(stripLeadingAgentLabel('[Strategy Lead]\nBody', null)).toBe(
      '[Strategy Lead]\nBody',
    );
    expect(stripLeadingAgentLabel('[Strategy Lead]\nBody', '   ')).toBe(
      '[Strategy Lead]\nBody',
    );
  });

  it('returns empty input unchanged', () => {
    expect(stripLeadingAgentLabel('', 'Strategy Lead')).toBe('');
  });
});

describe('createTalkResponseStreamSanitizer with a nickname', () => {
  it('suppresses a leading self-label streamed char-by-char', () => {
    expect(
      streamCharByChar('[Strategy Lead]\nThesis: launch.', 'Strategy Lead'),
    ).toBe('Thesis: launch.');
  });

  it('suppresses a doubled self-label streamed char-by-char', () => {
    expect(
      streamCharByChar(
        '[Strategy Lead]\n[Strategy Lead]\n\nThesis.',
        'Strategy Lead',
      ),
    ).toBe('Thesis.');
  });

  it('never drops body that merely starts with a bracket', () => {
    expect(streamCharByChar('[not a label] body', 'Strategy Lead')).toBe(
      '[not a label] body',
    );
  });

  it('preserves a later, mid-reply bracket mention', () => {
    const text = '[Strategy Lead]\nDefer to [Strategy Lead] next round.';
    expect(streamCharByChar(text, 'Strategy Lead')).toBe(
      'Defer to [Strategy Lead] next round.',
    );
  });

  it('matches the persist-time strip for the same input', () => {
    const raw = '[Strategy Lead]\n[Strategy Lead]\n\nThesis: go.';
    const streamed = streamCharByChar(raw, 'Strategy Lead');
    const persisted = stripLeadingAgentLabel(
      stripInternalTalkResponseText(raw),
      'Strategy Lead',
    );
    expect(streamed).toBe(persisted);
    expect(streamed).toBe('Thesis: go.');
  });

  it('strips <internal> blocks alongside the label at persist time', () => {
    // The persist path sees the full text, so the label and a complete
    // <internal> block are both removed.
    expect(
      stripLeadingAgentLabel(
        stripInternalTalkResponseText(
          '[Strategy Lead]\n<internal>scratch</internal>Visible.',
        ),
        'Strategy Lead',
      ),
    ).toBe('Visible.');
  });

  it('strips the label and a whole-chunk <internal> block while streaming', () => {
    // Realistic streaming pushes deltas of several chars; a complete
    // <internal>…</internal> block in one push is stripped, as is the label.
    const sanitizer = createTalkResponseStreamSanitizer('Strategy Lead');
    let out = sanitizer.push('[Strategy Lead]\n');
    out += sanitizer.push('<internal>scratch</internal>');
    out += sanitizer.push('Visible.');
    expect(out).toBe('Visible.');
  });

  it('passes plain text through unchanged when no label is present', () => {
    expect(streamCharByChar('Just a normal answer.', 'Strategy Lead')).toBe(
      'Just a normal answer.',
    );
  });

  it('suppresses a padded label variant streamed char-by-char', () => {
    expect(
      streamCharByChar('[ Strategy Lead ]\nBody here.', 'Strategy Lead'),
    ).toBe('Body here.');
  });

  it('suppresses a CRLF label variant streamed char-by-char', () => {
    expect(
      streamCharByChar('[Strategy Lead]\r\nBody here.', 'Strategy Lead'),
    ).toBe('Body here.');
  });

  it('does not over-hold a bracket whose name diverges from the nickname', () => {
    // `[Strawberries]` shares a prefix with the nick but is body, not a label.
    expect(streamCharByChar('[Strawberries] are red.', 'Strategy Lead')).toBe(
      '[Strawberries] are red.',
    );
  });

  it('behaves like the unparameterized sanitizer when no nickname is given', () => {
    expect(streamCharByChar('[Strategy Lead]\nBody')).toBe(
      '[Strategy Lead]\nBody',
    );
  });
});
