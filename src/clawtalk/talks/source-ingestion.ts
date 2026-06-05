/**
 * Source ingestion pipeline for context tab URL and file sources.
 *
 * Handles:
 *  - URL fetching with SSRF protection (connect-time enforcement)
 *  - HTML → text extraction
 *  - Status updates via an injected extraction updater
 */

import {
  TALK_CONTEXT_BROWSER_DISABLE_HOSTS,
  TALK_CONTEXT_BROWSER_PREFER_HOSTS,
  TALK_CONTEXT_BROWSER_TIMEOUT_MS,
  TALK_CONTEXT_DOH_ENDPOINT,
  TALK_CONTEXT_MANAGED_FETCH_ENABLED,
  TALK_CONTEXT_MANAGED_FETCH_TIMEOUT_MS,
} from '../config.js';
import {
  type ContextSourceFetchStrategy,
  updateSourceExtraction,
} from '../db/context-accessors.js';
import { logger } from '../../logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);
const MIN_USEFUL_EXTRACTED_TEXT = 400;
const ALLOWED_CONTENT_TYPES = new Set([
  'text/plain',
  'text/html',
  'application/pdf',
]);
// Markers of an ACTUAL bot-challenge / JS interstitial (Cloudflare "Just a
// moment", Turnstile, etc.). Deliberately specific: bare words like
// "cloudflare" or "captcha" appear in plenty of normal pages served through
// Cloudflare, and flagging those falsely routed good content to the (disabled)
// browser fallback and failed the source. Since the browser path cannot
// succeed, a false positive only ever loses good content, so prefer precision.
const CHALLENGE_MARKERS = [
  '<title>just a moment', // CF interstitial title — not bare prose
  'checking your browser before accessing',
  'enable javascript and cookies to continue',
  'cf-browser-verification',
  'attention required! | cloudflare',
];

// ---------------------------------------------------------------------------
// SSRF protection
// ---------------------------------------------------------------------------

function isIpv4Literal(value: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (!match) return false;
  return match.slice(1, 5).every((part) => Number(part) <= 255);
}

/**
 * Normalizes an IPv6 string to its canonical compressed form via the WHATWG
 * URL parser (available on Node and Workers). Returns null for non-IPv6 input.
 * Collapsing expanded / non-canonical forms (`::01`, `0:0:0:0:0:ffff:7f00:1`)
 * is what keeps the blocklist prefix checks below from being bypassed.
 */
function canonicalizeIpv6(value: string): string | null {
  try {
    const host = new URL(`http://[${value}]/`).hostname;
    const inner =
      host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
    return inner.includes(':') ? inner.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Returns true if an IP literal is in a blocked range (loopback, private,
 * link-local, multicast, unspecified, or IPv6 ULA/link-local/multicast).
 * Non-IP input (e.g. a CNAME target hostname) is treated as blocked
 * (fail-closed). Pure string parsing — no `node:net` dependency — so it is
 * identical on Node and the Cloudflare Workers runtime.
 */
export function isBlockedIp(ip: string): boolean {
  const value = ip.trim();

  // IPv4 (dotted quad)
  if (isIpv4Literal(value)) {
    const [a, b] = value.split('.').map(Number);
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 10) return true; // 10.0.0.0/8 private
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
    if (a >= 224 && a <= 239) return true; // 224.0.0.0/4 multicast
    if (a === 0) return true; // 0.0.0.0 unspecified
    return false;
  }

  // IPv6 (any colon-containing literal). Canonicalize first so expanded /
  // non-canonical forms can't slip past the prefix checks below.
  if (value.includes(':')) {
    const normalized = canonicalizeIpv6(value);
    if (!normalized) return true; // not a valid IPv6 literal → fail-closed
    if (normalized === '::1') return true; // loopback
    if (normalized === '::') return true; // unspecified
    if (/^fe[89ab]/.test(normalized)) return true; // fe80::/10 link-local
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) {
      return true; // fc00::/7 unique-local
    }
    if (normalized.startsWith('ff')) return true; // ff00::/8 multicast
    // IPv4-mapped (canonical serialization is the hex form `::ffff:7f00:1`;
    // the dotted form is accepted defensively).
    const mappedHex = normalized.match(
      /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/,
    );
    if (mappedHex) {
      const hi = parseInt(mappedHex[1], 16);
      const lo = parseInt(mappedHex[2], 16);
      return isBlockedIp(
        `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`,
      );
    }
    const mappedDotted = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mappedDotted) return isBlockedIp(mappedDotted[1]);
    return false;
  }

  // Unknown format (e.g. a CNAME target hostname) → block (fail-closed).
  return true;
}

