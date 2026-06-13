# Talk Runtime v2 Checkpoint PDF Fixture

Fixture for the PR-A3 / 8A checkpoint-size assert in Talk Runtime v2 Wave 2.

Files:

- `checkpoint-heavy-report.pdf`: six-page synthetic report, 3,079,390 bytes (2.94 MiB).
- `page-images/`: six raster page JPEGs for R2 seeding, 3,074,350 raw bytes total (2.93 MiB).
- `provider-messages.openai-chat.inline.json`: recorded OpenAI chat-style message array with each page inlined as a `data:image/jpeg;base64,...` URL, 4,101,290 serialized bytes (3.91 MiB).
- `reference-checkpoint.json`: reference-style checkpoint probe with text/structure plus R2 keys only, 3,769 serialized bytes.
- `manifest.json`: byte counts, hashes, page metadata, and deterministic storage keys.

Why this forces the 8A assert:

- The Durable Object SQLite value cap is 2,097,152 bytes.
- A naive checkpoint that stores the full provider message array with inlined page images is 4,101,290 bytes, so it exceeds that cap.
- The intended checkpoint stores only text, structure, and R2 keys such as `attachments/talk-runtime-v2-fixture/checkpoint-heavy-report/page-0.jpg`; PR-A3 should rehydrate page bytes through `loadPageImage` / `attachment-storage` and assert the serialized checkpoint remains below 1,048,576 bytes.

The page images are synthetic but intentionally report-like: text rows, tables, charts, and dense raster scan/heatmap regions. The dense raster areas keep compression realistic for scanned or chart-heavy PDFs, instead of producing an unrealistically tiny fixture.
