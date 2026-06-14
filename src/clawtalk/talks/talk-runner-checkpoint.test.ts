// TalkRunner 8A reference-checkpoint tests — Talk Runtime v2, Wave 2 PR-A3.
//
// Runs in the Node suite (not workerd): these are pure-helper assertions over
// the multi-page-PDF fixture, so node:fs can read the 3-4MB fixture files
// directly. The in-machine side of 8A (a step whose oversized checkpoint fails,
// and a reference-shaped checkpoint that fits) lives in the workers suite
// (talk-runner.workers.test.ts + talk-runner-fencing.workers.test.ts). R2 round
// trips themselves are covered by attachment-storage.test.ts, so here the loader
// contract is a plain key→bytes map seeded from the fixture page files.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  MAX_CHECKPOINT_BYTES,
  collectCheckpointImageRefs,
  serializeCheckpoint,
} from './talk-runner.js';

const fixtureDir = new URL(
  '../../../eval/fixtures/talk-runtime-v2/checkpoint-pdf/',
  import.meta.url,
);
const readFixture = (name: string) => readFileSync(new URL(name, fixtureDir));
const readFixtureJson = (name: string) =>
  JSON.parse(readFixture(name).toString('utf8'));

const reference = readFixtureJson('reference-checkpoint.json');
const inline = readFixtureJson('provider-messages.openai-chat.inline.json');
const manifest = readFixtureJson('manifest.json') as {
  sqliteValueCapBytes: number;
  pageImages: {
    items: {
      storageKey: string;
      file: string;
      byteLength: number;
      sha256: string;
    }[];
  };
};

const byteLen = (s: string) => new TextEncoder().encode(s).length;

describe('8A reference checkpoints (multi-page-PDF fixture)', () => {
  it('rejects the inline provider-message shape — it blows the 1MB cap and the SQLite value cap', () => {
    const inlineBytes = byteLen(JSON.stringify(inline));
    // The naive checkpoint (full provider message array with each PDF page
    // inlined as base64) is ~4.1MB — over the 1MB assert AND the 2MB DO SQLite
    // value cap. This is WHY checkpoints must be reference-based.
    expect(inlineBytes).toBeGreaterThan(MAX_CHECKPOINT_BYTES);
    expect(inlineBytes).toBeGreaterThan(manifest.sqliteValueCapBytes);
    expect(() => serializeCheckpoint(inline)).toThrow(
      /checkpoint is \d+B, over/,
    );
  });

  it('accepts the reference shape — text/structure + R2 keys, well under 1MB', () => {
    const json = serializeCheckpoint(reference); // does not throw
    const refBytes = byteLen(json);
    expect(refBytes).toBeLessThan(MAX_CHECKPOINT_BYTES);
    // Reference is dramatically smaller than the inline shape (no blobs): the
    // whole point of 8A. (Fixture: ~3.8KB vs ~4.1MB.)
    expect(refBytes * 100).toBeLessThan(byteLen(JSON.stringify(inline)));
    // And it really is reference-based: R2 keys present, no inlined base64.
    expect(json).toContain('pdf_page_image_ref');
    expect(json).not.toContain('base64');
  });

  it('collects every R2 page ref the resume path must rehydrate', () => {
    const refs = collectCheckpointImageRefs(reference);
    expect(refs).toHaveLength(manifest.pageImages.items.length); // all 6 pages
    expect(refs.map((r) => r.storageKey)).toEqual(
      manifest.pageImages.items.map((i) => i.storageKey),
    );
    // Each ref carries the metadata a loader needs to validate the rehydrated
    // bytes (size + hash), so a corrupted/short R2 object is detectable.
    for (const ref of refs) {
      expect(typeof ref.storageKey).toBe('string');
      expect(typeof ref.byteLength).toBe('number');
      expect(typeof ref.sha256).toBe('string');
    }
  });

  it('rehydrates page bytes from storage and they match the source (resume round-trip)', async () => {
    // Seed a key→bytes store from the fixture page files — the loader contract
    // production binds to attachment-storage (loadAttachmentFile / loadPageImage).
    const store = new Map<string, Buffer>();
    for (const item of manifest.pageImages.items) {
      store.set(item.storageKey, readFixture(item.file));
    }
    const load = async (storageKey: string): Promise<Buffer> => {
      const bytes = store.get(storageKey);
      if (!bytes) throw new Error(`missing R2 object: ${storageKey}`);
      return bytes;
    };

    const refs = collectCheckpointImageRefs(reference);
    expect(refs).toHaveLength(6);
    for (const ref of refs) {
      const bytes = await load(ref.storageKey);
      // The rehydrated bytes match the ref's recorded length and content hash —
      // i.e. resume reconstructs exactly the source page image from R2.
      expect(bytes.byteLength).toBe(ref.byteLength);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(ref.sha256);
    }
  });
});
