import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', () => ({
  TALK_CONTEXT_DOH_ENDPOINT: 'https://doh.test/dns-query',
}));

vi.mock('../../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import {
  extractTextFromFeed,
  extractTextFromHtml,
  findFeedUrl,
  ingestUrlSource,
  isBlockedIp,
  safeFetchUrl,
  SourceIngestionError,
} from './source-ingestion.js';

describe('source-ingestion', () => {
  const updateExtraction = vi.fn();

  beforeEach(() => {
    updateExtraction.mockReset();
  });

  // One test below drives the real safeFetchUrl (default httpFetcher) and stubs
  // global fetch via installFetch; unstub after each so the injected-fetcher
  // tests are unaffected.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  type ExtractionCall = {
    extractedText: string | null;
    extractionError: string | null;
    fetchStrategy?: string | null;
    mimeType?: string;
  };
  const firstPayload = (): ExtractionCall =>
    updateExtraction.mock.calls[0][0] as ExtractionCall;

  it('stores HTTP extraction when the page yields useful text', async () => {
    const httpFetcher = vi.fn().mockResolvedValue({
      body: '<html><body><main>' + 'A'.repeat(800) + '</main></body></html>',
      contentType: 'text/html',
      finalUrl: 'https://example.com/post',
    });

    await ingestUrlSource('source-1', 'https://example.com/post', {
      httpFetcher,
      updateExtraction,
    });

    expect(updateExtraction).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 'source-1',
        extractionError: null,
        fetchStrategy: 'http',
        mimeType: 'text/html',
      }),
    );
  });

  it('ingests a Cloudflare-fronted page via HTTP — CF infra words / "just a moment" in prose are not a challenge', async () => {
    // Regression for the gamemakers.com report: a real 200 page whose body
    // merely mentions "cloudflare"/"captcha" (CF infra refs) or has "just a
    // moment" in prose must NOT be misread as a bot challenge. Only the CF
    // interstitial <title> markers do.
    const httpFetcher = vi.fn().mockResolvedValue({
      body:
        '<html><body><main>' +
        'Real article body content. Just a moment, here is the point. '.repeat(
          30,
        ) +
        '<footer>Protected by Cloudflare. Solve the captcha to comment.</footer>' +
        '</main></body></html>',
      contentType: 'text/html',
      finalUrl: 'https://www.gamemakers.com/p/post',
    });

    await ingestUrlSource('source-cf', 'https://www.gamemakers.com/p/post', {
      httpFetcher,
      updateExtraction,
    });

    expect(updateExtraction).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 'source-cf',
        extractionError: null,
        fetchStrategy: 'http',
      }),
    );
  });

  it('passes non-HTML content (plain text) through regardless of length', async () => {
    // The thin-content gate is HTML-only (a JS-shell concern); short plain-text
    // and PDF sources must still ingest.
    const httpFetcher = vi.fn().mockResolvedValue({
      body: 'short note',
      contentType: 'text/plain',
      finalUrl: 'https://example.com/notes.txt',
    });

    await ingestUrlSource('source-txt', 'https://example.com/notes.txt', {
      httpFetcher,
      updateExtraction,
    });

    expect(updateExtraction).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 'source-txt',
        extractedText: 'short note',
        extractionError: null,
        fetchStrategy: 'http',
      }),
    );
  });

  it('fails with an honest insufficient_content error for a thin JS shell (no chassis leak)', async () => {
    // The gamemakers.com publication HOME page: HTTP 200 with a JS body but
    // only a sliver of static text (a subscribe wall). With no browser
    // fallback, this must fail with an actionable message — never the internal
    // "browser disabled / chassis removed" leak.
    const httpFetcher = vi.fn().mockResolvedValue({
      body: '<html><body><main>Subscribe to GameMakers</main></body></html>',
      contentType: 'text/html',
      finalUrl: 'https://www.gamemakers.com/',
    });

    await ingestUrlSource('source-thin', 'https://www.gamemakers.com/', {
      httpFetcher,
      updateExtraction,
    });

    const payload = firstPayload();
    expect(payload.extractedText).toBeNull();
    expect(payload.fetchStrategy).toBe('http');
    expect(payload.extractionError).toContain('insufficient_content');
    expect(payload.extractionError).not.toContain('browser');
    expect(payload.extractionError).not.toContain('chassis');
  });

  it('fails with challenge_page for a genuine interstitial (no chassis leak)', async () => {
    const httpFetcher = vi.fn().mockResolvedValue({
      body:
        '<html><head><title>Just a moment...</title></head><body>' +
        '<p>Verify you are human by completing the action below.</p>' +
        '</body></html>',
      contentType: 'text/html',
      finalUrl: 'https://protected.example.com/',
    });

    await ingestUrlSource('source-chal', 'https://protected.example.com/', {
      httpFetcher,
      updateExtraction,
    });

    const payload = firstPayload();
    expect(payload.extractedText).toBeNull();
    expect(payload.extractionError).toContain('challenge_page');
    expect(payload.extractionError).not.toContain('browser');
    expect(payload.extractionError).not.toContain('chassis');
  });

  it('stores a failure carrying the HTTP error when the fetch fails (no chassis leak)', async () => {
    const httpFetcher = vi
      .fn()
      .mockRejectedValue(
        new SourceIngestionError(
          'fetch_http_error',
          'HTTP 429 from https://www.google.com/sorry/index',
        ),
      );

    await ingestUrlSource('source-429', 'https://google.com', {
      httpFetcher,
      updateExtraction,
    });

    const payload = firstPayload();
    expect(payload.extractedText).toBeNull();
    expect(payload.fetchStrategy).toBe('http');
    expect(payload.extractionError).toContain('fetch_http_error');
    expect(payload.extractionError).toContain('HTTP 429');
    expect(payload.extractionError).not.toContain('browser');
    expect(payload.extractionError).not.toContain('chassis');
  });

  it('rescues a thin HTML page by following its linked RSS feed', async () => {
    const page = {
      body:
        '<html><head>' +
        '<link rel="alternate" type="application/rss+xml" href="/feed" title="GameMakers"/>' +
        '</head><body><main>Subscribe to GameMakers</main></body></html>',
      contentType: 'text/html',
      finalUrl: 'https://www.gamemakers.com/',
    };
    const feed = {
      body:
        '<?xml version="1.0"?><rss><channel><title>GameMakers</title>' +
        '<item><title>The Last 20%</title><content:encoded><![CDATA[<p>' +
        'Real long-form article body. '.repeat(40) +
        '</p>]]></content:encoded></item></channel></rss>',
      contentType: 'application/xml',
      finalUrl: 'https://www.gamemakers.com/feed',
    };
    const httpFetcher = vi
      .fn()
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce(feed);

    await ingestUrlSource('source-feed', 'https://www.gamemakers.com/', {
      httpFetcher,
      updateExtraction,
    });

    // Direct extraction was thin -> followed the resolved feed URL.
    expect(httpFetcher).toHaveBeenCalledTimes(2);
    expect(httpFetcher.mock.calls[1][0]).toBe(
      'https://www.gamemakers.com/feed',
    );
    const payload = firstPayload();
    expect(payload.extractionError).toBeNull();
    expect(payload.fetchStrategy).toBe('http');
    expect(payload.extractedText).toContain('The Last 20%');
    expect(payload.extractedText).toContain('Real long-form article body');
    expect(payload.extractedText).not.toContain('content:encoded');
    expect(payload.extractedText).not.toContain('CDATA');
  });

  it('fails insufficient_content when a thin page declares no feed', async () => {
    const httpFetcher = vi.fn().mockResolvedValue({
      body: '<html><body><main>Subscribe to GameMakers</main></body></html>',
      contentType: 'text/html',
      finalUrl: 'https://www.gamemakers.com/',
    });

    await ingestUrlSource('source-nofeed', 'https://www.gamemakers.com/', {
      httpFetcher,
      updateExtraction,
    });

    expect(httpFetcher).toHaveBeenCalledTimes(1); // no feed sub-fetch
    const payload = firstPayload();
    expect(payload.extractedText).toBeNull();
    expect(payload.extractionError).toContain('insufficient_content');
  });

  it('fails insufficient_content when the linked feed yields no usable text', async () => {
    const page = {
      body:
        '<html><head>' +
        '<link rel="alternate" type="application/rss+xml" href="https://feeds.example.com/x"/>' +
        '</head><body><main>thin</main></body></html>',
      contentType: 'text/html',
      finalUrl: 'https://thin.example.com/',
    };
    const emptyFeed = {
      body: '<?xml version="1.0"?><rss><channel><title>Empty</title></channel></rss>',
      contentType: 'application/xml',
      finalUrl: 'https://feeds.example.com/x',
    };
    const httpFetcher = vi
      .fn()
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce(emptyFeed);

    await ingestUrlSource('source-emptyfeed', 'https://thin.example.com/', {
      httpFetcher,
      updateExtraction,
    });

    expect(httpFetcher).toHaveBeenCalledTimes(2);
    const payload = firstPayload();
    expect(payload.extractedText).toBeNull();
    expect(payload.extractionError).toContain('insufficient_content');
  });

  it('does not feed-rescue a thin non-index (article) URL', async () => {
    const httpFetcher = vi.fn().mockResolvedValue({
      body:
        '<html><head>' +
        '<link rel="alternate" type="application/rss+xml" href="/feed"/>' +
        '</head><body><main>thin shell</main></body></html>',
      contentType: 'text/html',
      finalUrl: 'https://www.gamemakers.com/p/old-post',
    });

    await ingestUrlSource(
      'source-leaf',
      'https://www.gamemakers.com/p/old-post',
      { httpFetcher, updateExtraction },
    );

    // A leaf URL must not pull the site feed's unrelated recent posts.
    expect(httpFetcher).toHaveBeenCalledTimes(1);
    const payload = firstPayload();
    expect(payload.extractedText).toBeNull();
    expect(payload.extractionError).toContain('insufficient_content');
  });

  it('does not feed-rescue when a leaf URL redirects to a root finalUrl', async () => {
    const httpFetcher = vi.fn().mockResolvedValue({
      body:
        '<html><head>' +
        '<link rel="alternate" type="application/rss+xml" href="/feed"/>' +
        '</head><body><main>thin</main></body></html>',
      contentType: 'text/html',
      finalUrl: 'https://blog.test/', // redirected to the homepage
    });

    await ingestUrlSource('source-redir', 'https://blog.test/p/old-post', {
      httpFetcher,
      updateExtraction,
    });

    // The user pasted a leaf URL; a redirect to root must not trigger rescue.
    expect(httpFetcher).toHaveBeenCalledTimes(1);
    const payload = firstPayload();
    expect(payload.extractedText).toBeNull();
    expect(payload.extractionError).toContain('insufficient_content');
  });

  it('does not feed-rescue a hash-routed (SPA) URL', async () => {
    const httpFetcher = vi.fn().mockResolvedValue({
      body:
        '<html><head>' +
        '<link rel="alternate" type="application/rss+xml" href="/feed"/>' +
        '</head><body><main>thin</main></body></html>',
      contentType: 'text/html',
      finalUrl: 'https://blog.test/#/p/old-post',
    });

    await ingestUrlSource('source-hash', 'https://blog.test/#/p/old-post', {
      httpFetcher,
      updateExtraction,
    });

    expect(httpFetcher).toHaveBeenCalledTimes(1);
    const payload = firstPayload();
    expect(payload.extractedText).toBeNull();
    expect(payload.extractionError).toContain('insufficient_content');
  });

  it('does not feed-rescue a root URL with a content-addressing query (?p=123)', async () => {
    const httpFetcher = vi.fn().mockResolvedValue({
      body:
        '<html><head>' +
        '<link rel="alternate" type="application/rss+xml" href="/feed"/>' +
        '</head><body><main>thin shell</main></body></html>',
      contentType: 'text/html',
      finalUrl: 'https://blog.test/?p=123',
    });

    await ingestUrlSource('source-querylf', 'https://blog.test/?p=123', {
      httpFetcher,
      updateExtraction,
    });

    // ?p=123 addresses a specific post — treat as a leaf, not an index.
    expect(httpFetcher).toHaveBeenCalledTimes(1);
    const payload = firstPayload();
    expect(payload.extractedText).toBeNull();
    expect(payload.extractionError).toContain('insufficient_content');
  });

  it('feed-rescues a root URL bearing only tracking query params', async () => {
    const page = {
      body:
        '<html><head>' +
        '<link rel="alternate" type="application/rss+xml" href="/feed"/>' +
        '</head><body><main>Subscribe</main></body></html>',
      contentType: 'text/html',
      finalUrl: 'https://blog.test/?utm_source=newsletter',
    };
    const feed = {
      body:
        '<?xml version="1.0"?><rss><channel><title>Blog</title>' +
        '<item><title>Recent Post</title><description>' +
        'Real article body content. '.repeat(40) +
        '</description></item></channel></rss>',
      contentType: 'application/xml',
      finalUrl: 'https://blog.test/feed',
    };
    const httpFetcher = vi
      .fn()
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce(feed);

    await ingestUrlSource(
      'source-utm',
      'https://blog.test/?utm_source=newsletter',
      { httpFetcher, updateExtraction },
    );

    // utm-only query is still index-like → rescue proceeds.
    expect(httpFetcher).toHaveBeenCalledTimes(2);
    const payload = firstPayload();
    expect(payload.extractionError).toBeNull();
    expect(payload.extractedText).toContain('Recent Post');
  });

  it('blocks an SSRF feed link (feed host resolves to a private IP)', async () => {
    // The feed URL comes from page HTML, so it MUST be re-validated by the same
    // SSRF gate. A feed link pointing at a private/metadata host is rejected,
    // degrading to the honest insufficient_content failure (not an SSRF).
    installFetch({
      doh: (type, name) =>
        type !== 'A'
          ? aRecords()
          : name === 'thin.example.com'
            ? aRecords('93.184.216.34')
            : aRecords('169.254.169.254'),
      page: () =>
        pageResponse({
          contentType: 'text/html',
          body:
            '<html><head>' +
            '<link rel="alternate" type="application/rss+xml" href="http://metadata.evil.test/feed"/>' +
            '</head><body><main>thin</main></body></html>',
        }),
    });

    await ingestUrlSource('source-ssrf-feed', 'https://thin.example.com/', {
      updateExtraction,
    });

    const payload = firstPayload();
    expect(payload.extractedText).toBeNull();
    expect(payload.extractionError).toContain('insufficient_content');
  });
});

