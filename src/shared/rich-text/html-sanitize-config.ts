// Shared allowlist for the HTML content format. Read by both the
// browser DOMPurify call site (webapp, ships in lane A2/A3) and the
// server `sanitize-html` wrapper in the same directory — single source
// of truth so the two sanitizers can't drift.
//
// Scope: rocketboard's SafeHtml baseline + the additions called out in
// plan `good-pushback-having-said-virtual-harbor.md`:
//   - `<style>` (scoped CSS + @keyframes)
//   - `style` attribute (allowed via per-tag map)
//   - sanitized SVG subset (shapes / text / gradients / use)
//   - data-anchor-id on every block (server-managed in PR B; allow now)
//
// Explicit denies for SVG escape vectors and form/iframe surfaces stay
// in DENIED_TAGS even though most libraries strip them by default —
// the explicit list is the durable record.

// ── Allowed tags (~75) ──────────────────────────────────────────────
export const ALLOWED_TAGS: readonly string[] = [
  // structural / sectioning
  'div',
  'span',
  'section',
  'article',
  'aside',
  'header',
  'footer',
  'main',
  'nav',
  'figure',
  'figcaption',
  'details',
  'summary',
  // typography
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
  'kbd',
  'samp',
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
  'q',
  'cite',
  'br',
  'hr',
  // lists
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  // tables
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'caption',
  'colgroup',
  'col',
  // media (safe — no JS-bearing surfaces)
  'img',
  'picture',
  'source',
  // links
  'a',
  // scoped styling
  'style',
  // SVG subset (geometry / text / gradients / reuse)
  'svg',
  'g',
  'defs',
  'symbol',
  'use',
  'circle',
  'rect',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'path',
  'text',
  'tspan',
  'linearGradient',
  'radialGradient',
  'stop',
  'title',
  'desc',
];

// ── Explicit denylist (overrides defaults; defense-in-depth) ────────
export const DENIED_TAGS: readonly string[] = [
  'script',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'option',
  'label',
  'meta',
  'link',
  'base',
  // SVG escape vectors — pulled from the plan rationale
  'foreignObject',
  'animate',
  'animateMotion',
  'animateTransform',
  'set',
  'feImage',
];

// ── Per-tag attribute allowlist ─────────────────────────────────────
// '*' applies to every allowed tag. Per-tag entries are additive.
// data-anchor-id is global because anchor IDs sit on any block.
export const ALLOWED_ATTRS: Readonly<Record<string, readonly string[]>> = {
  '*': [
    'id',
    'class',
    'style',
    'title',
    'lang',
    'dir',
    'role',
    'data-anchor-id',
    // ARIA passthrough — common interactive labels (no event handlers).
    'aria-label',
    'aria-labelledby',
    'aria-describedby',
    'aria-hidden',
    'aria-expanded',
    'aria-controls',
    'aria-current',
    'aria-disabled',
    'aria-level',
    'aria-pressed',
    'aria-selected',
  ],
  a: ['href', 'target', 'rel'],
  img: ['src', 'srcset', 'alt', 'width', 'height', 'loading'],
  picture: [],
  source: ['src', 'srcset', 'sizes', 'type', 'media'],
  table: ['border', 'cellpadding', 'cellspacing'],
  th: ['colspan', 'rowspan', 'scope', 'abbr'],
  td: ['colspan', 'rowspan', 'headers'],
  col: ['span'],
  colgroup: ['span'],
  details: ['open'],
  ol: ['start', 'reversed', 'type'],
  li: ['value'],
  q: ['cite'],
  blockquote: ['cite'],
  time: ['datetime'],
  style: ['type', 'media'],
  // SVG — broad geometry/styling allowlist, no script-bearing attrs.
  svg: [
    'xmlns',
    'xmlns:xlink',
    'viewBox',
    'width',
    'height',
    'preserveAspectRatio',
    'fill',
    'stroke',
    'stroke-width',
    'stroke-linecap',
    'stroke-linejoin',
    'stroke-dasharray',
    'stroke-opacity',
    'fill-opacity',
    'fill-rule',
    'clip-rule',
    'opacity',
    'transform',
  ],
  g: [
    'fill',
    'stroke',
    'stroke-width',
    'opacity',
    'transform',
    'clip-path',
    'mask',
  ],
  defs: [],
  symbol: ['viewBox', 'preserveAspectRatio'],
  use: ['href', 'x', 'y', 'width', 'height'],
  circle: ['cx', 'cy', 'r', 'fill', 'stroke', 'stroke-width', 'transform'],
  rect: [
    'x',
    'y',
    'width',
    'height',
    'rx',
    'ry',
    'fill',
    'stroke',
    'stroke-width',
    'transform',
  ],
  ellipse: [
    'cx',
    'cy',
    'rx',
    'ry',
    'fill',
    'stroke',
    'stroke-width',
    'transform',
  ],
  line: ['x1', 'y1', 'x2', 'y2', 'stroke', 'stroke-width', 'transform'],
  polyline: ['points', 'fill', 'stroke', 'stroke-width', 'transform'],
  polygon: ['points', 'fill', 'stroke', 'stroke-width', 'transform'],
  path: ['d', 'fill', 'stroke', 'stroke-width', 'fill-rule', 'transform'],
  text: [
    'x',
    'y',
    'dx',
    'dy',
    'rotate',
    'text-anchor',
    'font-family',
    'font-size',
    'font-weight',
    'fill',
    'transform',
  ],
  tspan: [
    'x',
    'y',
    'dx',
    'dy',
    'rotate',
    'text-anchor',
    'font-family',
    'font-size',
    'font-weight',
    'fill',
  ],
  linearGradient: [
    'gradientUnits',
    'gradientTransform',
    'x1',
    'y1',
    'x2',
    'y2',
    'spreadMethod',
  ],
  radialGradient: [
    'gradientUnits',
    'gradientTransform',
    'cx',
    'cy',
    'r',
    'fx',
    'fy',
    'spreadMethod',
  ],
  stop: ['offset', 'stop-color', 'stop-opacity'],
};

// ── Global attribute denylist ───────────────────────────────────────
// Event handlers (on*) are blocked by prefix. Listing concrete deniers
// keeps the rule legible at the call site even if libs handle on* via
// defaults. `formaction`, `srcdoc`, and `xlink:href` are explicit
// escape vectors.
export const DENIED_ATTRS: readonly string[] = [
  'formaction',
  'srcdoc',
  'xlink:href',
];

export const DENIED_ATTR_PREFIXES: readonly string[] = ['on'];

// ── URL scheme allowlist ────────────────────────────────────────────
// `data:` is allowed for inline images (DOMPurify and sanitize-html
// both let us scope this per-tag). `javascript:` is implicitly denied.
export const ALLOWED_URL_SCHEMES: readonly string[] = [
  'http',
  'https',
  'mailto',
  'tel',
  'data',
];
