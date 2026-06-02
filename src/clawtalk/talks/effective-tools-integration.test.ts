import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closePgDatabase,
  deleteAuthUsers,
  getDbPg,
  initPgDatabase,
  purgeUserData,
  seedAuthUser,
  seedTalk,
  withUserContext,
} from '../db/test-helpers.js';
import {
  createRegisteredAgent,
  getEffectiveToolsForAgent,
} from '../db/agent-accessors.js';
import { ensureWorkspaceBootstrapForUser } from '../workspaces/bootstrap.js';
import { buildContextTools, loadTalkContext } from './context-loader.js';

const USER_ID = '0c222222-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TALK_ID = '0c222222-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

async function seedToolRows(
  workspaceId: string,
  rows: Array<{ toolId: string; enabled: boolean }>,
): Promise<void> {
  if (rows.length === 0) return;
  const db = getDbPg();
  for (const row of rows) {
    await db`
      insert into public.talk_tools (workspace_id, talk_id, tool_id, enabled)
      values (
        ${workspaceId}::uuid,
        ${TALK_ID}::uuid,
        ${row.toolId},
        ${row.enabled}
      )
      on conflict (talk_id, tool_id) do update
        set enabled = excluded.enabled
    `;
  }
}

async function loadContextForToolRows(
  rows: Array<{ toolId: string; enabled: boolean }>,
) {
  const workspaceId = await ensureWorkspaceBootstrapForUser(USER_ID);
  await seedTalk({ ownerId: USER_ID, talkId: TALK_ID });
  await seedToolRows(workspaceId, rows);
  const agent = await withUserContext(USER_ID, () =>
    createRegisteredAgent({
      ownerId: USER_ID,
      workspaceId,
      name: 'Tool Integration Agent',
      providerId: 'provider.anthropic',
      modelId: 'claude-opus-4-7',
    }),
  );
  const effectiveTools = await withUserContext(USER_ID, () =>
    getEffectiveToolsForAgent(agent.id, { talkId: TALK_ID }),
  );
  const context = await loadTalkContext(TALK_ID, 8000, null, null, USER_ID, {
    effectiveTools,
  });
  return { context, effectiveTools };
}

describe('talk-scoped tool toggles through loadTalkContext', () => {
  beforeAll(async () => {
    await initPgDatabase();
    await seedAuthUser({
      id: USER_ID,
      email: 'tools-int@clawtalk.local',
    });
  });

  beforeEach(async () => {
    await purgeUserData([USER_ID]);
  });

  afterAll(async () => {
    await purgeUserData([USER_ID]);
    await deleteAuthUsers([USER_ID]);
    await closePgDatabase();
  });

  it('omits web tools and web freshness instructions when web is disabled', async () => {
    const { context, effectiveTools } = await loadContextForToolRows([
      { toolId: 'web-search', enabled: false },
      { toolId: 'web-fetch', enabled: false },
      { toolId: 'gdrive-read', enabled: true },
    ]);

    expect(
      effectiveTools.find((tool) => tool.toolFamily === 'web'),
    ).toMatchObject({ enabled: false });
    const toolNames = context.contextTools.map((tool) => tool.name);
    expect(toolNames).not.toContain('web_search');
    expect(toolNames).not.toContain('web_fetch');
    expect(context.systemPrompt).not.toContain("Today's date");
    expect(context.systemPrompt).not.toContain('verify it with web_search');
  });

  it('omits the Bound Drive prompt section and Google schemas when Google is disabled', async () => {
    const { context } = await loadContextForToolRows([
      { toolId: 'web-search', enabled: true },
      { toolId: 'gdrive-read', enabled: false },
      { toolId: 'gdrive-write', enabled: false },
    ]);

    const toolNames = context.contextTools.map((tool) => tool.name);
    expect(context.systemPrompt).not.toContain(
      '**Bound Google Drive Resources:**',
    );
    expect(toolNames).not.toContain('google_drive_search');
    expect(toolNames).not.toContain('google_docs_create');
  });

  it('includes the Bound Drive prompt section and read schemas when Google read is enabled', async () => {
    const { context } = await loadContextForToolRows([
      { toolId: 'gdrive-read', enabled: true },
      { toolId: 'gdrive-write', enabled: false },
    ]);

    const toolNames = context.contextTools.map((tool) => tool.name);
    expect(context.systemPrompt).toContain('**Bound Google Drive Resources:**');
    expect(context.systemPrompt).toContain(
      'No Drive resources are bound to this Talk',
    );
    expect(toolNames).toContain('google_drive_search');
    expect(toolNames).toContain('google_docs_read');
    expect(toolNames).not.toContain('google_docs_create');
  });

  it('exposes all enabled light families and keeps retired legacy tools hidden', async () => {
    const { context } = await loadContextForToolRows([
      { toolId: 'web-search', enabled: true },
      { toolId: 'web-fetch', enabled: true },
      { toolId: 'gdrive-read', enabled: true },
      { toolId: 'gdrive-write', enabled: true },
    ]);

    const toolNames = context.contextTools.map((tool) => tool.name);
    expect(toolNames).toContain('read_source');
    expect(toolNames).toContain('web_search');
    expect(toolNames).toContain('google_drive_search');
    expect(toolNames).toContain('google_docs_create');
    expect(toolNames).not.toContain('list_state');
    expect(toolNames).not.toContain('read_state');
    expect(toolNames).not.toContain('read_attachment');
  });

  it('keeps apply_content_edit available for attached content even when all tool families are disabled', async () => {
    const { effectiveTools } = await loadContextForToolRows([
      { toolId: 'web-search', enabled: false },
      { toolId: 'web-fetch', enabled: false },
      { toolId: 'gdrive-read', enabled: false },
      { toolId: 'gdrive-write', enabled: false },
      { toolId: 'messaging', enabled: false },
    ]);

    expect(effectiveTools.every((tool) => !tool.enabled)).toBe(true);
    await expect(
      getDbPg()<Array<{ exists: boolean }>>`
        select to_regclass('public.contents') is not null as exists
      `,
    ).resolves.toEqual([{ exists: false }]);

    // Final greenfield no longer has the retired `public.contents` table that
    // old loadTalkContext used to derive hasContent. Pin the live allowlist
    // boundary directly: when the caller has attached content, the tool-family
    // filter must not swallow the document edit tool.
    const toolNames = buildContextTools(
      TALK_ID,
      USER_ID,
      null,
      effectiveTools,
      true,
    ).map((tool) => tool.name);

    expect(toolNames).toContain('read_source');
    expect(toolNames).toContain('apply_content_edit');
    expect(toolNames).not.toContain('web_search');
    expect(toolNames).not.toContain('google_drive_search');
    expect(toolNames).not.toContain('list_state');
    expect(toolNames).not.toContain('read_attachment');
  });
});