describe('findFeedUrl', () => {
  it('resolves a relative RSS autodiscovery href against the page URL', () => {
    const html =
      '<head><link rel="alternate" type="application/rss+xml" href="/feed" title="X"/></head>';
    expect(findFeedUrl(html, 'https://www.gamemakers.com/')).toBe(
      'https://www.gamemakers.com/feed',
    );
  });

  it('finds an Atom feed with attributes in any order / single quotes', () => {
    const html =
      "<link type='application/atom+xml' rel='alternate' href='https://blog.test/atom.xml'>";
    expect(findFeedUrl(html, 'https://blog.test/')).toBe(
      'https://blog.test/atom.xml',
    );
  });

  it('ignores rel=alternate links that are not feeds (alternate languages)', () => {
    const html =
      '<link rel="alternate" hreflang="fr" type="text/html" href="/fr"/>';
    expect(findFeedUrl(html, 'https://site.test/')).toBeNull();
  });

  it('returns null when no feed link is present', () => {
    expect(
      findFeedUrl('<head><title>No feed</title></head>', 'https://x.test/'),
    ).toBeNull();
  });

  it('decodes HTML entities in the href before resolving', () => {
    const html =
      '<link rel="alternate" type="application/rss+xml" href="/feed?format=rss&amp;lang=en"/>';
    expect(findFeedUrl(html, 'https://blog.test/')).toBe(
      'https://blog.test/feed?format=rss&lang=en',
    );
  });
});

