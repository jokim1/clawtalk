import { Fragment, type ReactNode } from 'react';

const URL_RE = /(https?:\/\/[^\s<>"']+)/g;
const TRAILING_PUNCT_RE = /[.,;:!?)\]}'"]+$/;

export function linkifyText(text: string): ReactNode {
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let linkCount = 0;
  URL_RE.lastIndex = 0;
  while ((match = URL_RE.exec(text)) !== null) {
    const raw = match[0];
    const trailMatch = TRAILING_PUNCT_RE.exec(raw);
    const trailing = trailMatch ? trailMatch[0] : '';
    const url = trailing ? raw.slice(0, raw.length - trailing.length) : raw;
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    parts.push(
      <a
        key={`linkify-${linkCount++}-${match.index}`}
        href={url}
        target="_blank"
        rel="noreferrer noopener"
      >
        {url}
      </a>,
    );
    if (trailing) parts.push(trailing);
    lastIndex = match.index + raw.length;
  }
  if (parts.length === 0) return text;
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return <Fragment>{parts}</Fragment>;
}
