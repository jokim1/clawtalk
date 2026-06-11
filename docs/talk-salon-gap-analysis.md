# Talk Screen — Salon Design Gap Analysis

> Status: executed — the Talk Salon pilot (PR #586) and follow-up polish (PRs
> #587–#591) implemented the phased approach below; kept as reference for the
> final polish pass (see [talk-salon-pilot-report.md](./talk-salon-pilot-report.md)).
> Of the open decisions, only the top-bar tab→pill mapping (#3) is still
> undecided. Originally a read-only assessment of `origin/main` (worktree at
> `e41850b`, 2026-06-08) by three explore passes (components, data shape, design
> source + mock pattern).

## TL;DR

**The entire Talk conversation view is still the OLD blue/gray style — zero
Salon.** Home/shell got the Salon redesign; the Talk view did not. So this is a
**full Salon rebuild of the app's largest screen**, not a polish pass. Most of it
is a frontend restyle the evaluator/implementer loop can drive, but a few items
need product/back-end decisions (token counts, `@handle`, the top-bar tab→pill
mapping). Design source to port from already exists:
`docs/prototypes/prototype/shell.jsx`.

## Design vs current (high level)

| Area | Design (mockup) | Current (live) |
| --- | --- | --- |
| Palette / type | Salon cream + serif (Newsreader/Geist) | blue/gray + IBM Plex Sans |
| Message body | rendered markdown | **literal `**bold**`** (no renderer) |
| Msg metadata | name · `@research` · `gemini-2.5-pro` · `Done` · time · `1,620 in · 520 out` | name + timestamp only |
| Round grouping | `ROUND 1` / `ROUND 2` dividers | none (some ordered-round summary UI) |
| Avatar | colored circle (per agent) | none / generic |
| Left panel | none — single round-based thread | **Threads** sub-panel |
| Top bar | pills: Agents / Tools / Context / Connectors / Document / … | tabs: Talk / Documents / Agents / Context / Connectors / Jobs / Run History + Ordered + `+ Doc` |
| Composer | `ADDRESS TO [agents] · Ordered · 3 rounds · Send to room` | agent selector + tool row + "selected agent responds" |

## Current components (what to change)

| Component | File | Styling |
| --- | --- | --- |
| Page root | `webapp/src/pages/TalkDetailPage.tsx:92` | — |
| Top bar (tabs, title, Ordered, +Doc, agent pills) | `webapp/src/components/Talk/TalkDetailShell.tsx:112` (tabs ~139–365) | OLD `.talk-*` |
| Layout + **Threads rail** | `webapp/src/components/Talk/TalkTabContent.tsx:220` (rail ~400–531) | OLD `.talk-thread-*` |
| Timeline + messages | `webapp/src/components/TalkThreadView.tsx:71` (msg render ~281–287) | OLD `.message-*` |
| Composer | `webapp/src/components/TalkComposer.tsx:150` | OLD `.composer-*` |
| Markdown | none — `lib/linkifyText.tsx` only linkifies URLs; `.message p` is `white-space: pre-wrap` | — |

Salon design system available but **unused** here: `webapp/src/salon/*`, CSS vars
`--salon-*` in `webapp/src/salon/salon.css`, `salonFont`.

## Design source (port from)

`docs/prototypes/prototype/shell.jsx`:
- `AgentMessage` (~643–708): byline = serif name + mono `@handle` + mono model badge + `RunPill` status + time + right-aligned `{in} in · {out} out`; colored left border while streaming.
- `RoundList` (~406–429): round divider — hairline + mono `ROUND {n}{· live}`.
- `Composer` (~529–609): `ADDRESS TO` + agent toggles + mode chip (`Ordered`/`Parallel`) + `{n} rounds` chip + `Send to room`.
- Mock message data: `docs/prototypes/prototype/state.jsx:150–170`.
- Palette (`shell.jsx:5–14`): ink `#1F1B16`, ink2 `#6B6660`, paper `#FBF7EF`, paper2 `#F4ECDB`, card `#FFFFFF`, line `#E6E0D1`, accent `#C8643A`.

## Gaps by category

### A. Visual restyle — frontend-only, shippable (the bulk)
Rebuild each component in Salon (tokens/serif/palette), porting from `shell.jsx`:
1. **Messages / timeline** — Salon byline + body; round dividers; colored avatar; remove blue/gray bubbles. *(biggest piece)*
2. **Top bar** — pills instead of tabs (see decision #3 for the tab→pill mapping).
3. **Composer** — `ADDRESS TO` + agent toggles + mode/rounds chips + `Send to room`.
4. **Status pill** "Done" — data ready (`TalkRun.status` → `pillLabelForState`).
5. **Model badge** (`gemini-2.5-pro`) — data ready (`executorModel`/`modelId`).
6. **ROUND dividers** — derivable (`responseGroupId` + `sequenceIndex`).
7. **Colored avatar** — derive color from agent role/nickname (no backend).

### B. Functional fix — markdown rendering
Messages render literal markdown (`TalkThreadView.tsx:281–287` uses `linkifyText`,
no markdown parser). The design renders prose. **Add a markdown renderer.** Note:
`marked`/`turndown` were removed from `webapp` deps during the de-facade work — so
this needs a (lightweight, sanitized) renderer choice. → **Decision #4.**

### C. Data-dependent — need a decision / backend touch
| Item | State | Options |
| --- | --- | --- |
| **Token counts** `1,620 in · 520 out` | persisted in DB (`runs.tokens_in/out`) + in the streaming usage event, but `toRunApi()` (`greenfield-detail.ts`) does **not** return them | (a) omit for now; (b) **small backend change** to surface the two existing columns |
| **`@handle`** (`@research`) | **no field** on agent types (`TalkAgent` has `nickname`, `role`, `modelDisplayName`) | (a) omit; (b) derive a slug from `role`; (c) add a real `handle` (schema) |
| **Avatar color** | no field | derive from role in the UI (no backend) — recommended |

Already-in-data (no work): model name, run status/`Done`, agent nickname/display
name, round grouping fields.

### D. Structural / IA decisions
1. **Threads panel** — design has none; PR #574 retired backend thread routes.
   **→ Decision: REMOVE (match design).** *(your call — confirmed)*
2. **Top-bar tabs → pills** — design pills are Agents / Tools / Context /
   Connectors / Document / …. Current tabs also include **Jobs**, **Run History**,
   **Documents**. → **Decision #3:** which become pills, and where do Jobs / Run
   History / Documents go (overflow `…` menu? dropped? separate route)?
3. **Composer model** — design's `ADDRESS TO … · Ordered · 3 rounds · Send to
   room` maps cleanly onto the existing orchestration (ordered/parallel + rounds +
   multi-agent targeting). Mostly a **restyle + relabel**, not new behavior.

## Open decisions (for you)

1. **Threads panel:** remove (confirmed) ✓
2. **Metadata depth:** frontend-only (omit token counts + `@handle`) **vs** include
   a small backend change to expose token in/out (+ derive `@handle`). *(resolved
   in the pilot: token counts surfaced through the run DTO; `@handle` derived)*
3. **Tab → pill mapping:** what happens to Jobs / Run History / Documents tabs.
   *(still open — see the pilot report's remaining gaps)*
4. **Markdown renderer:** which lib (lightweight + sanitized), since `marked` was
   removed. *(resolved in the pilot: sanitized markdown rendering shipped)*

## Suggested approach (if/when we proceed)

Phase it (each phase = one evaluator/implementer loop vs `shell.jsx`, scored on
**structure + visual**, verified in empty / populated / streaming states):
- **Phase 1 — Messages + timeline:** Salon byline, markdown rendering, round
  dividers, avatar, model badge, Done pill. The biggest visual win.
- **Phase 2 — Composer:** `Send to room`, address-to, mode/rounds chips.
- **Phase 3 — Top bar + remove Threads panel:** pills + tab→pill mapping.

Reuse the harness pattern from `webapp/playwright/home-fidelity.spec.ts` (mock the
talk snapshot/thread/agents/runs per the existing `talk-doc-pane.spec.ts` mocks;
fixed wide viewport; capture + width/structure assertions).

## Risks / notes
- The Talk view is **mid-refactor** (de-facade PRs #562–#574 landing) → coordinate to avoid conflicts.
- `webapp/src/styles.css` is shared (~7k LOC) → scope CSS changes; gate on the other Playwright specs.
- The loop's two known blind spots apply: verify the **real empty/streaming states**, and score **structure/IA**, not just visual styling.