describe('extractTextFromFeed', () => {
  it('extracts item title + CDATA content from RSS, stripping tags', () => {
    const xml =
      '<rss><channel><title>Feed Name</title>' +
      '<item><title>Post One</title>' +
      '<content:encoded><![CDATA[<p>Hello <strong>world</strong> today</p>]]></content:encoded>' +
      '</item></channel></rss>';
    const text = extractTextFromFeed(xml);
    expect(text).toContain('Feed Name');
    expect(text).toContain('Post One');
    expect(text).toContain('Hello world today');
    expect(text).not.toContain('<p>');
    expect(text).not.toContain('<strong>');
    expect(text).not.toContain('content:encoded');
  });

  it('prefers content:encoded over description', () => {
    const xml =
      '<rss><channel><item><title>T</title>' +
      '<description>short summary</description>' +
      '<content:encoded><![CDATA[the full body]]></content:encoded>' +
      '</item></channel></rss>';
    const text = extractTextFromFeed(xml);
    expect(text).toContain('the full body');
    expect(text).not.toContain('short summary');
  });

  it('decodes an entity-encoded description', () => {
    const xml =
      '<rss><channel><item><title>T</title>' +
      '<description>&lt;p&gt;Body &amp; more.&lt;/p&gt;</description>' +
      '</item></channel></rss>';
    expect(extractTextFromFeed(xml)).toContain('Body & more.');
  });

  it('extracts Atom entries (title + content)', () => {
    const xml =
      '<feed><title>Atom Feed</title>' +
      '<entry><title>Entry One</title>' +
      '<content type="html">&lt;p&gt;Atom body text.&lt;/p&gt;</content>' +
      '</entry></feed>';
    const text = extractTextFromFeed(xml);
    expect(text).toContain('Atom Feed');
    expect(text).toContain('Entry One');
    expect(text).toContain('Atom body text.');
  });

  it('returns empty string when there are no items', () => {
    expect(
      extractTextFromFeed('<rss><channel><title>x</title></channel></rss>'),
    ).toBe('');
  });
});

