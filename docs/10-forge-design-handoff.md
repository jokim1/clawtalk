> **Status:** canonical (Forge design/interaction). Front-end mock; all scoring data simulated. Scope toggle maps cleanly to §11 §9 `improvement_runs(document_id, tab_id, target_block_id)` — see §8 below.
> Precedence + orientation: [README.md](./README.md) · decisions: [DECISIONS.md](./DECISIONS.md) · terms: [GLOSSARY.md](./GLOSSARY.md).

# Forge — design handoff

Autonomous content improvement for ClawTalk. This doc is the
hi-fi, clickable design for **Forge** plus the design exploration behind it.
Everything is front-end only — all scoring data is simulated (see *What's
real vs mocked*). Use it as the visual + interaction spec for implementation
against the PRD ([`09-autonomous-content-improvement-prd.md`](./09-autonomous-content-improvement-prd.md)).

---

## Deliverables

| File | What it is |
|---|---|
| [`prototypes/ClawTalk Forge.html`](./prototypes/ClawTalk%20Forge.html) | The clickable prototype. Forked ClawTalk "Salon" app with Forge wired in. Open it and the demo lands on the Pricing Talk with the doc pane open. |
| [`prototypes/ClawTalk Forge - Exploration.html`](./prototypes/ClawTalk%20Forge%20-%20Exploration.html) | Design canvas: written rationale + the entry-surface and gallery-layout options that were explored. |
| [`09-autonomous-content-improvement-prd.md`](./09-autonomous-content-improvement-prd.md) | The source PRD (unchanged). |

### Forge source modules (loaded by `prototypes/ClawTalk Forge.html`)

| File | Contents |
|---|---|
| `prototypes/prototype/forge-data.jsx` | Mock Synthetical assets (personas, audiences, reference sets, survey questions), the simulated runs history, per-persona verbatim responses + Likert spreads, and the connection-state helpers. |
| `prototypes/prototype/forge-config.jsx` | Shared atoms — `ForgeMark`, `ScoreChip`, `PersonaCard`, `ForgeField`, `ForgeSlider` (slider **+ click-to-type** value) — and the full objective config (`ForgeConfig`). |
| `prototypes/prototype/forge-page.jsx` | The **Forge page** (rail destination + sub-nav), Runs list, Run detail (chart + trust + leaderboard + per-persona responses), Audiences, Setup, Onboarding, the compact in-doc **launcher**, and `ForgeMount`. |
| `prototypes/prototype/forge-stages.jsx` | The score line chart + the original full-overlay run/gallery stages (superseded by the page, kept for reference). |
| `prototypes/prototype/forge-canvas.jsx` | Exploration artboards for `prototypes/ClawTalk Forge - Exploration.html`. |

### Integration touchpoints (all gated by `window.CT_FORGE_ENABLED`)

The Forge flag is set in `prototypes/ClawTalk Forge.html` before scripts load, so the
base Salon app (`prototypes/ClawTalk Salon.html`) is untouched when the flag is absent.

- `prototypes/prototype/shell.jsx` — adds the **Forge** item to the icon rail (`IconRail`) and the **Improve** button to the document pane (`DocPane`).
- `prototypes/prototype/documents.jsx` — adds the **Improve** button to the full-screen document view (`DocEditorScreen`).
- `prototypes/prototype/app.jsx` — registers the `forge` route and mounts `ForgeMount`.

> The same five modules also carry the latest base-design updates that ship
> regardless of the Forge flag: Google-Docs-style **document tabs**, the
> multi-workspace **account switcher**, the **resizable document pane**, and a
> `localStorage` schema bump to `clawtalk.salon.v2`.

---

## The surface model (two surfaces, two jobs)

1. **In the document → a simple launcher.** "Improve" (doc pane *and* full-screen doc view) opens a compact modal: pick a saved **audience**, set **target** + **budget**, Start. It hands off to the Forge page to run. An "Open in Forge for full control" link goes to the full config. If Synthetical isn't connected, it routes the user to Setup.
2. **The Forge page (rail) → all the depth.** Sub-nav:
   - **Runs** — history across all docs → **Run detail**: score-over-rounds chart, trust panel (held-out vs optimized + over-fit gap), ranked version leaderboard, and per-version **verbatim persona responses with Likert distributions**.
   - **Audiences** — saved audiences (composed in ClawTalk) + the read-only persona library (authored on Synthetical).
   - **Setup** — Synthetical connection (org, scopes, synced assets) + "how Forge works". Disconnect flips the page to a first-run **onboarding** gate.

