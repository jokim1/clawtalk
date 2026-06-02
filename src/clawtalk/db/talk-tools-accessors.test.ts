import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closePgDatabase,
  getDbPg,
  initPgDatabase,
  withUserContext,
} from '../../db.js';
import { ensureWorkspaceBootstrapForUser } from '../workspaces/bootstrap.js';
import { buildEffectiveToolsFromTalkToolRows } from './agent-accessors.js';
import {
  createTalkResourceBinding,
  deleteTalkResourceBinding,
  deleteUserGoogleCredential,
  getTalkActiveTools,
  getUserGoogleCredential,
  listTalkResourceBindings,
  setTalkActiveTool,
  upsertUserGoogleCredential,
} from './talk-tools-accessors.js';

const OWNER_ID = '0c444444-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const MEMBER_ID = '0c444444-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

async function seedAuthUser(id: string, email: string): Promise<void> {
  const db = getDbPg();
  await db`
    insert into auth.users (id, email, raw_user_meta_data)
    values (
      ${id}::uuid,
      ${email}::text,
      jsonb_build_object('full_name', ${email}::text)
    )
    on conflict (id) do update set
      email = excluded.email,
      raw_user_meta_data = excluded.raw_user_meta_data
  `;
}

async function deleteFixtureUsers(): Promise<void> {
  const db = getDbPg();
  await db`
    delete from public.workspaces
    where owner_id in (${OWNER_ID}::uuid, ${MEMBER_ID}::uuid)
  `;
  await db`
    delete from auth.users
    where id in (${OWNER_ID}::uuid, ${MEMBER_ID}::uuid)
  `;
}

async function createFixture(input?: { talkCreatorId?: string }): Promise<{
  workspaceId: string;
  talkId: string;
}> {
  await seedAuthUser(OWNER_ID, 'tools-owner@clawtalk.local');
  await seedAuthUser(MEMBER_ID, 'tools-member@clawtalk.local');
  const workspaceId = await ensureWorkspaceBootstrapForUser(OWNER_ID);
  const db = getDbPg();
  const talkCreatorId = input?.talkCreatorId ?? OWNER_ID;
  await db`
    insert into public.workspace_members (workspace_id, user_id, role)
    values (${workspaceId}::uuid, ${MEMBER_ID}::uuid, 'member')
    on conflict (workspace_id, user_id) do update set role = excluded.role
  `;
  const talkRows = await db<Array<{ id: string }>>`
    insert into public.talks (workspace_id, sort_order, title, created_by)
    values (${workspaceId}::uuid, 0, 'Tools Test Talk', ${talkCreatorId}::uuid)
    returning id
  `;
  return { workspaceId, talkId: talkRows[0]!.id };
}

beforeAll(async () => {
  await initPgDatabase();
});

afterAll(async () => {
  await deleteFixtureUsers();
  await closePgDatabase();
});