describe('extractTextFromHtml', () => {
  it('extracts plain text from a normal HTML body', () => {
    const html =
      '<html><body><h1>Title</h1><p>First paragraph.</p><p>Second paragraph.</p></body></html>';
    const text = extractTextFromHtml(html);
    expect(text).toContain('Title');
    expect(text).toContain('First paragraph.');
    expect(text).toContain('Second paragraph.');
  });

  it('decodes HTML entities including &apos;', () => {
    const html = '<p>It&apos;s 5&#39;clock &amp; we&#39;re late.</p>';
    expect(extractTextFromHtml(html)).toBe("It's 5'clock & we're late.");
  });

  it('strips script and style blocks without leaking their contents', () => {
    const html =
      '<html><head><style>body { color: red; }</style><script>alert(1)</script></head><body><p>Body text.</p></body></html>';
    const text = extractTextFromHtml(html);
    expect(text).toContain('Body text.');
    expect(text).not.toContain('color: red');
    expect(text).not.toContain('alert(1)');
  });

  it('expands iframe srcdoc HTML so email-archive bodies are extracted', () => {
    // ConvertKit / Mailchimp archive pages wrap the real email body in
    // an iframe whose `srcdoc` attribute is HTML-encoded HTML. The
    // outer page only contributes a wrapper title; the body lives
    // inside the srcdoc value.
    const html = [
      '<html><body>',
      '<div class="email-archive">',
      '<h2>Outer wrapper title</h2>',
      "<iframe srcdoc='&lt;html&gt;&lt;body&gt;&lt;p&gt;Real email body paragraph.&lt;/p&gt;&lt;p&gt;Second body line.&lt;/p&gt;&lt;/body&gt;&lt;/html&gt;'></iframe>",
      '</div>',
      '</body></html>',
    ].join('');
    const text = extractTextFromHtml(html);
    expect(text).toContain('Outer wrapper title');
    expect(text).toContain('Real email body paragraph.');
    expect(text).toContain('Second body line.');
  });

  it('handles iframe srcdoc with no closing </iframe> tag', () => {
    const html =
      "<iframe srcdoc='&lt;p&gt;Body via self-closing iframe.&lt;/p&gt;'>";
    expect(extractTextFromHtml(html)).toContain(
      'Body via self-closing iframe.',
    );
  });

  it('handles iframe srcdoc with double-quoted attribute value', () => {
    const html =
      '<iframe srcdoc="&lt;p&gt;Body via double-quoted srcdoc.&lt;/p&gt;"></iframe>';
    expect(extractTextFromHtml(html)).toContain(
      'Body via double-quoted srcdoc.',
    );
  });

  it('strips scripts/styles that live inside an expanded srcdoc', () => {
    // After srcdoc inlining the decoded HTML re-enters the pipeline, so
    // its scripts and styles should also be removed.
    const html =
      "<iframe srcdoc='&lt;style&gt;a{}&lt;/style&gt;&lt;script&gt;alert(2)&lt;/script&gt;&lt;p&gt;Visible body.&lt;/p&gt;'></iframe>";
    const text = extractTextFromHtml(html);
    expect(text).toContain('Visible body.');
    expect(text).not.toContain('alert(2)');
    expect(text).not.toContain('a{}');
  });
});