/**
 * Resolves a hostname to its terminal A/AAAA addresses via DNS-over-HTTPS.
 *
 * Used instead of `node:dns.lookup` because the Cloudflare Workers runtime's
 * `dns.lookup` mixes CNAME target strings into its results (which the SSRF
 * check then fail-closes on) and its companion `node:http` socket pinning does
 * not work on Workers. DoH is a plain `fetch()` — Workers-native — and follows
 * CNAME chains itself, returning the final A/AAAA records in `Answer`.
 */
async function resolveViaDoh(hostname: string): Promise<string[]> {
  const addresses: string[] = [];
  for (const recordType of ['A', 'AAAA'] as const) {
    const query = `${TALK_CONTEXT_DOH_ENDPOINT}?name=${encodeURIComponent(
      hostname,
    )}&type=${recordType}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(query, {
        headers: { accept: 'application/dns-json' },
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new SourceIngestionError(
          'dns_resolution_failed',
          `DoH ${recordType} lookup for ${hostname} returned HTTP ${res.status}.`,
        );
      }
      const data = (await res.json()) as {
        Answer?: Array<{ type?: number; data?: string }>;
      };
      for (const answer of data.Answer ?? []) {
        // type 1 = A, type 28 = AAAA. Ignore type 5 (CNAME) — resolving those
        // as IPs is exactly the bug this replaces.
        if ((answer.type === 1 || answer.type === 28) && answer.data) {
          addresses.push(answer.data.trim());
        }
      }
    } catch (err) {
      // Any failure — network, timeout/abort, non-OK, or malformed JSON/shape
      // — is a resolution failure. Fail closed so it is never treated as an
      // ordinary HTTP error (which would route to the browser fallback).
      if (err instanceof SourceIngestionError) throw err;
      throw new SourceIngestionError(
        'dns_resolution_failed',
        `DoH ${recordType} lookup for ${hostname} failed: ${String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
  return addresses;
}

/**
 * SSRF gate for a single URL hop. Rejects `localhost` and any host — IP literal
 * or DNS-resolved — that maps to a blocked IP range.
 *
 * Workers caveat: this validates the resolved IPs but cannot pin them to the
 * subsequent `fetch()` connection (Workers `fetch()` re-resolves internally),
 * so a validate-then-connect rebinding window exists. Accepted here because a
 * Worker's public `fetch()` cannot reach an internal network or cloud-metadata
 * endpoint (no adjacent private network), and the input is the operator's own
 * pasted URL. Fails closed on DoH errors.
 */
async function validateHost(hostname: string): Promise<void> {
  // Strip a trailing FQDN-root dot ("localhost." / "foo.localhost.") so the
  // loopback-name check can't be sidestepped with a trailing dot.
  const lower = hostname.toLowerCase().replace(/\.$/, '');
  if (lower === 'localhost' || lower.endsWith('.localhost')) {
    throw new SourceIngestionError(
      'ssrf_blocked',
      `Hostname "${hostname}" is blocked.`,
    );
  }

  // IP-literal host (URL.hostname brackets IPv6) — validate directly, no DNS.
  const literal =
    hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname;
  if (isIpv4Literal(literal) || literal.includes(':')) {
    if (isBlockedIp(literal)) {
      throw new SourceIngestionError(
        'ssrf_blocked',
        `Address ${literal} is in a blocked IP range.`,
      );
    }
    return;
  }

  const addresses = await resolveViaDoh(hostname);
  if (addresses.length === 0) {
    throw new SourceIngestionError(
      'dns_resolution_failed',
      `Could not resolve hostname: ${hostname}`,
    );
  }
  for (const address of addresses) {
    if (isBlockedIp(address)) {
      throw new SourceIngestionError(
        'ssrf_blocked',
        `Resolved address ${address} for ${hostname} is in a blocked IP range.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class SourceIngestionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SourceIngestionError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// URL fetching with SSRF protection
// ---------------------------------------------------------------------------

interface FetchResult {
  body: string;
  contentType: string;
  finalUrl: string;
}

export interface BrowserSourceFetchResult {
  finalUrl: string;
  pageTitle: string | null;
  extractedText: string;
  contentType: 'text/html';
  strategy: 'browser';
}

export interface BrowserSourceFetcher {
  fetch(input: {
    url: string;
    timeoutMs: number;
  }): Promise<BrowserSourceFetchResult>;
}

export interface ManagedSourceFetchResult {
  finalUrl: string;
  pageTitle: string | null;
  extractedText: string;
  contentType: string;
  strategy: 'managed';
}

export interface ManagedSourceFetcher {
  fetch(input: {
    url: string;
    timeoutMs: number;
  }): Promise<ManagedSourceFetchResult>;
}

export interface UrlSourceIngestionDependencies {
  httpFetcher?: typeof safeFetchUrl;
  browserFetcher?: BrowserSourceFetcher;
  managedFetcher?: ManagedSourceFetcher | null;
  updateExtraction?: typeof updateSourceExtraction;
}

export interface TalkContextSourceIngestionService {
  enqueueUrlSource(sourceId: string, url: string): void;
}

const DEFAULT_BROWSER_SOURCE_FETCHER: BrowserSourceFetcher = {
  fetch: async () => {
    throw new Error(
      'Browser source fetching is disabled in this build (ClawTalk chassis was removed).',
    );
  },
};

function getConfiguredManagedSourceFetcher(): ManagedSourceFetcher | null {
  if (!TALK_CONTEXT_MANAGED_FETCH_ENABLED) return null;
  logger.warn(
    '[source-ingestion] Managed source fetch is enabled, but no managed provider is configured.',
  );
  return null;
}

export function createDefaultTalkContextSourceIngestionService(
  deps?: UrlSourceIngestionDependencies,
): TalkContextSourceIngestionService {
  return {
    enqueueUrlSource(sourceId: string, url: string) {
      void ingestUrlSource(sourceId, url, deps).catch((err) => {
        logger.warn(
          `[source-ingestion] Unexpected URL ingestion crash for ${sourceId}: ${formatStageError(err)}`,
        );
      });
    },
  };
}

/**
 * Reads a response body as UTF-8 text, aborting early if it exceeds `cap`
 * bytes. Web-stream based (no `node:buffer`) so it runs on the Workers runtime.
 */
async function readBodyWithCap(res: Response, cap: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      throw new SourceIngestionError(
        'response_too_large',
        `Response exceeds ${cap} byte limit.`,
      );
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8').decode(merged);
}

/**
 * Fetches a URL with SSRF-safe validation, using the global `fetch()` so it
 * runs on the Cloudflare Workers runtime.
 *
 * Each hop (initial + redirects) is validated by `validateHost` (scheme, then
 * literal/DoH-resolved IP against `isBlockedIp`) before the request is made.
 * Redirects are followed manually (`redirect: 'manual'`) so every hop is
 * re-validated. See `validateHost` for the Workers TOCTOU caveat.
 *
 * Returns the raw text body and content type.
 */
export async function safeFetchUrl(inputUrl: string): Promise<FetchResult> {
  let currentUrl = inputUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const parsed = new URL(currentUrl);

    if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
      throw new SourceIngestionError(
        'invalid_scheme',
        `URL scheme "${parsed.protocol}" is not allowed. Only http and https are supported.`,
      );
    }

    await validateHost(parsed.hostname);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(parsed.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': 'RocketClaw-SourceIngestion/1.0',
          accept: 'text/html, text/plain, application/pdf, */*',
        },
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof SourceIngestionError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new SourceIngestionError(
          'fetch_timeout',
          `Request to ${currentUrl} timed out after ${FETCH_TIMEOUT_MS}ms.`,
        );
      }
      throw new SourceIngestionError(
        'fetch_error',
        `Failed to fetch ${currentUrl}: ${String(err)}`,
      );
    }

    // Handle redirects manually so we validate each hop.
    if (res.status >= 300 && res.status < 400) {
      clearTimeout(timer);
      await res.body?.cancel().catch(() => undefined);
      const location = res.headers.get('location');
      if (!location) {
        throw new SourceIngestionError(
          'redirect_error',
          `Redirect response (${res.status}) missing Location header.`,
        );
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    if (res.status < 200 || res.status >= 300) {
      clearTimeout(timer);
      await res.body?.cancel().catch(() => undefined);
      throw new SourceIngestionError(
        'fetch_http_error',
        `HTTP ${res.status} from ${currentUrl}`,
      );
    }

    // Validate content type.
    const rawContentType = res.headers.get('content-type') ?? '';
    const mimeType = rawContentType.split(';')[0].trim().toLowerCase();
    if (!ALLOWED_CONTENT_TYPES.has(mimeType)) {
      clearTimeout(timer);
      await res.body?.cancel().catch(() => undefined);
      throw new SourceIngestionError(
        'unsupported_content_type',
        `Content type "${mimeType}" is not supported. Allowed: ${[...ALLOWED_CONTENT_TYPES].join(', ')}.`,
      );
    }

    try {
      const body = await readBodyWithCap(res, MAX_RESPONSE_BYTES);
      return { body, contentType: mimeType, finalUrl: currentUrl };
    } catch (err) {
      if (err instanceof SourceIngestionError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new SourceIngestionError(
          'fetch_timeout',
          `Request to ${currentUrl} timed out after ${FETCH_TIMEOUT_MS}ms.`,
        );
      }
      throw new SourceIngestionError(
        'fetch_error',
        `Failed to read body from ${currentUrl}: ${String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  throw new SourceIngestionError(
    'too_many_redirects',
    `Exceeded ${MAX_REDIRECTS} redirects.`,
  );
}

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

/**
 * Extracts plain text from HTML by stripping tags and normalizing whitespace.
 * Simple regex-based approach for v1 — no DOM parser needed.
 */
export function extractTextFromHtml(html: string): string {
  let text = html;

  // Inline `<iframe srcdoc='...'>` content BEFORE stripping tags. Email
  // archive pages (ConvertKit, Mailchimp archive views) wrap the actual
  // body in `<iframe srcdoc='&lt;html&gt;...&lt;/html&gt;'>` where the
  // attribute value is HTML-encoded HTML. Without this expansion, the
  // generic tag-strip below removes the iframe and the attribute value
  // with it, leaving only the wrapper page's `<h2>` title. The replaced
  // content re-enters the pipeline as HTML so its scripts/styles/tags
  // are stripped on the same pass.
  text = text.replace(
    /<iframe\b[^>]*\bsrcdoc=(["'])([\s\S]*?)\1[^>]*>(?:[\s\S]*?<\/iframe>)?/gi,
    (_match, _quote, encoded: string) => `\n${decodeHtmlEntities(encoded)}\n`,
  );

  // Remove script and style blocks
  text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');

  // Convert certain block elements to newlines
  text = text.replace(
    /<\/?(?:p|div|br|h[1-6]|li|tr|td|th|blockquote|pre|hr)[^>]*>/gi,
    '\n',
  );

  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, ' ');

  // Decode common HTML entities
  text = decodeHtmlEntities(text);

  // Collapse whitespace
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n[ ]+/g, '\n');
  text = text.replace(/[ ]+\n/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

/**
 * Extracts text from fetched content based on content type.
 */
function extractText(body: string, contentType: string): string {
  switch (contentType) {
    case 'text/html':
      return extractTextFromHtml(body);
    case 'text/plain':
      return body.trim();
    case 'application/pdf':
      // PDF text extraction not implemented in v1.
      // The raw binary body is useless as text — we'd need a PDF parser.
      // For now, return an error message. A future version should use
      // a PDF-to-text library.
      return '[PDF content — text extraction not yet supported in v1]';
    default:
      return body.trim();
  }
}

function hostnameMatches(hostname: string, candidates: string[]): boolean {
  return candidates.some(
    (candidate) => hostname === candidate || hostname.endsWith(`.${candidate}`),
  );
}

function shouldPreferBrowserForUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostnameMatches(hostname, TALK_CONTEXT_BROWSER_PREFER_HOSTS);
  } catch {
    return false;
  }
}

function shouldDisableBrowserForUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostnameMatches(hostname, TALK_CONTEXT_BROWSER_DISABLE_HOSTS);
  } catch {
    return false;
  }
}

function looksLikeChallengePage(html: string): boolean {
  const normalized = html.toLowerCase();
  return CHALLENGE_MARKERS.some((marker) => normalized.includes(marker));
}

function shouldAttemptBrowserFallback(input: {
  url: string;
  fetchResult?: FetchResult | null;
  extractedText?: string | null;
  httpError?: SourceIngestionError | Error | null;
}): boolean {
  if (shouldDisableBrowserForUrl(input.url)) return false;
  if (shouldPreferBrowserForUrl(input.url)) return true;

  if (input.httpError) {
    if (
      input.httpError instanceof SourceIngestionError &&
      ['invalid_scheme', 'ssrf_blocked', 'dns_resolution_failed'].includes(
        input.httpError.code,
      )
    ) {
      return false;
    }
    return true;
  }

  if (!input.fetchResult || input.fetchResult.contentType !== 'text/html') {
    return false;
  }

  if (looksLikeChallengePage(input.fetchResult.body)) return true;

  return (input.extractedText?.trim().length ?? 0) < MIN_USEFUL_EXTRACTED_TEXT;
}

function formatStageError(err: unknown): string {
  if (err instanceof SourceIngestionError) {
    return `${err.code}: ${err.message}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

function finalStrategyForFailure(input: {
  managedAttempted: boolean;
  browserAttempted: boolean;
}): ContextSourceFetchStrategy | null {
  if (input.managedAttempted) return 'managed';
  if (input.browserAttempted) return 'browser';
  return 'http';
}

export async function ingestUrlSourceWithBrowser(
  sourceId: string,
  url: string,
  options?: {
    browserFetcher?: BrowserSourceFetcher;
    updateExtraction?: typeof updateSourceExtraction;
    fetchedAt?: string;
  },
): Promise<BrowserSourceFetchResult> {
  const browserFetcher =
    options?.browserFetcher || DEFAULT_BROWSER_SOURCE_FETCHER;
  const updateExtractionFn =
    options?.updateExtraction || updateSourceExtraction;
  const fetchedAt = options?.fetchedAt ?? new Date().toISOString();
  const result = await browserFetcher.fetch({
    url,
    timeoutMs: TALK_CONTEXT_BROWSER_TIMEOUT_MS,
  });

  if (!result.extractedText.trim()) {
    throw new SourceIngestionError(
      'browser_empty',
      'Browser fallback rendered the page, but extracted no useful text.',
    );
  }

  await updateExtractionFn({
    sourceId,
    extractedText: result.extractedText,
    extractionError: null,
    mimeType: result.contentType,
    fetchStrategy: 'browser',
    fetchedAt,
  });

  return result;
}

// ---------------------------------------------------------------------------
// Ingestion entry point
// ---------------------------------------------------------------------------

/**
 * Fetches a URL source, extracts text, and updates the database record.
 * This is designed to be called from a background queue/worker.
 *
 * On success: source status → ready, extracted text stored.
 * On failure: extraction_error written; if last-good content exists,
 * status stays ready; otherwise status → failed.
 */
export async function ingestUrlSource(
  sourceId: string,
  url: string,
  deps?: UrlSourceIngestionDependencies,
): Promise<void> {
  const httpFetcher = deps?.httpFetcher ?? safeFetchUrl;
  const browserFetcher = deps?.browserFetcher ?? DEFAULT_BROWSER_SOURCE_FETCHER;
  const managedFetcher =
    deps?.managedFetcher ?? getConfiguredManagedSourceFetcher();
  const updateExtractionFn = deps?.updateExtraction ?? updateSourceExtraction;
  const fetchedAt = new Date().toISOString();
  let httpError: SourceIngestionError | Error | null = null;
  let browserError: Error | null = null;
  let managedError: Error | null = null;
  let browserAttempted = false;
  let managedAttempted = false;
  let httpFallback: {
    extractedText: string;
    contentType: string;
    isChallenge: boolean;
  } | null = null;
  let shouldPreferBrowser = false;

  try {
    const result = await httpFetcher(url);
    const extracted = extractText(result.body, result.contentType);
    httpFallback = {
      extractedText: extracted,
      contentType: result.contentType,
      // Classify on the RAW body once; the fallback gate below reuses this so
      // its decision matches shouldAttemptBrowserFallback (which also inspects
      // the raw body) instead of re-scanning stripped text, where tag-context
      // markers like `<title>just a moment` can no longer match.
      isChallenge: looksLikeChallengePage(result.body),
    };
    shouldPreferBrowser = shouldAttemptBrowserFallback({
      url,
      fetchResult: result,
      extractedText: extracted,
    });

    if (!shouldPreferBrowser) {
      await updateExtractionFn({
        sourceId,
        extractedText: extracted,
        extractionError: null,
        mimeType: result.contentType,
        fetchStrategy: 'http',
        fetchedAt,
      });

      logger.info(
        `[source-ingestion] URL source ${sourceId} ingested successfully ` +
          `(${extracted.length} chars, type=${result.contentType}, strategy=http).`,
      );
      return;
    }
  } catch (err) {
    httpError = err instanceof Error ? err : new Error(String(err));
  }

  if (
    shouldPreferBrowser ||
    shouldAttemptBrowserFallback({
      url,
      httpError,
    })
  ) {
    browserAttempted = true;
    try {
      const browserResult = await ingestUrlSourceWithBrowser(sourceId, url, {
        browserFetcher,
        updateExtraction: updateExtractionFn,
        fetchedAt,
      });

      logger.info(
        `[source-ingestion] URL source ${sourceId} ingested successfully ` +
          `(${browserResult.extractedText.length} chars, type=${browserResult.contentType}, strategy=browser).`,
      );
      return;
    } catch (err) {
      browserError = err instanceof Error ? err : new Error(String(err));
    }
  }

  if (managedFetcher) {
    managedAttempted = true;
    try {
      const managedResult = await managedFetcher.fetch({
        url,
        timeoutMs: TALK_CONTEXT_MANAGED_FETCH_TIMEOUT_MS,
      });
      await updateExtractionFn({
        sourceId,
        extractedText: managedResult.extractedText,
        extractionError: null,
        mimeType: managedResult.contentType,
        fetchStrategy: 'managed',
        fetchedAt,
      });

      logger.info(
        `[source-ingestion] URL source ${sourceId} ingested successfully ` +
          `(${managedResult.extractedText.length} chars, type=${managedResult.contentType}, strategy=managed).`,
      );
      return;
    } catch (err) {
      managedError = err instanceof Error ? err : new Error(String(err));
    }
  }

  if (
    httpFallback &&
    !httpFallback.isChallenge &&
    httpFallback.extractedText.trim().length >= MIN_USEFUL_EXTRACTED_TEXT
  ) {
    await updateExtractionFn({
      sourceId,
      extractedText: httpFallback.extractedText,
      extractionError: null,
      mimeType: httpFallback.contentType,
      fetchStrategy: 'http',
      fetchedAt,
    });
    logger.warn(
      `[source-ingestion] URL source ${sourceId} fell back to HTTP extraction after browser/managed failure.`,
    );
    return;
  }

  const messageParts = [
    httpError ? `http: ${formatStageError(httpError)}` : null,
    browserError ? `browser: ${formatStageError(browserError)}` : null,
    managedError ? `managed: ${formatStageError(managedError)}` : null,
  ].filter(Boolean);
  const message = messageParts.join(' | ') || 'Unknown URL ingestion failure.';

  await updateExtractionFn({
    sourceId,
    extractedText: null,
    extractionError: message,
    fetchStrategy: finalStrategyForFailure({
      browserAttempted,
      managedAttempted,
    }),
    fetchedAt,
  });

  logger.warn(
    `[source-ingestion] URL source ${sourceId} ingestion failed: ${message}`,
  );
}

/**
 * Processes an uploaded file's content and stores extracted text.
 * For v1, we handle text-based formats directly. PDF extraction is deferred.
 */
export async function ingestFileSource(
  sourceId: string,
  fileContent: string | Buffer,
  mimeType: string,
  fileName: string,
): Promise<void> {
  try {
    const textContent =
      typeof fileContent === 'string'
        ? fileContent
        : fileContent.toString('utf-8');

    let extracted: string;
    switch (mimeType) {
      case 'text/plain':
      case 'text/markdown':
        extracted = textContent.trim();
        break;
      case 'text/html':
        extracted = extractTextFromHtml(textContent);
        break;
      case 'application/pdf':
        extracted = '[PDF content — text extraction not yet supported in v1]';
        break;
      case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
        extracted = '[DOCX content — text extraction not yet supported in v1]';
        break;
      default:
        extracted = textContent.trim();
        break;
    }

    await updateSourceExtraction({
      sourceId,
      extractedText: extracted,
      extractionError: null,
      mimeType,
    });

    logger.info(
      `[source-ingestion] File source ${sourceId} (${fileName}) ingested ` +
        `(${extracted.length} chars, type=${mimeType}).`,
    );
  } catch (err) {
    const message = String(err);

    await updateSourceExtraction({
      sourceId,
      extractedText: null,
      extractionError: message,
    });

    logger.warn(
      `[source-ingestion] File source ${sourceId} (${fileName}) ingestion failed: ${message}`,
    );
  }
}
