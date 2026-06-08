#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const SRC_SCOPES = ['src', 'webapp/src'];
const WEB_ROUTE_SCOPE = ['src/clawtalk/web'];

const NON_TEST_GLOBS = ["--glob '!**/*.test.*'", "--glob '!**/*.spec.*'"];
const TEST_GLOBS = ["--glob '**/*.test.*'", "--glob '**/*.spec.*'"];

const facades = [
  {
    id: 'synthetic-thread-id',
    name: 'Synthetic threadId',
    tokens:
      '\\bthreadIds?\\b|\\?thread=|threadId=|/threads/|syntheticThreadId|ContentSidebarItem|TalkThread',
    imports:
      'TalkThread|ContentSidebarItem|snapshotQueryKey|getThreadContent|createThread|updateThreadMetadata|deleteThread|lastThreadForTalk|threadScroll',
    routes:
      '/api/v1/talks/:talkId/threads|/api/v1/threads/:threadId/content|threadId',
    dynamic:
      'clawtalk_doc_state|snapshotQueryKey|wsCacheRouter|lastThread|threadScroll|thread=|threadId',
  },
  {
    id: 'runs-messages-threadid',
    name: 'Runs/messages threadId DTO fields',
    tokens:
      'TalkMessage|TalkRun|threadId|threadIds|responseGroupId|run\\.threadId|message\\.threadId|payload\\.threadId',
    imports: 'TalkMessage|TalkRun|talkRunReducer|useTalkRunStream|talkStream',
    routes:
      '/api/v1/talks/:talkId/runs|/api/v1/talks/:talkId/messages|threadId|responseGroupId',
    dynamic:
      'run\\.threadId|message\\.threadId|event\\.threadId|payload\\.threadId|threadIds|selectedThreadId',
  },
  {
    id: 'run-context-fabrication',
    name: 'Run-context fabrication',
    tokens:
      'TalkRunContextSnapshot|TalkRunContextSourceManifestItem|TalkRunContextInlineSourceSnapshot|TalkRunContextRetrievedSourceSnapshot|goalIncluded|summaryIncluded|activeRules|stateSnapshot|forcedInjection|context_manifest_json',
    imports:
      'TalkRunContextSnapshot|TalkRunContextSourceManifestItem|TalkRunContextInlineSourceSnapshot|TalkRunContextRetrievedSourceSnapshot',
    routes:
      'contextSnapshot|context_manifest_json|threadId: syntheticThreadId\\(record\\.talk_id\\)',
    dynamic:
      'contextSnapshot|runContextSnapshots|goalIncluded|summaryIncluded|activeRules|stateSnapshot|forcedInjection',
  },
  {
    id: 'flat-content-projections',
    name: 'Flat content projections bodyMarkdown/bodyHtml',
    tokens:
      'bodyMarkdown|bodyHtml|ContentFormat|renderDocumentMarkdown|/threads/:threadId/content|/contents/:contentId',
    imports:
      '\\bContent\\b|\\bContentFormat\\b|getThreadContent|updateContent|CopyExportMenu|RichTextEditor|PendingEditDocSurface',
    routes:
      '/api/v1/threads/:threadId/content|/api/v1/contents/:contentId|bodyMarkdown|bodyHtml',
    dynamic:
      'clawtalk_doc_state|bodyMarkdown|bodyHtml|ContentImage|markdownToTiptapJson|renderMarkdown|renderHtml',
  },
  {
    id: 'snapshot-version',
    name: 'snapshotVersion compat',
    tokens: 'snapshotVersion|getTalkSnapshotVersion',
    imports: 'snapshotQueryKey|useTalkSnapshot|wsCacheRouter|TalkSnapshot',
    routes: 'snapshotVersion|getTalkSnapshotVersion',
    dynamic: 'snapshotVersion',
  },
  {
    id: 'policy-facade',
    name: 'Policy facade',
    tokens:
      'talkPolicyPayload|getGreenfieldTalkPolicyRoute|updateGreenfieldTalkPolicyRoute|getTalkPolicy|updateTalkPolicy|/api/v1/talks/:talkId/policy|/talks/.*/policy',
    imports:
      'getGreenfieldTalkPolicyRoute|updateGreenfieldTalkPolicyRoute|getTalkPolicy|updateTalkPolicy',
    routes:
      '/api/v1/talks/:talkId/policy|getGreenfieldTalkPolicyRoute|updateGreenfieldTalkPolicyRoute',
    dynamic: 'talkPolicy|/api/v1/talks/.*/policy|invalid_agents',
  },
  {
    id: 'tool-connectors-facades',
    name: 'Tool/connectors facades',
    tokens:
      'active_tool_families|talk_tools|toolFamily|toolFamilies|/workspace/channels|/workspace/data-connectors|/connectors|TalkConnectorsPanel|ConnectorsSettingsPanel',
    imports:
      'TalkConnectorsPanel|ConnectorsSettingsPanel|WorkspaceChannel|WorkspaceDataConnector|TalkConnectorDataConnectorRow|ToolChipsBar|tool-catalog',
    routes:
      '/api/v1/workspace/channels|/api/v1/workspace/data-connectors|/api/v1/talks/:talkId/connectors|talk_tools|toolFamily',
    dynamic:
      'talk_tools_changed|activeToolFamilies|toolFamily|toolFamilies|connectors|dataConnectors|channels',
  },
  {
    id: 'duplicate-hono-mounts',
    name: 'Duplicate Hono mounts',
    tokens:
      'reorderGreenfieldTalkSidebarRoute|getGreenfieldRunContextRoute|/api/v1/talks/sidebar/reorder|/api/v1/talks/:talkId/runs/:runId/context',
    imports:
      'import .*reorderGreenfieldTalkSidebarRoute|import .*getGreenfieldRunContextRoute|from .*greenfield-core|from .*greenfield-detail',
    routes:
      '/api/v1/talks/sidebar/reorder|/api/v1/talks/:talkId/runs/:runId/context|reorderGreenfieldTalkSidebarRoute|getGreenfieldRunContextRoute',
    dynamic:
      'mountGreenfieldApiRoutes|reorderGreenfieldTalkSidebarRoute|getGreenfieldRunContextRoute',
  },
  {
    id: 'attachments-not-available',
    name: 'attachments_not_available guard',
    tokens:
      'attachments_not_available|/attachments|attachmentIds|uploadTalkAttachment|deleteTalkAttachment|read_attachment',
    imports:
      'uploadTalkAttachment|deleteTalkAttachment|TalkMessageAttachment|attachment-storage|attachment-caps',
    routes:
      '/api/v1/talks/:talkId/attachments|attachmentsUnavailableResponse|attachments_not_available',
    dynamic:
      'attachmentIds|pendingAttachments|read_attachment|attachments_not_available',
  },
];

