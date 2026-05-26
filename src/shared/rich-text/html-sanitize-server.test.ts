// Tests for the shared server-side HTML sanitizer.
//
// Storage truth must be sanitized — these tests assert that the
// blocked-tag list, scheme list, and event-handler scrub all hold.
// Anything that survives this pass is what gets persisted, so each
// failure mode listed in the plan gets a regression test here.

import { describe, expect, it } from 'vitest';

import { sanitizeHtmlServer } from './html-sanitize-server.js';

describe('sanitizeHtmlServer', () => {
  it('strips <script> tags and reports them', () => {
    const result = sanitizeHtmlServer(
      '<p>hi</p><script>alert(1)</script><script>boom()</script>',
    );
    expect(result.clean).not.toContain('<script');
    expect(result.clean).not.toContain('alert');
    expect(result.stripped).toContainEqual({ tag: 'script', count: 2 });
  });

  it('strips <iframe>, <form>, <object>, <embed>', () => {
    const result = sanitizeHtmlServer(
      '<iframe src="x"></iframe><form><input/></form><object></object><embed/>',
    );
    expect(result.clean).not.toContain('iframe');
    expect(result.clean).not.toContain('<form');
    expect(result.clean).not.toContain('object');
    expect(result.clean).not.toContain('embed');
  });

  it('strips inline event handlers (onclick / onerror)', () => {
    const result = sanitizeHtmlServer(
      '<p onclick="alert(1)">hello</p><img src="x" onerror="alert(2)"/>',
    );
    expect(result.clean).not.toContain('onclick');
    expect(result.clean).not.toContain('onerror');
    expect(result.clean).toContain('hello');
  });

  it('rejects javascript: in href but allows http/https/mailto/tel', () => {
    const result = sanitizeHtmlServer(
      [
        '<a href="javascript:alert(1)">bad</a>',
        '<a href="https://example.com">ok</a>',
        '<a href="mailto:hi@example.com">m</a>',
        '<a href="tel:+1">t</a>',
      ].join(''),
    );
    expect(result.clean).not.toContain('javascript:');
    expect(result.clean).toContain('https://example.com');
    expect(result.clean).toContain('mailto:hi@example.com');
    expect(result.clean).toContain('tel:+1');
  });

  it('forces rel="noopener noreferrer" on <a> tags', () => {
    const result = sanitizeHtmlServer(
      '<a href="https://example.com" target="_blank">x</a>',
    );
    expect(result.clean).toContain('noopener');
    expect(result.clean).toContain('noreferrer');
  });

  it('preserves <style> tags + CSS @keyframes', () => {
    const css = '@keyframes fade { from { opacity: 0 } to { opacity: 1 } }';
    const result = sanitizeHtmlServer(
      `<style>${css}</style><p class="fade">hi</p>`,
    );
    expect(result.clean).toContain('<style');
    expect(result.clean).toContain('@keyframes');
    expect(result.clean).toContain('fade');
  });

  it('preserves the SVG subset (circle, rect, path, gradients)', () => {
    const svg = [
      '<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg">',
      '<defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs>',
      '<rect x="0" y="0" width="10" height="10" fill="url(#g)"/>',
      '<circle cx="5" cy="5" r="2"/>',
      '<path d="M0 0 L10 10"/>',
      '</svg>',
    ].join('');
    const result = sanitizeHtmlServer(svg);
    expect(result.clean).toContain('<svg');
    expect(result.clean).toContain('<rect');
    expect(result.clean).toContain('<circle');
    expect(result.clean).toContain('<path');
    expect(result.clean).toContain('linearGradient');
    expect(result.clean).toContain('<stop');
  });

  it('strips SVG escape vectors: foreignObject, animate, feImage', () => {
    const svg = [
      '<svg>',
      '<foreignObject><iframe src="x"></iframe></foreignObject>',
      '<animate attributeName="x" from="0" to="100"/>',
      '<animateMotion path="M0 0"/>',
      '<animateTransform/>',
      '<set/>',
      '<feImage href="javascript:alert(1)"/>',
      '</svg>',
    ].join('');
    const result = sanitizeHtmlServer(svg);
    expect(result.clean).not.toContain('foreignObject');
    expect(result.clean).not.toContain('<animate');
    expect(result.clean).not.toContain('<animateMotion');
    expect(result.clean).not.toContain('<animateTransform');
    expect(result.clean).not.toContain('<set');
    expect(result.clean).not.toContain('feImage');
  });

  it('preserves data-anchor-id on block elements', () => {
    const result = sanitizeHtmlServer(
      '<p data-anchor-id="anchor-1">hi</p><h2 data-anchor-id="anchor-2">title</h2>',
    );
    expect(result.clean).toContain('data-anchor-id="anchor-1"');
    expect(result.clean).toContain('data-anchor-id="anchor-2"');
  });

  it('preserves the rocketboard baseline tag set', () => {
    const html = [
      '<h1>h</h1><h2>h</h2><h3>h</h3><h4>h</h4><h5>h</h5><h6>h</h6>',
      '<p>p</p><blockquote>q</blockquote><pre><code>c</code></pre>',
      '<em>e</em><strong>s</strong><b>b</b><i>i</i><u>u</u><s>x</s>',
      '<sub>2</sub><sup>3</sup><mark>m</mark><small>s</small>',
      '<ul><li>a</li></ul><ol><li>b</li></ol><dl><dt>d</dt><dd>d</dd></dl>',
      '<table><thead><tr><th>h</th></tr></thead><tbody><tr><td>c</td></tr></tbody></table>',
      '<img src="https://example.com/x.png" alt="x"/>',
      '<a href="https://example.com">l</a>',
      '<br/><hr/>',
    ].join('');
    const result = sanitizeHtmlServer(html);
    for (const tag of [
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'p',
      'blockquote',
      'pre',
      'code',
      'em',
      'strong',
      'b',
      'i',
      'u',
      's',
      'sub',
      'sup',
      'mark',
      'small',
      'ul',
      'li',
      'ol',
      'dl',
      'dt',
      'dd',
      'table',
      'thead',
      'tr',
      'th',
      'tbody',
      'td',
      'img',
      'a',
      'br',
      'hr',
    ]) {
      expect(result.clean.includes(`<${tag}`)).toBe(true);
    }
    expect(result.stripped).toHaveLength(0);
  });

  it('returns clean="" and no stripped report for non-string input', () => {
    // Defensive: in case a caller hands the wrapper a non-string.
    // We treat it as empty rather than throwing.
    const result = sanitizeHtmlServer(undefined as unknown as string);
    expect(result.clean).toBe('');
    expect(result.stripped).toEqual([]);
  });

  it('returns clean="" for empty input without inventing stripped tags', () => {
    const result = sanitizeHtmlServer('');
    expect(result.clean).toBe('');
    expect(result.stripped).toEqual([]);
  });

  it('reports counts for repeated stripped tags', () => {
    const html =
      '<p>ok</p><iframe></iframe><iframe></iframe><script>1</script>';
    const result = sanitizeHtmlServer(html);
    expect(result.stripped).toContainEqual({ tag: 'iframe', count: 2 });
    expect(result.stripped).toContainEqual({ tag: 'script', count: 1 });
  });

  it('strips srcdoc and formaction attributes', () => {
    const result = sanitizeHtmlServer(
      // formaction would only matter on a <button>/<input> which we
      // already strip; srcdoc on an iframe likewise. Use them on a
      // <p> to validate the attribute-level filter independently.
      '<p formaction="evil" srcdoc="x">hi</p>',
    );
    expect(result.clean).not.toContain('formaction');
    expect(result.clean).not.toContain('srcdoc');
  });
});