// ---------------------------------------------------------------------------
// SSRF gate + Workers-native fetch (safeFetchUrl / isBlockedIp). The global
// `fetch` is stubbed to route DoH queries vs. page fetches; nothing hits the
// network. NOTE: vitest runs on Node (pool: forks), not workerd, so these pin
// the LOGIC — the real-runtime behavior was confirmed via a wrangler-dev probe.
// ---------------------------------------------------------------------------

const MB = 1024 * 1024;

function dohResponse(answers: Array<{ type: number; data: string }>): unknown {
  return { ok: true, status: 200, json: async () => ({ Answer: answers }) };
}

function pageResponse(input: {
  status?: number;
  contentType?: string;
  location?: string;
  body?: string;
  bodyChunks?: Uint8Array[];
}): unknown {
  const headers: Record<string, string> = {};
  if (input.contentType) headers['content-type'] = input.contentType;
  if (input.location) headers['location'] = input.location;
  const status = input.status ?? 200;
  const chunks = input.bodyChunks ?? [
    new TextEncoder().encode(input.body ?? ''),
  ];
  let index = 0;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    body: {
      getReader: () => ({
        read: async () =>
          index < chunks.length
            ? { done: false, value: chunks[index++] }
            : { done: true, value: undefined },
        cancel: async () => undefined,
      }),
      cancel: async () => undefined,
    },
  };
}