---

## Design → PRD mapping

| PRD | Where it shows up |
|---|---|
| §11 Entry ("Improve" on doc pane + selection) | In-doc launcher (doc pane + doc editor); scope toggle = whole doc / tab / title / section (see §8 below for the schema mapping) |
| §11 Config modal | Compact launcher + full `ForgeConfig` ("New run" / "Open in Forge") |
| §6 Objective (`persona_ids`, `reference_set_ids`, `survey_question`, `scoring_config`, fitness) | Audience + personas, reference set, survey question, target score; Advanced = mutation strategies, beam N / top-k, held-out toggle |
| §5.4 Stop conditions | Run shows target / max-rounds / plateau / budget; run statuses include `plateaued`, `cancelled` |
| §11 Live run | Run detail "running" state — animated chart + status |
| §11 Version gallery | Run detail leaderboard + per-persona responses; diff view in the in-doc result |
| §10 Goodhart / trust | Trust panel: optimized vs **held-out** score + over-fit gap; "winner lands as a pending edit" (no autonomous overwrite) |
| §7 Synthetical integration | Setup/connection (scopes `assets:write` / `tests:run` / `tests:read`, org binding), onboarding gate; personas read-only (link out), **audiences composed in-app** per §6 |

---

## What's real vs mocked

**Everything is a front-end mock.** There is no Synthetical API call, no
backend, no real scoring. Specifically:
- Personas, audiences, reference sets, runs, candidates, scores, and persona
  responses are static fixtures in `prototypes/prototype/forge-data.jsx`.
- The "live run" is a timed animation, not real iteration.
- "Set winner as document" shows a success state; it does not patch content.
- The Synthetical connection is a `localStorage` toggle (`ct-forge-connected`).
- Doc-pane width persists to `localStorage` (`ct-doc-width`); demo route is
  seeded in `localStorage` (`clawtalk.salon.v2`).

## Scope toggle ↔ schema mapping

The "Improve" launcher's scope toggle (whole doc / tab / title / section) maps directly onto §11 §9 `improvement_runs(document_id, tab_id, target_block_id)`:

| Scope toggle | `improvement_runs` columns | Notes |
|---|---|---|
| Whole doc | `document_id` only (`tab_id = null`, `target_block_id = null`) | The full document across all tabs |
| Tab | `document_id` + `tab_id` (`target_block_id = null`) | One tab in the document |
| Title | `document_id` + `tab_id` + `target_block_id` where the block's `kind = 'h1'` | "Title" is the h1 block at the top of a tab |
| Section | `document_id` + `tab_id` + `target_block_id` where the block's `kind = 'h2'` | "Section" is an h2 heading and the run scopes to that block (see §11 §5 `doc_blocks.kind` enum: `'h1'`/`'h2'`/`'p'`/`'li'`/`'meta'`/`'code'`). |

"Title" and "section" are **not new scope unit names** in the schema — they're surface labels for the existing `doc_blocks.kind` values `'h1'` / `'h2'`. Implementing the toggle is a `kind`-filtered block picker, not a new table.

## Suggested build order (from the PRD)

1. SSR connector — OAuth + org binding (token in `connector_secrets`, §11 §6), `create_candidate_assets` / `run_scoring_batch` / `get_scoring_batch` with polling (PRD §7).
2. `improvement_runs` + `document_versions` tables (§11 §9 — that's the canonical schema source) backing the Runs list + Run detail.
3. Thin slice: in-doc launcher → one scored round → leaderboard → promote by inserting a `document_edits` row with `source='forge'` (§11 §5) for human accept (PRD §12 P0).
4. The loop (beam search, critic-driven mutation, stop conditions) + event-hub streaming into the Run detail "running" state (PRD §12 P1).
5. Held-out validation re-scoring feeding the trust panel (PRD §10).
