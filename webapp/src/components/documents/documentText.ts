import type {
  NativeDocumentBlock,
  NativeDocumentBlockKind,
} from '../../lib/api';

export type DocumentDisplayBlockKind = NativeDocumentBlockKind;

export interface ParsedDocumentDisplayBlock {
  kind: DocumentDisplayBlockKind;
  text: string;
}

const ENTITY_MAP: Record<string, string> = {
  amp: '&',
  gt: '>',
  lt: '<',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body) => {
    const normalized = body.toLowerCase();
    if (normalized.startsWith('#x')) {
      const code = Number.parseInt(normalized.slice(2), 16);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    if (normalized.startsWith('#')) {
      const code = Number.parseInt(normalized.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return ENTITY_MAP[normalized] ?? match;
  });
}

function looksLikeHtml(input: string): boolean {
  return /<\/?[a-z][\s\S]*>/i.test(input);
}

function htmlFragmentToMarkdownish(input: string): string {
  return decodeHtmlEntities(input)
    .replace(/<!--[\s\S]*?-->/g, '\n\n')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*h1\b[^>]*>/gi, '\n\n# ')
    .replace(/<\s*\/h1\s*>/gi, '\n\n')
    .replace(/<\s*h2\b[^>]*>/gi, '\n\n## ')
    .replace(/<\s*\/h2\s*>/gi, '\n\n')
    .replace(/<\s*h[3-6]\b[^>]*>/gi, '\n\n## ')
    .replace(/<\s*\/h[3-6]\s*>/gi, '\n\n')
    .replace(/<\s*p\b[^>]*>/gi, '\n\n')
    .replace(/<\s*\/p\s*>/gi, '\n\n')
    .replace(/<\s*li\b[^>]*>/gi, '\n- ')
    .replace(/<\s*\/li\s*>/gi, '\n')
    .replace(/<\s*\/?(ul|ol)\b[^>]*>/gi, '\n')
    .replace(/<\s*pre\b[^>]*>/gi, '\n\n```')
    .replace(/<\s*\/pre\s*>/gi, '\n```\n\n')
    .replace(/<\s*\/?(strong|b|em|i|span|small)\b[^>]*>/gi, '')
    .replace(/<[^>]+>/g, ' ');
}

function prepareLooseMarkdown(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+---[ \t]+/g, '\n\n')
    .replace(/(\S)[ \t]+(#{1,6}\s+)/g, '$1\n\n$2')
    .replace(/[ \t]+(\*\*[A-Z][^*\n]{1,80}\*\*:?[ \t]+)/g, '\n\n$1');
}

export function normalizeDocumentInlineText(input: string): string {
  return decodeHtmlEntities(input)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/_([^_\n]+)_/g, '$1')
    .replace(/~~([^~\n]+)~~/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function normalizeKind(
  kind: NativeDocumentBlockKind | null | undefined,
): NativeDocumentBlockKind {
  return kind ?? 'p';
}

export function parseDocumentDisplayBlocks(input: {
  text: string;
  fallbackKind?: NativeDocumentBlockKind | null;
  format?: 'markdown' | 'html';
}): ParsedDocumentDisplayBlock[] {
  const fallbackKind = normalizeKind(input.fallbackKind);
  const source = input.text.replace(/\r\n?/g, '\n').trim();
  if (!source) return [];
  const markdownish =
    input.format === 'html' || looksLikeHtml(source)
      ? htmlFragmentToMarkdownish(source)
      : source;
  const lines = prepareLooseMarkdown(markdownish).split('\n');
  const blocks: ParsedDocumentDisplayBlock[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const text = normalizeDocumentInlineText(paragraph.join(' '));
    if (text) blocks.push({ kind: 'p', text });
    paragraph = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? '').trim();
    if (!line) {
      flushParagraph();
      continue;
    }

    if (line.startsWith('```')) {
      flushParagraph();
      const code: string[] = [];
      index += 1;
      while (
        index < lines.length &&
        !(lines[index] ?? '').trim().startsWith('```')
      ) {
        code.push(lines[index] ?? '');
        index += 1;
      }
      const text = code.join('\n').trim();
      if (text) blocks.push({ kind: 'code', text });
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      const text = normalizeDocumentInlineText(heading[2] ?? '');
      if (text) {
        blocks.push({
          kind: (heading[1]?.length ?? 1) === 1 ? 'h1' : 'h2',
          text,
        });
      }
      continue;
    }

    const unordered = line.match(/^[-*+]\s+(.+)$/);
    const ordered = line.match(/^\d+[.)]\s+(.+)$/);
    const listText = unordered?.[1] ?? ordered?.[1] ?? null;
    if (listText !== null) {
      flushParagraph();
      const text = normalizeDocumentInlineText(listText);
      if (text) blocks.push({ kind: 'li', text });
      continue;
    }

    paragraph.push(line);
  }

  flushParagraph();

  if (blocks.length === 1 && blocks[0]?.kind === 'p' && fallbackKind !== 'p') {
    return [{ ...blocks[0], kind: fallbackKind }];
  }
  return blocks;
}

export function serializeDocumentBlocksForEditing(
  blocks: NativeDocumentBlock[],
): string {
  return blocks
    .map((block) => {
      if (block.kind === 'h1') return `# ${block.text}`;
      if (block.kind === 'h2') return `## ${block.text}`;
      if (block.kind === 'li') return `- ${block.text}`;
      if (block.kind === 'code') return `\`\`\`\n${block.text}\n\`\`\``;
      return block.text;
    })
    .join('\n\n');
}
