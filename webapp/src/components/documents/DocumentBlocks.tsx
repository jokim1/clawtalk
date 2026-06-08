/**
 * Presentational renderer for a native document tab's blocks.
 *
 * Reads only the native `doc_blocks` shape (kind + text + attrs) — never a
 * markdown/html body facade. Blocks with a pending edit get a left accent rail
 * and a "pending" marker so reviewers can see where proposed changes land.
 */
import { salon, salonFont } from '../../salon';
import type { NativeDocumentBlock } from '../../lib/api';

const KIND_STYLE: Record<NativeDocumentBlock['kind'], React.CSSProperties> = {
  h1: {
    fontFamily: salonFont.serif,
    fontSize: 24,
    fontWeight: 500,
    color: salon.ink,
    margin: 0,
  },
  h2: {
    fontFamily: salonFont.serif,
    fontSize: 19,
    fontWeight: 500,
    color: salon.ink,
    margin: 0,
  },
  p: {
    fontSize: 14.5,
    lineHeight: 1.65,
    color: salon.ink,
    margin: 0,
  },
  li: {
    fontSize: 14.5,
    lineHeight: 1.6,
    color: salon.ink,
    margin: 0,
  },
  meta: {
    fontSize: 12.5,
    color: salon.ink2,
    margin: 0,
  },
  code: {
    fontFamily: salonFont.mono,
    fontSize: 13,
    lineHeight: 1.55,
    color: salon.ink,
    background: salon.paper2,
    border: `1px solid ${salon.line}`,
    borderRadius: 10,
    padding: '10px 12px',
    margin: 0,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
};

function BlockBody({ block }: { block: NativeDocumentBlock }): JSX.Element {
  const style = KIND_STYLE[block.kind];
  if (block.kind === 'li') {
    return (
      <div style={{ display: 'flex', gap: 8, ...style }}>
        <span aria-hidden="true" style={{ color: salon.ink2 }}>
          •
        </span>
        <span>{block.text}</span>
      </div>
    );
  }
  if (block.kind === 'code') {
    return <pre style={style}>{block.text}</pre>;
  }
  if (block.kind === 'h1') return <h2 style={style}>{block.text}</h2>;
  if (block.kind === 'h2') return <h3 style={style}>{block.text}</h3>;
  return <p style={style}>{block.text}</p>;
}

export function DocumentBlocks({
  blocks,
  pendingByBlock,
}: {
  blocks: NativeDocumentBlock[];
  /** Block ids that have at least one pending edit, for the review marker. */
  pendingByBlock: Set<string>;
}): JSX.Element {
  if (blocks.length === 0) {
    return (
      <div
        style={{
          padding: '20px 0',
          fontSize: 13.5,
          color: salon.ink2,
        }}
      >
        This tab has no content yet.
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {blocks.map((block) => {
        const pending = pendingByBlock.has(block.id);
        return (
          <div
            key={block.id}
            data-block-kind={block.kind}
            data-pending={pending ? 'true' : undefined}
            style={{
              position: 'relative',
              paddingLeft: pending ? 14 : 0,
              borderLeft: pending
                ? `3px solid ${salon.accent}`
                : '3px solid transparent',
            }}
          >
            <BlockBody block={block} />
            {pending ? (
              <span
                style={{
                  display: 'inline-block',
                  marginTop: 6,
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: 0.3,
                  textTransform: 'uppercase',
                  color: salon.accentStrong,
                }}
              >
                Pending edit
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
