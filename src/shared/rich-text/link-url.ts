// Link URL normalization. Allows http, https, mailto only — the plan
// constraint from design review (sanitizer policy: no javascript:, no
// data:, no file:). Adapted from rocketboard with two changes:
//   - 'tel:' dropped (clawtalk has no telephony surface in v1)
//   - returns '' for unsafe inputs; callers treat '' as "drop the link
//     mark entirely" (same convention as the rocketboard original).

const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
const EXPLICIT_LINK_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;
const RELATIVE_LINK_PATTERN = /^(\/|#|\?|\.\/|\.\.\/)/;

export function normalizeRichTextLinkUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';

  if (trimmed.startsWith('//')) {
    return normalizeRichTextLinkUrl(`https:${trimmed}`);
  }

  if (RELATIVE_LINK_PATTERN.test(trimmed)) {
    return '';
  }

  const candidate = EXPLICIT_LINK_SCHEME_PATTERN.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  try {
    const parsed = new URL(candidate);
    if (!SAFE_LINK_PROTOCOLS.has(parsed.protocol)) return '';
    if (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      !parsed.hostname
    ) {
      return '';
    }
    if (parsed.protocol === 'mailto:' && !parsed.pathname) return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

export function isAllowedRichTextLinkUrl(value: string): boolean {
  return normalizeRichTextLinkUrl(value).length > 0;
}