const modalities = [
  {
    name: 'literal token grep',
    patternKey: 'tokens',
    scopes: SRC_SCOPES,
    globs: NON_TEST_GLOBS,
  },
  {
    name: 'import/re-export trace',
    patternKey: 'imports',
    scopes: SRC_SCOPES,
    globs: NON_TEST_GLOBS,
  },
  {
    name: 'route registration trace',
    patternKey: 'routes',
    scopes: WEB_ROUTE_SCOPE,
    globs: [],
  },
  {
    name: 'test fixture/assertion trace',
    patternKey: 'tokens',
    scopes: SRC_SCOPES,
    globs: TEST_GLOBS,
  },
  {
    name: 'dynamic/string-key/cache-router trace',
    patternKey: 'dynamic',
    scopes: SRC_SCOPES,
    globs: [],
  },
];

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function runRg(pattern, scopes, globs) {
  const args = [
    '-n',
    ...globs.flatMap((entry) => {
      const match = entry.match(/^--glob '(.+)'$/);
      return match ? ['--glob', match[1]] : entry.split(' ');
    }),
    '-e',
    pattern,
    ...scopes,
  ];
  const result = spawnSync('rg', args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 20,
  });
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(result.stderr || `rg exited ${result.status}`);
  }
  const lines = result.stdout.trim() ? result.stdout.trim().split('\n') : [];
  const files = new Set(lines.map((line) => line.split(':', 1)[0]));
  return {
    command: ['rg', '-n', ...globs, '-e', shellQuote(pattern), ...scopes].join(
      ' ',
    ),
    lines: lines.length,
    files: files.size,
  };
}

for (const facade of facades) {
  console.log(`facade: ${facade.id} - ${facade.name}`);
  for (const modality of modalities) {
    const pattern = facade[modality.patternKey];
    const result = runRg(pattern, modality.scopes, modality.globs);
    console.log(
      `  ${modality.name}: ${result.lines} matching lines in ${result.files} files`,
    );
    console.log(`    command: ${result.command}`);
  }
}