describe('talk tool compatibility accessors (greenfield)', () => {
  beforeEach(async () => {
    await deleteFixtureUsers();
  });

  it('stores Talk resource bindings in connector_bindings', async () => {
    const { talkId } = await createFixture();

    await withUserContext(OWNER_ID, async () => {
      const created = await createTalkResourceBinding({
        ownerId: OWNER_ID,
        talkId,
        bindingKind: 'google_drive_folder',
        externalId: 'folder-123',
        displayName: 'Project Docs',
        metadata: { driveId: 'drive-a' },
        createdBy: OWNER_ID,
      });
      expect(created).toMatchObject({
        talkId,
        ownerId: OWNER_ID,
        bindingKind: 'google_drive_folder',
        externalId: 'folder-123',
        displayName: 'Project Docs',
        metadata: { driveId: 'drive-a' },
        createdBy: OWNER_ID,
      });

      const deduped = await createTalkResourceBinding({
        ownerId: OWNER_ID,
        talkId,
        bindingKind: 'google_drive_folder',
        externalId: 'folder-123',
        displayName: 'Ignored Rename',
        createdBy: OWNER_ID,
      });
      expect(deduped.id).toBe(created.id);

      const kindUpdated = await createTalkResourceBinding({
        ownerId: OWNER_ID,
        talkId,
        bindingKind: 'google_drive_file',
        externalId: 'folder-123',
        displayName: 'Project Docs File',
        createdBy: OWNER_ID,
      });
      expect(kindUpdated.id).not.toBe(created.id);
      expect(kindUpdated.bindingKind).toBe('google_drive_file');

      const list = await listTalkResourceBindings(talkId);
      expect(
        list.map((binding) => [binding.externalId, binding.bindingKind]).sort(),
      ).toEqual([
        ['folder-123', 'google_drive_file'],
        ['folder-123', 'google_drive_folder'],
      ]);

      const dbRows = await getDbPg()<
        Array<{
          service: string;
          target: string | null;
          surface: string | null;
        }>
      >`
        select c.service, cb.target, cb.meta_json->>'compatSurface' as surface
        from public.connector_bindings cb
        join public.connectors c
          on c.workspace_id = cb.workspace_id
         and c.id = cb.connector_id
        where cb.id = ${created.id}::uuid
      `;
      expect(dbRows[0]).toEqual({
        service: 'gdrive',
        target: 'folder-123',
        surface: 'talk_resource',
      });

      expect(await deleteTalkResourceBinding(talkId, created.id)).toBe(true);
      expect(await listTalkResourceBindings(talkId)).toHaveLength(1);
      expect(await deleteTalkResourceBinding(talkId, kindUpdated.id)).toBe(
        true,
      );
      expect(await listTalkResourceBindings(talkId)).toEqual([]);
    });
  });

  it('allows distinct target bindings and one row per editor for the same target', async () => {
    const { talkId } = await createFixture({ talkCreatorId: MEMBER_ID });

    const memberShared = await withUserContext(MEMBER_ID, () =>
      createTalkResourceBinding({
        ownerId: MEMBER_ID,
        talkId,
        bindingKind: 'google_drive_file',
        externalId: 'shared-file',
        displayName: 'Member Shared File',
        createdBy: MEMBER_ID,
      }),
    );
    const memberDistinct = await withUserContext(MEMBER_ID, () =>
      createTalkResourceBinding({
        ownerId: MEMBER_ID,
        talkId,
        bindingKind: 'google_drive_file',
        externalId: 'distinct-file',
        displayName: 'Distinct File',
        createdBy: MEMBER_ID,
      }),
    );
    const ownerShared = await withUserContext(OWNER_ID, () =>
      createTalkResourceBinding({
        ownerId: OWNER_ID,
        talkId,
        bindingKind: 'google_drive_file',
        externalId: 'shared-file',
        displayName: 'Owner Shared File',
        createdBy: OWNER_ID,
      }),
    );

    expect(memberDistinct.id).not.toBe(memberShared.id);
    expect(ownerShared.id).not.toBe(memberShared.id);

    const bindings = await withUserContext(MEMBER_ID, () =>
      listTalkResourceBindings(talkId),
    );
    expect(
      bindings
        .map((binding) => [
          binding.externalId,
          binding.bindingKind,
          binding.createdBy,
        ])
        .sort(),
    ).toEqual([
      ['distinct-file', 'google_drive_file', MEMBER_ID],
      ['shared-file', 'google_drive_file', OWNER_ID],
      ['shared-file', 'google_drive_file', MEMBER_ID],
    ]);
  });

  it('blocks workspace members who cannot edit the Talk from writing resources', async () => {
    const { talkId } = await createFixture();
    const ownerBinding = await withUserContext(OWNER_ID, () =>
      createTalkResourceBinding({
        ownerId: OWNER_ID,
        talkId,
        bindingKind: 'google_drive_file',
        externalId: 'owner-file',
        displayName: 'Owner File',
        createdBy: OWNER_ID,
      }),
    );

    await withUserContext(MEMBER_ID, async () => {
      await expect(
        createTalkResourceBinding({
          ownerId: MEMBER_ID,
          talkId,
          bindingKind: 'google_drive_file',
          externalId: 'file-1',
          displayName: 'Member File',
          createdBy: MEMBER_ID,
        }),
      ).rejects.toThrow(/cannot edit/);

      await expect(
        createTalkResourceBinding({
          ownerId: OWNER_ID,
          talkId,
          bindingKind: 'google_drive_file',
          externalId: 'file-2',
          displayName: 'Spoofed Owner File',
          createdBy: OWNER_ID,
        }),
      ).rejects.toThrow(/owner must match current user/);

      expect(await deleteTalkResourceBinding(talkId, ownerBinding.id)).toBe(
        false,
      );
    });
    expect(
      await withUserContext(OWNER_ID, () => listTalkResourceBindings(talkId)),
    ).toHaveLength(1);
  });

  it('blocks guest talk creators from trusted resource and tool writes', async () => {
    const { workspaceId, talkId } = await createFixture({
      talkCreatorId: MEMBER_ID,
    });
    await getDbPg()`
      update public.workspace_members
      set role = 'guest'
      where workspace_id = ${workspaceId}::uuid
        and user_id = ${MEMBER_ID}::uuid
    `;

    await withUserContext(MEMBER_ID, async () => {
      await expect(
        createTalkResourceBinding({
          ownerId: MEMBER_ID,
          talkId,
          bindingKind: 'google_drive_file',
          externalId: 'guest-file',
          displayName: 'Guest File',
          createdBy: MEMBER_ID,
        }),
      ).rejects.toThrow(/cannot edit/);

      expect(
        await deleteTalkResourceBinding(
          talkId,
          '00000000-0000-0000-0000-000000000000',
        ),
      ).toBe(false);

      await expect(setTalkActiveTool(talkId, 'web', true)).rejects.toThrow(
        /cannot edit/,
      );
    });
  });

  it('stores Google tool credentials in connectors and connector_secrets', async () => {
    const { workspaceId } = await createFixture();

    await withUserContext(OWNER_ID, async () => {
      const first = await upsertUserGoogleCredential({
        workspaceId,
        userId: OWNER_ID,
        googleSubject: 'sub-1',
        email: 'owner@gmail.com',
        displayName: 'Owner Google',
        scopes: ['drive.readonly', 'documents', 'drive.readonly'],
        ciphertext: 'cipher-v1',
        accessExpiresAt: '2030-01-01T00:00:00.000Z',
      });
      expect(first.scopes).toEqual(['documents', 'drive.readonly']);
      expect(first.ciphertext).toBe('cipher-v1');

      const updated = await upsertUserGoogleCredential({
        workspaceId,
        userId: OWNER_ID,
        googleSubject: 'sub-1',
        email: 'owner@gmail.com',
        scopes: ['spreadsheets.readonly', 'drive.readonly', 'gmail.readonly'],
        ciphertext: 'cipher-v2',
      });
      expect(updated.ciphertext).toBe('cipher-v2');
      expect(updated.scopes).toEqual([
        'drive.readonly',
        'gmail.readonly',
        'spreadsheets.readonly',
      ]);

      expect(await getUserGoogleCredential({ workspaceId })).toMatchObject({
        userId: OWNER_ID,
        googleSubject: 'sub-1',
        email: 'owner@gmail.com',
        ciphertext: 'cipher-v2',
      });
    });

    await withUserContext(MEMBER_ID, async () => {
      const member = await upsertUserGoogleCredential({
        workspaceId,
        userId: MEMBER_ID,
        googleSubject: 'member-sub',
        email: 'member@gmail.com',
        displayName: 'Member Google',
        scopes: ['drive.readonly'],
        ciphertext: 'member-cipher',
      });
      expect(member).toMatchObject({
        userId: MEMBER_ID,
        googleSubject: 'member-sub',
        email: 'member@gmail.com',
        ciphertext: 'member-cipher',
      });
    });

    const rows = await getDbPg()<
      Array<{
        connector_count: string;
        secret_count: string;
        services: string[];
        surfaces: string[];
        ciphertexts: string[];
      }>
    >`
      select
        count(distinct c.id)::text as connector_count,
        count(distinct cs.id)::text as secret_count,
        array_agg(distinct c.service order by c.service) as services,
        array_agg(distinct c.config_json->>'compatSurface' order by c.config_json->>'compatSurface') as surfaces,
        array_agg(cs.ciphertext order by cs.ciphertext) as ciphertexts
      from public.connectors c
      join public.connector_secrets cs
        on cs.workspace_id = c.workspace_id
       and cs.id = c.secret_ref
      where c.workspace_id = ${workspaceId}::uuid
        and c.service in ('gdrive', 'gmail')
        and c.config_json->>'compatSurface' = 'google_tools'
    `;
    expect(rows[0]).toEqual({
      connector_count: '3',
      secret_count: '2',
      services: ['gdrive', 'gmail'],
      surfaces: ['google_tools'],
      ciphertexts: ['cipher-v2', 'cipher-v2', 'member-cipher'],
    });

    await withUserContext(OWNER_ID, async () => {
      expect(await getUserGoogleCredential({ workspaceId })).toMatchObject({
        userId: OWNER_ID,
        email: 'owner@gmail.com',
        ciphertext: 'cipher-v2',
      });
      const ownerSecretRows = await getDbPg()<Array<{ secret_ref: string }>>`
        select distinct secret_ref::text
        from public.connectors
        where workspace_id = ${workspaceId}::uuid
          and service in ('gdrive', 'gmail')
          and config_json->>'compatSurface' = 'google_tools'
          and config_json->>'authorizedByUserId' = ${OWNER_ID}
          and secret_ref is not null
      `;
      expect(ownerSecretRows).toHaveLength(1);
      const ownerSecretRef = ownerSecretRows[0]!.secret_ref;
      expect(await deleteUserGoogleCredential({ workspaceId })).toBe(true);
      expect(await getUserGoogleCredential({ workspaceId })).toBeUndefined();

      const ownerSecretAfterDelete = await getDbPg()<Array<{ count: string }>>`
        select count(*)::text as count
        from public.connector_secrets
        where workspace_id = ${workspaceId}::uuid
          and id = ${ownerSecretRef}::uuid
      `;
      expect(ownerSecretAfterDelete[0]?.count).toBe('0');
    });

    const ownerRowsAfterDelete = await getDbPg()<Array<{ count: string }>>`
      select count(*)::text as count
      from public.connectors
      where workspace_id = ${workspaceId}::uuid
        and service in ('gdrive', 'gmail')
        and config_json->>'compatSurface' = 'google_tools'
        and config_json->>'authorizedByUserId' = ${OWNER_ID}
    `;
    expect(ownerRowsAfterDelete[0]?.count).toBe('0');

    await withUserContext(MEMBER_ID, async () => {
      expect(await getUserGoogleCredential({ workspaceId })).toMatchObject({
        userId: MEMBER_ID,
        email: 'member@gmail.com',
        ciphertext: 'member-cipher',
      });
      expect(await deleteUserGoogleCredential({ workspaceId })).toBe(true);
      expect(await getUserGoogleCredential({ workspaceId })).toBeUndefined();
    });
  });

  it('rejects Google credential writes attributed to another user', async () => {
    const { workspaceId } = await createFixture();

    await expect(
      withUserContext(MEMBER_ID, () =>
        upsertUserGoogleCredential({
          workspaceId,
          userId: OWNER_ID,
          googleSubject: 'spoofed-owner-sub',
          email: 'owner@gmail.com',
          scopes: ['drive.readonly'],
          ciphertext: 'spoofed-cipher',
        }),
      ),
    ).rejects.toThrow(/user mismatch/);
  });

  it('prevents workspace admins from reassigning another user Google tools connector through RLS', async () => {
    const { workspaceId } = await createFixture();
    const db = getDbPg();
    await db`
      update public.workspace_members
      set role = 'admin'
      where workspace_id = ${workspaceId}::uuid
        and user_id = ${MEMBER_ID}::uuid
    `;

    await withUserContext(OWNER_ID, async () => {
      await upsertUserGoogleCredential({
        workspaceId,
        userId: OWNER_ID,
        googleSubject: 'owner-sub',
        email: 'owner@gmail.com',
        scopes: ['drive.readonly'],
        ciphertext: 'owner-cipher',
      });
    });

    const ownerConnectors = await db<Array<{ id: string }>>`
      select id
      from public.connectors
      where workspace_id = ${workspaceId}::uuid
        and service = 'gdrive'
        and config_json->>'compatSurface' = 'google_tools'
        and config_json->>'authorizedByUserId' = ${OWNER_ID}
      limit 1
    `;
    const ownerConnectorId = ownerConnectors[0]?.id;
    expect(ownerConnectorId).toBeTruthy();

    await withUserContext(MEMBER_ID, async () => {
      const userDb = getDbPg();
      const reassigned = await userDb`
        update public.connectors
        set config_json = jsonb_set(
              config_json,
              '{authorizedByUserId}',
              to_jsonb(${MEMBER_ID}::text),
              true
            )
        where id = ${ownerConnectorId}::uuid
      `;
      expect(reassigned.count).toBe(0);

      const deleted = await userDb`
        delete from public.connectors
        where id = ${ownerConnectorId}::uuid
      `;
      expect(deleted.count).toBe(0);
    });

    await withUserContext(OWNER_ID, async () => {
      expect(await getUserGoogleCredential({ workspaceId })).toMatchObject({
        userId: OWNER_ID,
        ciphertext: 'owner-cipher',
      });
    });
    await withUserContext(MEMBER_ID, async () => {
      expect(await getUserGoogleCredential({ workspaceId })).toBeUndefined();
    });
  });

  it('requires explicit workspace scope for Google credential reads, writes, and deletes', async () => {
    await createFixture();
    const secondaryWorkspaceId =
      await ensureWorkspaceBootstrapForUser(MEMBER_ID);
    await getDbPg()`
      insert into public.workspace_members (workspace_id, user_id, role)
      values (${secondaryWorkspaceId}::uuid, ${OWNER_ID}::uuid, 'member')
      on conflict (workspace_id, user_id) do update set role = excluded.role
    `;

    await withUserContext(OWNER_ID, async () => {
      await expect(
        upsertUserGoogleCredential({
          workspaceId: null as unknown as string,
          userId: OWNER_ID,
          googleSubject: 'missing-workspace-sub',
          email: 'missing-workspace@gmail.com',
          scopes: ['drive.readonly'],
          ciphertext: 'missing-workspace-cipher',
        }),
      ).rejects.toThrow(/workspaceId is required/);

      await upsertUserGoogleCredential({
        workspaceId: secondaryWorkspaceId,
        userId: OWNER_ID,
        googleSubject: 'secondary-sub',
        email: 'secondary@gmail.com',
        scopes: ['drive.readonly'],
        ciphertext: 'secondary-cipher',
      });

      expect(
        await getUserGoogleCredential({ workspaceId: null }),
      ).toBeUndefined();
      expect(await deleteUserGoogleCredential({ workspaceId: null })).toBe(
        false,
      );
      expect(
        await getUserGoogleCredential({ workspaceId: secondaryWorkspaceId }),
      ).toMatchObject({
        email: 'secondary@gmail.com',
        ciphertext: 'secondary-cipher',
      });
      expect(
        await deleteUserGoogleCredential({ workspaceId: secondaryWorkspaceId }),
      ).toBe(true);
      expect(
        await getUserGoogleCredential({ workspaceId: secondaryWorkspaceId }),
      ).toBeUndefined();
    });

    const secretRows = await getDbPg()<Array<{ count: string }>>`
      select count(*)::text as count
      from public.connector_secrets
      where workspace_id = ${secondaryWorkspaceId}::uuid
    `;
    expect(secretRows[0]?.count).toBe('0');
  });

  it('rejects Google credentials that have only OIDC scopes', async () => {
    const { workspaceId } = await createFixture();

    await withUserContext(OWNER_ID, async () => {
      await expect(
        upsertUserGoogleCredential({
          workspaceId,
          userId: OWNER_ID,
          googleSubject: 'oidc-only-sub',
          email: 'owner@gmail.com',
          scopes: ['openid', 'email', 'profile'],
          ciphertext: 'oidc-only-cipher',
        }),
      ).rejects.toThrow(/Google tool scope/);
    });

    const rows = await getDbPg()<Array<{ count: string }>>`
      select count(*)::text as count
      from public.connectors
      where workspace_id = ${workspaceId}::uuid
        and service in ('gdrive', 'gmail')
        and config_json->>'compatSurface' = 'google_tools'
    `;
    expect(rows[0]?.count).toBe('0');
  });

  it('sets and reads active tool families on greenfield talks', async () => {
    const { talkId } = await createFixture();

    await withUserContext(OWNER_ID, async () => {
      expect(await getTalkActiveTools(talkId)).toEqual({});
      await expect(
        setTalkActiveTool('00000000-0000-0000-0000-000000000000', 'web', true),
      ).rejects.toThrow(/not found/);

      expect(await setTalkActiveTool(talkId, 'web', true)).toEqual({
        web: true,
      });
      expect(await setTalkActiveTool(talkId, 'google_read', true)).toEqual({
        web: true,
        google_read: true,
      });

      const enabledRows = await getDbPg()<
        Array<{ tool_id: string; enabled: boolean }>
      >`
        select tool_id, enabled
        from public.talk_tools
        where talk_id = ${talkId}::uuid
        order by tool_id asc
      `;
      const effective = buildEffectiveToolsFromTalkToolRows(enabledRows);
      expect(
        effective.find((entry) => entry.toolFamily === 'google_read'),
      ).toMatchObject({
        enabled: true,
        runtimeTools: expect.arrayContaining(['google_drive_read']),
      });

      expect(await setTalkActiveTool(talkId, 'web', false)).toEqual({
        web: false,
        google_read: true,
      });
      const persisted = await getDbPg()<
        Array<{ tool_id: string; enabled: boolean }>
      >`
        select tool_id, enabled
        from public.talk_tools
        where talk_id = ${talkId}::uuid
        order by tool_id asc
      `;
      expect(persisted).toEqual([
        { tool_id: 'gdrive-read', enabled: true },
        { tool_id: 'news-monitor', enabled: false },
        { tool_id: 'web-fetch', enabled: false },
        { tool_id: 'web-search', enabled: false },
      ]);
    });

    await expect(
      withUserContext(MEMBER_ID, () => setTalkActiveTool(talkId, 'web', true)),
    ).rejects.toThrow(/cannot edit/);
  });

  it('normalizes legacy and canonical active tool family keys', async () => {
    const { talkId } = await createFixture();

    await withUserContext(OWNER_ID, async () => {
      expect(await setTalkActiveTool(talkId, 'data_connectors', true)).toEqual({
        connectors: true,
      });
      expect(await setTalkActiveTool(talkId, 'google_drive', true)).toEqual({
        connectors: true,
        google_read: true,
      });
      expect(await setTalkActiveTool(talkId, 'google_docs', false)).toEqual({
        connectors: true,
        google_read: false,
      });
      expect(await setTalkActiveTool(talkId, 'gmail', true)).toMatchObject({
        connectors: true,
        google_read: false,
        gmail_read: true,
      });
      expect(await setTalkActiveTool(talkId, 'gmail-send', true)).toMatchObject(
        {
          gmail_send: true,
        },
      );
    });
  });

  it('lets a member creator persist active tool changes', async () => {
    const { talkId } = await createFixture({ talkCreatorId: MEMBER_ID });

    await expect(
      withUserContext(MEMBER_ID, () => setTalkActiveTool(talkId, 'web', true)),
    ).resolves.toEqual({ web: true });

    const rows = await getDbPg()<Array<{ tool_id: string; enabled: boolean }>>`
      select tool_id, enabled
      from public.talk_tools
      where talk_id = ${talkId}::uuid
      order by tool_id asc
    `;
    expect(rows).toEqual([
      { tool_id: 'news-monitor', enabled: true },
      { tool_id: 'web-fetch', enabled: true },
      { tool_id: 'web-search', enabled: true },
    ]);
  });
});
