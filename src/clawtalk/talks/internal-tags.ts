const INTERNAL_TAG_PATTERN = /<internal>[\s\S]*?(?:<\/internal>|$)/g;
const NO_CHANNEL_REPLY_DIRECTIVE_PATTERN = /^\s*\[\[NO_CHANNEL_REPLY\]\]\s*/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Multi-agent Talk history prepends each prior assistant turn with its
 * speaker name in brackets (`[Strategy Lead]\n…`, see
 * greenfield-executor.buildGreenfieldHistory) so the model can tell who said
 * what. Models then imitate that pattern and open their OWN reply with the
 * same bracketed self-label — observed as a literal `[Strategy Lead]` (often
 * doubled) at the top of opus replies. This strips a run of leading
 * self-label lines plus the blank lines they leave behind. Only the agent's
 * exact own nickname is matched, so bracketed content elsewhere in the reply
 * (citations, markdown, a different speaker's name) is never touched.
 */
export function stripLeadingAgentLabel(
  text: string,
  nickname: string | null | undefined,
): string {
  if (!text) return text;
  const trimmedNickname = nickname?.trim();
  if (!trimmedNickname) return text;
  // A complete self-label line: optional leading blank lines, `[Nickname]`
  // (tolerant of inner padding), optional trailing spaces, then a newline.
  const labelLine = new RegExp(
    `^[ \\t\\r\\n]*\\[[ \\t]*${escapeRegExp(trimmedNickname)}[ \\t]*\\][ \\t]*\\r?\\n`,
  );
  let result = text;
  while (labelLine.test(result)) {
    result = result.replace(labelLine, '');
  }
  // Drop the blank lines the stripped labels left in front of the body.
  return result === text ? result : result.replace(/^[ \t\r\n]+/, '');
}

/**
 * True when the streamed head so far is a strict, not-yet-complete prefix of a
 * leading self-label — the terminating `]`+newline hasn't arrived yet. Mirrors
 * the grammar `stripLeadingAgentLabel` accepts (`[ \t\r\n]* \[ [ \t]* nick
 * [ \t]* \] [ \t]* \r?\n`), including bracket padding and CRLF, so the streaming
 * sanitizer withholds every variant the persist-time stripper would remove and
 * the label never flashes on screen.
 */
function hasIncompleteLeadingLabel(text: string, nickname: string): boolean {
  // Leading whitespace is allowed before the bracket; if that's all we have
  // so far, a label could still follow.
  const afterLeadingWs = text.replace(/^[ \t\r\n]+/, '');
  if (afterLeadingWs.length === 0) return text.length > 0;
  if (afterLeadingWs[0] !== '[') return false;
  // Consume `[` then any bracket padding.
  const afterBracket = afterLeadingWs.slice(1).replace(/^[ \t]*/, '');
  // The nickname is still being typed: a strict prefix of it.
  if (afterBracket.length < nickname.length) {
    return nickname.startsWith(afterBracket);
  }
  // The full nickname is present; the rest must be a not-yet-terminated tail
  // `[ \t]* \] [ \t]* \r?` with no closing newline yet.
  if (!afterBracket.startsWith(nickname)) return false;
  const tail = afterBracket.slice(nickname.length);
  return /^[ \t]*(?:\][ \t]*\r?)?$/.test(tail);
}

export function extractChannelReplyControl(text: string): {
  suppressDelivery: boolean;
  visibleText: string;
  rationale: string | null;
} {
  if (!text) {
    return {
      suppressDelivery: false,
      visibleText: '',
      rationale: null,
    };
  }
  const withoutInternal = text.replace(INTERNAL_TAG_PATTERN, '');
  const suppressDelivery =
    NO_CHANNEL_REPLY_DIRECTIVE_PATTERN.test(withoutInternal);
  const visibleText = suppressDelivery
    ? withoutInternal.replace(NO_CHANNEL_REPLY_DIRECTIVE_PATTERN, '')
    : withoutInternal;
  const trimmedVisibleText = visibleText.trim();
  return {
    suppressDelivery,
    visibleText: trimmedVisibleText ? visibleText : trimmedVisibleText,
    rationale: suppressDelivery ? trimmedVisibleText || null : null,
  };
}

export function stripInternalTalkResponseText(text: string): string {
  return extractChannelReplyControl(text).visibleText;
}

export interface TalkResponseStreamSanitizer {
  push(chunk: string): string;
}

export function createTalkResponseStreamSanitizer(
  nickname?: string | null,
): TalkResponseStreamSanitizer {
  let rawText = '';
  let visibleText = '';
  const trimmedNickname = nickname?.trim() || null;

  return {
    push(chunk: string): string {
      rawText += chunk;
      const afterInternal = stripInternalTalkResponseText(rawText);
      let nextVisibleText = stripLeadingAgentLabel(
        afterInternal,
        trimmedNickname,
      );
      // Complete leading labels are gone; if the head could still be growing
      // into one, hold the whole remainder back so it never flashes.
      if (
        trimmedNickname &&
        hasIncompleteLeadingLabel(nextVisibleText, trimmedNickname)
      ) {
        nextVisibleText = '';
      }
      // The transform is leading-anchored and the body grows monotonically.
      // If a held head clears to empty, re-baseline without emitting a
      // negative slice.
      if (nextVisibleText.length < visibleText.length) {
        visibleText = nextVisibleText;
        return '';
      }
      const nextDeltaText = nextVisibleText.slice(visibleText.length);
      visibleText = nextVisibleText;
      return nextDeltaText;
    },
  };
}
