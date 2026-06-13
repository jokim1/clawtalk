import type { ReactNode } from 'react';

const INLINE_RE =
  /(\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\))|(\*\*([^*\n]+)\*\*)|(\*([^*\n]+)\*)|(https?:\/\/[^\s<]+)/g;

function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(INLINE_RE)) {
    const index = match.index ?? 0;
    if (index > cursor) nodes.push(text.slice(cursor, index));

    if (match[2] && match[3]) {
      const href = safeHttpUrl(match[3]);
      nodes.push(
        href ? (
          <a
            key={`${keyPrefix}-a-${index}`}
            href={href}
            target="_blank"
            rel="noreferrer"
          >
            {match[2]}
          </a>
        ) : (
          match[0]
        ),
      );
    } else if (match[5]) {
      // Recurse so inline links/URLs inside bold (e.g. `**[t](url)**`) are
      // parsed instead of emitted as raw text. The bold delimiter forbids a
      // nested `*`, so recursion only ever picks up links and bare URLs.
      nodes.push(
        <strong key={`${keyPrefix}-b-${index}`}>
          {renderInline(match[5], `${keyPrefix}-b-${index}`)}
        </strong>,
      );
    } else if (match[7]) {
      nodes.push(
        <em key={`${keyPrefix}-i-${index}`}>
          {renderInline(match[7], `${keyPrefix}-i-${index}`)}
        </em>,
      );
    } else if (match[8]) {
      const href = safeHttpUrl(match[8]);
      nodes.push(
        href ? (
          <a
            key={`${keyPrefix}-u-${index}`}
            href={href}
            target="_blank"
            rel="noreferrer"
          >
            {match[8]}
          </a>
        ) : (
          match[8]
        ),
      );
    }
    cursor = index + match[0].length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function renderTextWithBreaks(text: string, keyPrefix: string): ReactNode[] {
  return text.split('\n').flatMap((line, index, lines) => {
    const nodes = renderInline(line, `${keyPrefix}-${index}`);
    return index < lines.length - 1
      ? [...nodes, <br key={`${keyPrefix}-br-${index}`} />]
      : nodes;
  });
}

function orderedListItems(lines: string[]): string[] | null {
  const items = lines
    .map((line) => line.match(/^\s*\d+[.)]\s+(.+)$/)?.[1] ?? null)
    .filter((line): line is string => line !== null);
  return items.length === lines.length ? items : null;
}

function unorderedListItems(lines: string[]): string[] | null {
  const items = lines
    .map((line) => line.match(/^\s*[-*]\s+(.+)$/)?.[1] ?? null)
    .filter((line): line is string => line !== null);
  return items.length === lines.length ? items : null;
}

export function renderMarkdown(
  markdown: string,
  options: { className?: string } = {},
): ReactNode {
  const blocks = markdown
    .replace(/\r\n?/g, '\n')
    .trim()
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  if (blocks.length === 0) return null;

  return blocks.map((block, blockIndex) => {
    const lines = block.split('\n').filter((line) => line.trim().length > 0);
    const ordered = orderedListItems(lines);
    if (ordered) {
      return (
        <ol key={`md-ol-${blockIndex}`} className={options.className}>
          {ordered.map((item, itemIndex) => (
            <li key={`md-ol-${blockIndex}-${itemIndex}`}>
              {renderInline(item, `md-ol-${blockIndex}-${itemIndex}`)}
            </li>
          ))}
        </ol>
      );
    }

    const unordered = unorderedListItems(lines);
    if (unordered) {
      return (
        <ul key={`md-ul-${blockIndex}`} className={options.className}>
          {unordered.map((item, itemIndex) => (
            <li key={`md-ul-${blockIndex}-${itemIndex}`}>
              {renderInline(item, `md-ul-${blockIndex}-${itemIndex}`)}
            </li>
          ))}
        </ul>
      );
    }

    return (
      <p key={`md-p-${blockIndex}`} className={options.className}>
        {renderTextWithBreaks(block, `md-p-${blockIndex}`)}
      </p>
    );
  });
}