function installFetch(opts: {
  doh?: (type: string, name: string) => unknown;
  page?: (url: string) => unknown;
}): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.startsWith('https://doh.test/')) {
      const parsed = new URL(u);
      return (opts.doh?.(
        parsed.searchParams.get('type') ?? 'A',
        parsed.searchParams.get('name') ?? '',
      ) ?? dohResponse([])) as Response;
    }
    return (opts.page?.(u) ?? pageResponse({ status: 200 })) as Response;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const aRecords = (...ips: string[]) =>
  dohResponse(ips.map((data) => ({ type: 1, data })));

describe('source-ingestion SSRF gate', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('isBlockedIp', () => {
    it('blocks private / loopback / link-local / multicast IPv4', () => {
      for (const ip of [
        '127.0.0.1',
        '10.1.2.3',
        '172.16.0.1',
        '172.31.255.255',
        '192.168.1.1',
        '169.254.169.254',
        '224.0.0.1',
        '0.0.0.0',
      ]) {
        expect(isBlockedIp(ip)).toBe(true);
      }
    });

    it('allows public IPv4, including just outside 172.16/12', () => {
      for (const ip of [
        '8.8.8.8',
        '1.1.1.1',
        '93.184.216.34',
        '104.18.36.24',
        '172.64.151.232',
        '172.15.0.1',
        '172.32.0.1',
      ]) {
        expect(isBlockedIp(ip)).toBe(false);
      }
    });

    it('blocks IPv6 loopback / ULA / link-local / multicast + mapped forms', () => {
      for (const ip of [
        '::1',
        '::',
        'fe80::1',
        'fc00::1',
        'fd12::1',
        'ff02::1',
        '::ffff:127.0.0.1',
        '::ffff:169.254.169.254',
        '::ffff:7f00:1', // hex-form mapped 127.0.0.1 must not bypass
        '0:0:0:0:0:ffff:7f00:1', // expanded mapped 127.0.0.1 must not bypass
        '::01', // non-canonical loopback
        '0000:0000:0000:0000:0000:0000:0000:0001', // expanded loopback
        'fe9a::1', // fe80::/10 link-local (not only the fe80 prefix)
      ]) {
        expect(isBlockedIp(ip)).toBe(true);
      }
    });

    it('allows public IPv6 and blocks non-IP input (fail-closed)', () => {
      expect(isBlockedIp('2001:4860:4860::8888')).toBe(false);
      expect(isBlockedIp('target.substack-custom-domains.com.')).toBe(true);
      expect(isBlockedIp('not-an-ip')).toBe(true);
    });
  });

  describe('safeFetchUrl', () => {
    it('fetches a host that resolves to a public IP', async () => {
      const fetchMock = installFetch({
        doh: (type) => (type === 'A' ? aRecords('93.184.216.34') : aRecords()),
        page: () =>
          pageResponse({ contentType: 'text/html', body: '<p>hi</p>' }),
      });
      const result = await safeFetchUrl('https://example.com/post');
      expect(result).toEqual({
        body: '<p>hi</p>',
        contentType: 'text/html',
        finalUrl: 'https://example.com/post',
      });
      expect(fetchMock).toHaveBeenCalled();
    });

    it('allows a CNAME-fronted host whose terminal A records are public', async () => {
      installFetch({
        doh: (type) =>
          type === 'A'
            ? dohResponse([
                { type: 5, data: 'target.substack-custom-domains.com.' },
                { type: 1, data: '104.18.36.24' },
                { type: 1, data: '172.64.151.232' },
              ])
            : aRecords(),
        page: () =>
          pageResponse({ contentType: 'text/html', body: '<p>post</p>' }),
      });
      const result = await safeFetchUrl('https://www.gamemakers.com/');
      expect(result.body).toBe('<p>post</p>');
    });

    it('blocks a host that resolves to a private IP', async () => {
      installFetch({
        doh: (type) =>
          type === 'A' ? aRecords('169.254.169.254') : aRecords(),
      });
      await expect(safeFetchUrl('https://evil.test/')).rejects.toMatchObject({
        code: 'ssrf_blocked',
      });
    });

    it('blocks localhost without any fetch', async () => {
      const fetchMock = installFetch({});
      await expect(safeFetchUrl('http://localhost/')).rejects.toMatchObject({
        code: 'ssrf_blocked',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('blocks a trailing-dot localhost without any fetch', async () => {
      const fetchMock = installFetch({});
      await expect(safeFetchUrl('http://localhost./')).rejects.toMatchObject({
        code: 'ssrf_blocked',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('blocks an IP-literal host in a private range without a DNS lookup', async () => {
      const fetchMock = installFetch({});
      await expect(safeFetchUrl('http://10.0.0.1/')).rejects.toMatchObject({
        code: 'ssrf_blocked',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('fails closed when DoH returns an error', async () => {
      installFetch({
        doh: () => ({ ok: false, status: 502, json: async () => ({}) }),
      });
      await expect(safeFetchUrl('https://example.com/')).rejects.toMatchObject({
        code: 'dns_resolution_failed',
      });
    });

    it('fails closed when DoH returns malformed JSON', async () => {
      installFetch({
        doh: () => ({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError('Unexpected token < in JSON');
          },
        }),
      });
      await expect(safeFetchUrl('https://example.com/')).rejects.toMatchObject({
        code: 'dns_resolution_failed',
      });
    });

    it('re-validates each redirect hop and blocks a redirect to a private host', async () => {
      installFetch({
        doh: (type, name) =>
          type !== 'A'
            ? aRecords()
            : name === 'first.test'
              ? aRecords('93.184.216.34')
              : aRecords('10.0.0.5'),
        page: (url) =>
          url.includes('first.test')
            ? pageResponse({ status: 301, location: 'https://second.test/' })
            : pageResponse({ contentType: 'text/html', body: 'x' }),
      });
      await expect(safeFetchUrl('https://first.test/')).rejects.toMatchObject({
        code: 'ssrf_blocked',
      });
    });

    it('throws too_many_redirects past the limit', async () => {
      installFetch({
        doh: (type) => (type === 'A' ? aRecords('93.184.216.34') : aRecords()),
        page: () =>
          pageResponse({ status: 301, location: 'https://loop.test/next' }),
      });
      await expect(safeFetchUrl('https://loop.test/')).rejects.toMatchObject({
        code: 'too_many_redirects',
      });
    });

    it('rejects an oversized body', async () => {
      const oneMb = new Uint8Array(MB);
      installFetch({
        doh: (type) => (type === 'A' ? aRecords('93.184.216.34') : aRecords()),
        page: () =>
          pageResponse({
            contentType: 'text/html',
            bodyChunks: Array.from({ length: 11 }, () => oneMb),
          }),
      });
      await expect(safeFetchUrl('https://big.test/')).rejects.toMatchObject({
        code: 'response_too_large',
      });
    });

    it('maps an aborted fetch to fetch_timeout', async () => {
      installFetch({
        doh: (type) => (type === 'A' ? aRecords('93.184.216.34') : aRecords()),
        page: () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        },
      });
      await expect(safeFetchUrl('https://slow.test/')).rejects.toMatchObject({
        code: 'fetch_timeout',
      });
    });

    it('rejects a disallowed content type', async () => {
      installFetch({
        doh: (type) => (type === 'A' ? aRecords('93.184.216.34') : aRecords()),
        page: () =>
          pageResponse({ contentType: 'application/json', body: '{}' }),
      });
      await expect(safeFetchUrl('https://api.test/')).rejects.toMatchObject({
        code: 'unsupported_content_type',
      });
    });

    it('rejects a disallowed scheme without any fetch', async () => {
      const fetchMock = installFetch({});
      await expect(safeFetchUrl('ftp://example.com/')).rejects.toMatchObject({
        code: 'invalid_scheme',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
