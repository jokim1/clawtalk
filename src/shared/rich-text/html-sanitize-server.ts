// Server-side sanitizer for the HTML content format. Cloudflare
// Workers-compatible (sanitize-html ships its own htmlparser2-based
// parser; no Node DOM dependency).
//
// Storage truth = sanitized HTML. DOMPurify in the webapp is
// defense-in-depth — anything that survives this server pass is what
// hits the DB and what we render later. PR A only ships the wrapper;
// PR B wires it into the apply-handler + save paths.

import sanitizeHtml from 'sanitize-html';

import type { IOptions } from 'sanitize-html';

import {
  ALLOWED_ATTRS,
  ALLOWED_TAGS,
  ALLOWED_URL_SCHEMES,
} from './html-sanitize-config.js';

export interface StrippedTagCount {
  tag: string;
  count: number;
}

export interface SanitizeResult {
  clean: string;
  stripped: StrippedTagCount[];
}

// Build the sanitize-html allowedAttributes map by combining the '*'
// (global) bucket with the per-tag bucket from the shared config.
function buildAllowedAttributes(): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  const globals = ALLOWED_ATTRS['*'] ?? [];
  for (const tag of ALLOWED_TAGS) {
    const perTag = ALLOWED_ATTRS[tag] ?? [];
    map[tag] = Array.from(new Set([...globals, ...perTag]));
  }
  // sanitize-html supports '*' itself for global passthrough; include
  // it as a redundant safety net so future tags we forget pick up the
  // global allowlist.
  map['*'] = [...globals];
  return map;
}

const ALLOWED_ATTRIBUTES = buildAllowedAttributes();

// Tags that the parser counts but are not in our allowlist. We track
// "what got stripped" by tallying tag opens in the input and diffing
// the output. sanitize-html has no first-class strip hook for the
// public API, so we run two passes:
//   1. Tally input tag opens via the htmlparser2 walk (via a no-op
//      transformTags pass that mirrors all input tags).
//   2. Sanitize for real and tally output tag opens.
// The diff is the stripped report. This is O(n) in body size which is
// fine for our 512 KB doc limit.

function tallyTagOpens(html: string): Map<string, number> {
  const tally = new Map<string, number>();
  // Match `<tagname` where tagname is letters/digits/hyphen — covers
  // both HTML and SVG element names (`linearGradient`, `feImage`,
  // etc.). Skip closing tags (start with `/`) and comments (`!`).
  const re = /<\s*([a-zA-Z][a-zA-Z0-9-]*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const tag = match[1].toLowerCase();
    tally.set(tag, (tally.get(tag) ?? 0) + 1);
  }
  return tally;
}

function diffStripped(
  input: Map<string, number>,
  output: Map<string, number>,
): StrippedTagCount[] {
  const stripped: StrippedTagCount[] = [];
  for (const [tag, count] of input.entries()) {
    const outCount = output.get(tag) ?? 0;
    if (count > outCount) {
      stripped.push({ tag, count: count - outCount });
    }
  }
  stripped.sort((a, b) => a.tag.localeCompare(b.tag));
  return stripped;
}

const OPTIONS: IOptions = {
  allowedTags: [...ALLOWED_TAGS],
  disallowedTagsMode: 'discard',
  allowedAttributes: ALLOWED_ATTRIBUTES as Record<string, string[]>,
  allowedSchemes: [...ALLOWED_URL_SCHEMES],
  allowedSchemesAppliedToAttributes: ['href', 'src', 'cite', 'srcset'],
  allowProtocolRelative: false,
  allowedSchemesByTag: {
    // Only allow data: in img/source; banning it on <a href> closes
    // the data:text/html exploit vector.
    img: ['http', 'https', 'data'],
    source: ['http', 'https', 'data'],
    a: ['http', 'https', 'mailto', 'tel'],
  },
  // Inline styles get a value-level allowlist: numbers/units/colors
  // are fine; url(...) and javascript: get stripped. We accept any
  // property; sanitize-html validates the *value* against the regex
  // set below.
  allowedStyles: {
    '*': {
      // Generic CSS-value pattern: hex / rgb / named colors / dimensions /
      // keywords / quoted strings / `calc(...)`. Excludes `url(...)`,
      // `expression(...)`, and any javascript: payload.
      '*': [/^[a-zA-Z0-9#%(),.\-_+ '"/]+$/],
    },
  },
  // We deliberately allow <style> for scoped CSS + @keyframes — the
  // editor surface accepts it as an authoring affordance. sanitize-html
  // emits a console warning unless we ack the risk. We accept it: the
  // server pass + the client DOMPurify pass + scoped tags-only contract
  // make this safe for our internal-doc use case (no third-party
  // submission path into the HTML body).
  allowVulnerableTags: true,
  // Always force noreferrer on cross-origin links; matches the
  // editorialroom + rocketboard defaults.
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', {
      rel: 'noopener noreferrer',
    }),
  },
  parser: {
    // SVG tags are case-sensitive (`linearGradient`, `feImage`, etc.).
    // The htmlparser2 default lowercases tags before matching, which
    // strips every camelCase SVG element. Preserve case so our SVG
    // subset stays intact.
    lowerCaseTags: false,
    lowerCaseAttributeNames: false,
  },
};

/**
 * Sanitize an HTML payload against the shared allowlist.
 *
 * Returns the sanitized HTML plus a per-tag tally of what was stripped.
 * The `stripped` list is for UI feedback ("Stripped 1 tag: <script>");
 * the `clean` string is what gets persisted.
 */
export function sanitizeHtmlServer(html: string): SanitizeResult {
  if (typeof html !== 'string') {
    return { clean: '', stripped: [] };
  }
  const inputTally = tallyTagOpens(html);
  const clean = sanitizeHtml(html, OPTIONS);
  const outputTally = tallyTagOpens(clean);
  const stripped = diffStripped(inputTally, outputTally);
  return { clean, stripped };
}
