# Contributing

## Source Changes

Accepted source changes generally fall into these buckets:

- bug fixes
- security fixes
- ClawTalk web/talk/runtime improvements
- upstream-safe maintenance and simplification
- documentation that reflects the current implementation

When touching historical NanoClaw-derived code, keep changes isolated and document why the legacy path still matters. New product work should follow the greenfield docs in [docs/README.md](docs/README.md) and [docs/IMPLEMENTATION-READINESS.md](docs/IMPLEMENTATION-READINESS.md).

## Skills

Skills are still the preferred way to add optional integrations or large product branches that do not belong in the shared base.

A [skill](https://code.claude.com/docs/en/skills) should contain the instructions Claude follows to transform an installation. A skill-focused PR should avoid unnecessary source-file edits outside the skill itself.

## Testing

Before submitting a code change, run the relevant checks:

```bash
npm run typecheck
npm run test
npm --prefix webapp run typecheck
npm --prefix webapp run test
```
