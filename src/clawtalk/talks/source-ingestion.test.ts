import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', () => ({
  TALK_CONTEXT_BROWSER_DISABLE_HOSTS: [],
  TALK_CONTEXT_BROWSER_PREFER_HOSTS: ['substack.com'],
  TALK_CONTEXT_BROWSER_TIMEOUT_MS: 30_000,
  TALK_CONTEXT_MANAGED_FETCH_ENABLED: false,
  TALK_CONTEXT_MANAGED_FETCH_TIMEOUT_MS: 30_000,
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
  extractTextFromHtml,
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

  it('stores HTTP extraction when the fast path is good enough', async () => {
    const httpFetcher = vi.fn().mockResolvedValue({
      body: '<html><body><main>' + 'A'.repeat(800) + '</main></body></html>',
      contentType: 'text/html',
      finalUrl: 'https://example.com/post',
    });
    const browserFetcher = {
      fetch: vi.fn(),
    };

    await ingestUrlSource('source-1', 'https://example.com/post', {
      httpFetcher,
      browserFetcher,
      updateExtraction,
    });

    expect(browserFetcher.fetch).not.toHaveBeenCalled();
    expect(updateExtraction).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 'source-1',
        extractionError: null,
        fetchStrategy: 'http',
        mimeType: 'text/html',
      }),
    );
  });

  it('prefers the browser path for Substack URLs even after HTTP success', async () => {
    const httpFetcher = vi.fn().mockResolvedValue({
      body:
        '<html><body><article>' + 'B'.repeat(1200) + '</article></body></html>',
      contentType: 'text/html',
      finalUrl: 'https://example.substack.com/p/test-post',
    });
    const browserFetcher = {
      fetch: vi.fn().mockResolvedValue({
        finalUrl: 'https://example.substack.com/p/test-post',
        pageTitle: 'Substack Post',
        extractedText: 'Browser extracted article body',
        contentType: 'text/html' as const,
        strategy: 'browser' as const,
      }),
    };

    await ingestUrlSource(
      'source-2',
      'https://example.substack.com/p/test-post',
      {
        httpFetcher,
        browserFetcher,
        updateExtraction,
      },
    );

    expect(browserFetcher.fetch).toHaveBeenCalledTimes(1);
    expect(updateExtraction).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 'source-2',
        extractionError: null,
        fetchStrategy: 'browser',
      }),
    );
  });

  it('falls back to the browser path after HTTP fetch failures', async () => {
    const httpFetcher = vi
      .fn()
      .mockRejectedValue(
        new SourceIngestionError(
          'fetch_http_error',
          'HTTP 403 from https://example.com/article',
        ),
      );
    const browserFetcher = {
      fetch: vi.fn().mockResolvedValue({
        finalUrl: 'https://example.com/article',
        pageTitle: 'Recovered',
        extractedText: 'Recovered in browser',
        contentType: 'text/html' as const,
        strategy: 'browser' as const,
      }),
    };

    await ingestUrlSource('source-3', 'https://example.com/article', {
      httpFetcher,
      browserFetcher,
      updateExtraction,
    });

    expect(browserFetcher.fetch).toHaveBeenCalledTimes(1);
    expect(updateExtraction).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 'source-3',
        extractionError: null,
        fetchStrategy: 'browser',
      }),
    );
  });

  it('keeps useful HTTP content when browser fallback fails', async () => {
    const httpFetcher = vi.fn().mockResolvedValue({
      body:
        '<html><body><article>' + 'C'.repeat(1200) + '</article></body></html>',
      contentType: 'text/html',
      finalUrl: 'https://example.substack.com/p/fallback',
    });
    const browserFetcher = {
      fetch: vi
        .fn()
        .mockRejectedValue(new Error('Browser container unavailable')),
    };

    await ingestUrlSource(
      'source-4',
      'https://example.substack.com/p/fallback',
      {
        httpFetcher,
        browserFetcher,
        updateExtraction,
      },
    );

    expect(browserFetcher.fetch).toHaveBeenCalledTimes(1);
    expect(updateExtraction).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 'source-4',
        extractionError: null,
        fetchStrategy: 'http',
      }),
    );
  });

  it('stores a failure when all ingestion tiers fail', async () => {
    const httpFetcher = vi
      .fn()
      .mockRejectedValue(
        new SourceIngestionError('fetch_error', 'Network down'),
      );
    const browserFetcher = {
      fetch: vi.fn().mockRejectedValue(new Error('Browser failed')),
    };

    await ingestUrlSource('source-5', 'https://example.com/post', {
      httpFetcher,
      browserFetcher,
      updateExtraction,
    });

    expect(updateExtraction).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 'source-5',
        extractedText: null,
        fetchStrategy: 'browser',
      }),
    );
    const payload = updateExtraction.mock.calls[0][0] as {
      extractionError: string;
    };
    expect(payload.extractionError).toContain(
      'http: fetch_error: Network down',
    );
    expect(payload.extractionError).toContain('browser: Browser failed');
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
