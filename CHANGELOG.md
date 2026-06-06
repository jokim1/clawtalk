# Changelog

> Historical NanoClaw/ClawRocket-era changelog. Current ClawTalk greenfield refactor status lives in [docs/roadmap.md](docs/roadmap.md) and [docs/REFACTOR-AUDIT.md](docs/REFACTOR-AUDIT.md).

All historical notable changes to NanoClaw/ClawRocket are documented in this file.

## [1.2.7](https://github.com/jokim1/clawrocket/compare/v1.2.6...v1.2.7)

- Fixed direct Talk provider runs so they honor each model's configured output
  budget instead of silently falling back to a 1024-token cap, which was
  truncating long Kimi and Gemini responses.
- Added Talk nickname mention routing, so typed mentions like `@kimi` and
  `@gem` target the matching assigned agents instead of being ignored.
- Persisted and recovered Talk agent attribution for assistant messages, and
  updated the Talk UI to show agent nicknames directly instead of ambiguous
  generic `assistant` labels when the actor is known.

## [1.2.6](https://github.com/jokim1/clawrocket/compare/v1.2.5...v1.2.6)

- Allowed ordered Talk rounds to continue after an earlier agent fails, instead
  of auto-cancelling later queued steps.
- Updated ordered-agent prompt construction so downstream agents are told when
  earlier steps failed and unfinished perspectives were omitted from context.
- Clarified ordered-round Talk UI states so users can distinguish "blocked by a
  prior failure" from "failed, but later agents continued."

## [1.2.5](https://github.com/jokim1/clawrocket/compare/v1.2.4...v1.2.5)

- Added browser-profile usage visibility and deletion controls in Settings,
  including server-side cleanup for managed ClawRocket browser and download
  directories.
- Tightened browser auth-block detection by checking page titles and visible
  headings/buttons, which improves LinkedIn detection even when full body text
  is sparse or delayed.
- Disabled NVIDIA-hosted Kimi 2.5 thinking mode for streamed chat completions
  so Main runs receive normal assistant text instead of failing with an empty
  final response.

## [1.2.4](https://github.com/jokim1/clawrocket/compare/v1.2.3...v1.2.4)

- Fixed ordered multi-agent runs so ambiguous or truncated direct-HTTP provider
  endings no longer persist partial text as a successful assistant response.
- Persisted response-completion metadata on talk runs and exposed it to the Talk
  API so incomplete agent failures can be classified and recovered explicitly.
- Added persistent ordered-round status UI, per-message step badges, and Retry
  agent actions so failed ordered runs are obvious and usable instead of looking
  silently finished.

## [1.2.3](https://github.com/jokim1/clawrocket/compare/v1.2.2...v1.2.3)

- Updated the repo and CI/deploy workflows to target Node.js 24 LTS.
- Added a repo-managed production Node runtime path so deploys can install and
  run the service on Node 24 without depending on the host's global Node
  package staying current.
- Fixed Browser Profiles settings so duplicate adds do not silently reuse an
  existing profile, and browser profile errors now render with error styling.
- Added a Browser Profiles escape hatch to disconnect blocking browser sessions,
  and reconciled stale blocked sessions to `disconnected` on startup so dead
  browser state no longer permanently prevents profile edits.

## [1.2.2](https://github.com/jokim1/clawrocket/compare/v1.2.1...v1.2.2)

- Added Chrome-profile discovery in Browser Profiles settings, including
  auto-detection of Chrome user-data directories and real Chrome subprofiles.
- Added per-subprofile browser profile selection so browser sessions can launch
  against a specific Chrome profile like `Default` or `Profile 4` instead of
  relying on Chrome's last-used profile.

## [1.2.1](https://github.com/jokim1/clawrocket/compare/v1.2.0...v1.2.1)

- Fixed ClawTalk sidebar unread indicators so stale local message counts no longer
  show blue badges when a talk has no newer messages.

## [1.2.0](https://github.com/qwibitai/nanoclaw/compare/v1.1.6...v1.2.0)

[BREAKING] WhatsApp removed from core, now a skill. Run `/add-whatsapp` to re-add (existing auth/groups preserved).
