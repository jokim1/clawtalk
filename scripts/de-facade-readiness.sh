#!/usr/bin/env bash

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

if ! command -v rg >/dev/null 2>&1; then
  printf 'ERROR: scripts/de-facade-readiness.sh requires ripgrep (rg).\n' >&2
  exit 2
fi

LIVE_PATHS=(src webapp)
LIVE_GLOBS=(
  --glob '!**/node_modules/**'
  --glob '!**/dist/**'
  --glob '!**/*.test.*'
  --glob '!**/*.spec.*'
)

run_rg() {
  local output
  local status

  set +e
  output="$(rg "$@" 2>&1)"
  status=$?
  set -e

  case "$status" in
    0)
      printf '%s\n' "$output"
      ;;
    1)
      return 0
      ;;
    *)
      printf '%s\n' "$output" >&2
      exit "$status"
      ;;
  esac
}

scan_live() {
  local label="$1"
  local pattern="$2"
  local limit="${3:-20}"
  local matches
  local count

  matches="$(run_rg -n "${LIVE_GLOBS[@]}" "$pattern" "${LIVE_PATHS[@]}")"
  count="$(printf '%s\n' "$matches" | awk 'NF { count++ } END { print count + 0 }')"

  printf '\n## %s\n' "$label"
  printf 'pattern: %s\n' "$pattern"
  printf 'live_consumer_count: %s\n' "$count"
  if [ "$count" -gt 0 ]; then
    printf '%s\n' "$matches" | head -n "$limit"
  else
    printf '<none>\n'
  fi
}

scan_duplicate_mounts() {
  local route="$1"
  local matches
  local count

  matches="$(
    run_rg -n "$route" \
      src/clawtalk/web/worker-app.ts \
      src/clawtalk/web/routes/greenfield-api.ts \
      src/clawtalk/web/routes/greenfield-core.ts \
      src/clawtalk/web/routes/greenfield-detail.ts
  )"
  count="$(printf '%s\n' "$matches" | awk 'NF { count++ } END { print count + 0 }')"

  printf '\n## duplicate-route:%s\n' "$route"
  printf 'mount_or_definition_count: %s\n' "$count"
  if [ "$count" -gt 0 ]; then
    printf '%s\n' "$matches"
  else
    printf '<none>\n'
  fi
}

printf 'DE-FACADE READINESS SCOUT\n'
printf 'root: %s\n' "$ROOT"
printf 'head: %s\n' "$(git rev-parse --short HEAD)"

scan_live 'synthetic-thread-id' '\bthreadId\b|thread_id|syntheticThreadId|threads/:threadId|\?thread=' 40
scan_live 'flat-content-projection' 'bodyMarkdown|bodyHtml' 40
scan_live 'snapshot-compat-version' 'snapshotVersion' 30
scan_live 'run-context-fabrication' 'TalkRunContextSourceManifestItem|TalkRunContextInlineSourceSnapshot|TalkRunContextRetrievedSourceSnapshot|goalIncluded|summaryIncluded|activeRules|stateSnapshot|forcedInjection|connectorToolNames|context_manifest_json|threadId: syntheticThreadId\(record\.talk_id\)' 40
scan_live 'tool-family-compat' 'active_tool_families_json|tool_families|tool-families' 40
scan_live 'connector-channel-compat' 'workspace/channels|workspace/data-connectors|data-connectors|talks/:talkId/connectors|/api/v1/talks/.*/connectors|connectors/channels' 40
scan_live 'policy-facade-route' '/api/v1/talks/.*/policy|talks/:talkId/policy' 40

scan_duplicate_mounts 'reorderGreenfieldTalkSidebarRoute'
scan_duplicate_mounts 'getGreenfieldRunContextRoute'

printf '\nDE_FACADE_READINESS: BLOCKED while any live_consumer_count is nonzero or duplicate routes are mounted in both worker-app.ts and greenfield-api.ts.\n'
