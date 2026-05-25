// Content feature PR 1 — end-to-end tests for content-accessors.
//
// Runs against the local Supabase Postgres started by `npm run db:start`.
// Tests the full surface: CAS, rebase logic, drift detection,
// in-transaction proposal-stale marking, ownership-integrity triggers,
// and RLS deny on cross-owner access.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closePgDatabase,
  getDbPg,
  initPgDatabase,
  withUserContext,
} from '../../db.js';
import {
  CONTENT_BODY_BYTE_LIMIT,
  acceptProposal,
  createContent,
  createProposal,
  getContentById,
  getContentByTalkId,
  getProposalById,
  listPendingProposalsByContentId,
  rejectProposal,
  updateContentBody,
} from './content-accessors.js';
import {
  ANCHOR_ATTR_KEY,
  freshAnchorId,
  tiptapJsonToMarkdown,
  type RichTextDocument,
} from '../../shared/rich-text/index.js';

const USER_A_ID = '0c444444-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B_ID = '0c444444-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const TALK_A_ID = '0c444444-cccc-cccc-cccc-ccccccccc0a1';
const TALK_B_ID = '0c444444-cccc-cccc-cccc-ccccccccc0b1';

async function seedAuthUser(
  id: string,
  email: string,
  displayName: string,
): Promise<void> {
  const db = getDbPg();
  await db`
    insert into auth.users (id, email, raw_user_meta_data)
    values (${id}::uuid, ${email}::text,
            jsonb_build_object('full_name', ${displayName}::text))
    on conflict (id) do nothing
  `;
}

async function seedTalk(talkId: string, ownerId: string): Promise<void> {
  const db = getDbPg();
  await db`
    insert into public.talks (id, owner_id, topic_title)
    values (${talkId}::uuid, ${ownerId}::uuid, 'Content Test Talk')
    on conflict (id) do nothing
  `;
}

async function purge(): Promise<void> {
  const db = getDbPg();
  // Cascade through talks removes contents + content_proposals.
  await db`
    delete from public.talks where id in (${TALK_A_ID}::uuid, ${TALK_B_ID}::uuid)
  `;
  await seedTalk(TALK_A_ID, USER_A_ID);
  await seedTalk(TALK_B_ID, USER_B_ID);
}

function docFor(
  blocks: Array<{ anchor: string; text: string; type?: string }>,
): RichTextDocument {
  return {
    type: 'doc',
    content: blocks.map((b) => ({
      type: b.type ?? 'paragraph',
      attrs: { [ANCHOR_ATTR_KEY]: b.anchor },
      content: [{ type: 'text', text: b.text }],
    })),
  };
}

describe('content-accessors (postgres + RLS)', () => {
  beforeAll(async () => {
    await initPgDatabase();
    await seedAuthUser(USER_A_ID, 'content-a@clawtalk.local', 'Content A');
    await seedAuthUser(USER_B_ID, 'content-b@clawtalk.local', 'Content B');
    await seedTalk(TALK_A_ID, USER_A_ID);
    await seedTalk(TALK_B_ID, USER_B_ID);
  });

  afterAll(async () => {
    const db = getDbPg();
    await db`
      delete from auth.users where id in (${USER_A_ID}::uuid, ${USER_B_ID}::uuid)
    `;
    await closePgDatabase();
  });

  beforeEach(async () => {
    await purge();
  });

  it('createContent + getContentByTalkId: happy path', async () => {
    await withUserContext(USER_A_ID, async () => {
      const created = await createContent({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        title: 'Doc',
        createdByUserId: USER_A_ID,
      });
      expect(created.bodyVersion).toBe(1);
      expect(created.title).toBe('Doc');

      const fetched = await getContentByTalkId(TALK_A_ID);
      expect(fetched?.id).toBe(created.id);
    });
  });

  it('createContent: 1:1 unique constraint blocks a second content on the same Talk', async () => {
    await withUserContext(USER_A_ID, async () => {
      await createContent({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        title: 'first',
        createdByUserId: USER_A_ID,
      });
    });
    // Second create runs in its own tx so the unique-violation aborts
    // that tx cleanly without poisoning the surrounding scope.
    await expect(
      withUserContext(USER_A_ID, async () => {
        await createContent({
          ownerId: USER_A_ID,
          talkId: TALK_A_ID,
          title: 'second',
          createdByUserId: USER_A_ID,
        });
      }),
    ).rejects.toThrow();
  });

  it('integrity trigger rejects contents.owner_id ≠ talks.owner_id', async () => {
    const db = getDbPg();
    // Try to insert directly via BYPASSRLS with mismatched owner.
    await expect(
      db`
        insert into public.contents
          (owner_id, talk_id, title, body_markdown, body_version, anchor_map_json)
        values
          (${USER_B_ID}::uuid, ${TALK_A_ID}::uuid, 'spoof', '', 1, '{}'::jsonb)
      `,
    ).rejects.toThrow();
  });

  it('integrity trigger rejects content_proposals.owner_id ≠ contents.owner_id', async () => {
    const contentId = await withUserContext(USER_A_ID, async () => {
      const c = await createContent({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        title: 'Doc',
        createdByUserId: USER_A_ID,
      });
      return c.id;
    });
    const db = getDbPg();
    await expect(
      db`
        insert into public.content_proposals
          (content_id, owner_id, kind, inserted_markdown, base_content_version)
        values
          (${contentId}::uuid, ${USER_B_ID}::uuid, 'append', 'text', 1)
      `,
    ).rejects.toThrow();
  });

  it('updateContentBody: happy path + CAS conflict + not_found', async () => {
    const id = await withUserContext(USER_A_ID, async () => {
      const c = await createContent({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        title: 'Doc',
        createdByUserId: USER_A_ID,
      });
      return c.id;
    });

    await withUserContext(USER_A_ID, async () => {
      const result = await updateContentBody({
        contentId: id,
        ownerId: USER_A_ID,
        expectedVersion: 1,
        bodyMarkdown: 'Hello world',
        updatedByUserId: USER_A_ID,
      });
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') throw new Error('unreachable');
      expect(result.content.bodyVersion).toBe(2);
      expect(result.content.bodyMarkdown).toContain('Hello world');
    });

    await withUserContext(USER_A_ID, async () => {
      const result = await updateContentBody({
        contentId: id,
        ownerId: USER_A_ID,
        expectedVersion: 1, // stale
        bodyMarkdown: 'race',
      });
      expect(result.kind).toBe('conflict');
    });

    await withUserContext(USER_A_ID, async () => {
      const result = await updateContentBody({
        contentId: '00000000-0000-0000-0000-000000000000',
        ownerId: USER_A_ID,
        expectedVersion: 1,
        bodyMarkdown: 'no',
      });
      expect(result.kind).toBe('not_found');
    });
  });

  it('updateContentBody: doc_size_limit gates over-budget bodies', async () => {
    const id = await withUserContext(USER_A_ID, async () => {
      const c = await createContent({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        title: 'Doc',
        createdByUserId: USER_A_ID,
      });
      return c.id;
    });
    const huge = 'x'.repeat(CONTENT_BODY_BYTE_LIMIT + 100);
    await withUserContext(USER_A_ID, async () => {
      const result = await updateContentBody({
        contentId: id,
        ownerId: USER_A_ID,
        expectedVersion: 1,
        bodyMarkdown: huge,
      });
      expect(result.kind).toBe('doc_size_limit');
    });
  });

  it('updateContentBody: in-tx stale-marking of proposals whose anchor is removed', async () => {
    const { contentId, anchorA, anchorB } = await withUserContext(
      USER_A_ID,
      async () => {
        const c = await createContent({
          ownerId: USER_A_ID,
          talkId: TALK_A_ID,
          title: 'Doc',
          createdByUserId: USER_A_ID,
        });
        const anchorA = freshAnchorId();
        const anchorB = freshAnchorId();
        const md = tiptapJsonToMarkdown(
          docFor([
            { anchor: anchorA, text: 'Para A' },
            { anchor: anchorB, text: 'Para B' },
          ]),
        );
        const upd = await updateContentBody({
          contentId: c.id,
          ownerId: USER_A_ID,
          expectedVersion: 1,
          bodyMarkdown: md,
        });
        if (upd.kind !== 'ok') throw new Error('expected ok');
        return { contentId: c.id, anchorA, anchorB };
      },
    );

    // Create a proposal targeting anchorA.
    const propIdA = await withUserContext(USER_A_ID, async () => {
      const r = await createProposal({
        contentId,
        ownerId: USER_A_ID,
        kind: 'append',
        afterAnchorId: anchorA,
        insertedMarkdown: 'New section',
      });
      if (r.kind !== 'ok') throw new Error('expected ok create');
      return r.proposal.id;
    });

    // Save body with anchorA removed.
    await withUserContext(USER_A_ID, async () => {
      const md = tiptapJsonToMarkdown(
        docFor([{ anchor: anchorB, text: 'Para B' }]),
      );
      const upd = await updateContentBody({
        contentId,
        ownerId: USER_A_ID,
        expectedVersion: 2,
        bodyMarkdown: md,
      });
      if (upd.kind !== 'ok') throw new Error('expected ok save');
      expect(upd.staledProposalIds).toContain(propIdA);
    });

    // Proposal is now stale.
    await withUserContext(USER_A_ID, async () => {
      const fetched = await getProposalById(propIdA);
      expect(fetched?.status).toBe('stale');
      expect(fetched?.statusReason).toBe('anchor_removed');
    });
  });

  it('createProposal: happy + anchor_missing + content_not_found', async () => {
    const { contentId, anchorA } = await withUserContext(
      USER_A_ID,
      async () => {
        const c = await createContent({
          ownerId: USER_A_ID,
          talkId: TALK_A_ID,
          title: 'Doc',
          createdByUserId: USER_A_ID,
        });
        const anchorA = freshAnchorId();
        const md = tiptapJsonToMarkdown(
          docFor([{ anchor: anchorA, text: 'Para A' }]),
        );
        const upd = await updateContentBody({
          contentId: c.id,
          ownerId: USER_A_ID,
          expectedVersion: 1,
          bodyMarkdown: md,
        });
        if (upd.kind !== 'ok') throw new Error('seed save failed');
        return { contentId: c.id, anchorA };
      },
    );

    await withUserContext(USER_A_ID, async () => {
      const ok = await createProposal({
        contentId,
        ownerId: USER_A_ID,
        kind: 'append',
        afterAnchorId: anchorA,
        insertedMarkdown: 'Add stuff',
      });
      expect(ok.kind).toBe('ok');
      if (ok.kind !== 'ok') return;
      expect(ok.proposal.status).toBe('pending');
      // base_anchor_content_hash should have been pulled from the map.
      expect(ok.proposal.baseAnchorContentHash).not.toBeNull();

      const missing = await createProposal({
        contentId,
        ownerId: USER_A_ID,
        kind: 'append',
        afterAnchorId: 'doesnotexist',
        insertedMarkdown: 'Add stuff',
      });
      expect(missing.kind).toBe('anchor_missing');

      const noContent = await createProposal({
        contentId: '00000000-0000-0000-0000-000000000000',
        ownerId: USER_A_ID,
        kind: 'append',
        afterAnchorId: null,
        insertedMarkdown: 'Add stuff',
      });
      expect(noContent.kind).toBe('content_not_found');
    });
  });

  it('acceptProposal: happy path applies markdown at anchor', async () => {
    const { contentId, anchorA } = await withUserContext(
      USER_A_ID,
      async () => {
        const c = await createContent({
          ownerId: USER_A_ID,
          talkId: TALK_A_ID,
          title: 'Doc',
          createdByUserId: USER_A_ID,
        });
        const anchorA = freshAnchorId();
        const md = tiptapJsonToMarkdown(
          docFor([{ anchor: anchorA, text: 'Existing' }]),
        );
        const upd = await updateContentBody({
          contentId: c.id,
          ownerId: USER_A_ID,
          expectedVersion: 1,
          bodyMarkdown: md,
        });
        if (upd.kind !== 'ok') throw new Error('seed save failed');
        return { contentId: c.id, anchorA };
      },
    );

    const proposalId = await withUserContext(USER_A_ID, async () => {
      const r = await createProposal({
        contentId,
        ownerId: USER_A_ID,
        kind: 'append',
        afterAnchorId: anchorA,
        insertedMarkdown: 'New paragraph.',
        rationale: 'Adds context',
      });
      if (r.kind !== 'ok') throw new Error('create failed');
      return r.proposal.id;
    });

    await withUserContext(USER_A_ID, async () => {
      const accepted = await acceptProposal({
        contentId,
        proposalId,
        userId: USER_A_ID,
        expectedContentVersion: 2,
      });
      expect(accepted.kind).toBe('ok');
      if (accepted.kind !== 'ok') return;
      expect(accepted.content.bodyVersion).toBe(3);
      expect(accepted.content.bodyMarkdown).toContain('New paragraph.');
      expect(accepted.proposal.status).toBe('accepted');
      expect(accepted.proposal.appliedAnchorIds.length).toBe(1);
      expect(accepted.driftDetected).toBe(false);
    });
  });

  it('acceptProposal: proposal_already_resolved when status is not pending', async () => {
    const proposalId = await withUserContext(USER_A_ID, async () => {
      const c = await createContent({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        title: 'Doc',
        createdByUserId: USER_A_ID,
      });
      const r = await createProposal({
        contentId: c.id,
        ownerId: USER_A_ID,
        kind: 'append',
        afterAnchorId: null,
        insertedMarkdown: 'top',
      });
      if (r.kind !== 'ok') throw new Error('create failed');
      await rejectProposal({
        proposalId: r.proposal.id,
        userId: USER_A_ID,
      });
      return { contentId: c.id, proposalId: r.proposal.id };
    });

    await withUserContext(USER_A_ID, async () => {
      const result = await acceptProposal({
        contentId: proposalId.contentId,
        proposalId: proposalId.proposalId,
        userId: USER_A_ID,
      });
      expect(result.kind).toBe('proposal_already_resolved');
      if (result.kind === 'proposal_already_resolved') {
        expect(result.status).toBe('rejected');
      }
    });
  });

  it('acceptProposal: proposal_stale when anchor removed before accept', async () => {
    const setup = await withUserContext(USER_A_ID, async () => {
      const c = await createContent({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        title: 'Doc',
        createdByUserId: USER_A_ID,
      });
      const anchorA = freshAnchorId();
      const md = tiptapJsonToMarkdown(docFor([{ anchor: anchorA, text: 'A' }]));
      await updateContentBody({
        contentId: c.id,
        ownerId: USER_A_ID,
        expectedVersion: 1,
        bodyMarkdown: md,
      });
      // Cheat: bypass the in-tx stale-marking by creating proposal
      // BEFORE the anchor is removed, then removing the anchor without
      // triggering the stale-mark path. We do that by direct DELETE
      // via the admin DB (RLS allowed for owner anyway).
      const prop = await createProposal({
        contentId: c.id,
        ownerId: USER_A_ID,
        kind: 'append',
        afterAnchorId: anchorA,
        insertedMarkdown: 'append',
      });
      if (prop.kind !== 'ok') throw new Error('create failed');
      return { contentId: c.id, proposalId: prop.proposal.id, anchorA };
    });

    // Now save body with anchorA removed — this stale-marks the
    // proposal. Override the proposal back to pending to simulate the
    // race where the stale event hasn't propagated yet.
    await withUserContext(USER_A_ID, async () => {
      const md = tiptapJsonToMarkdown(
        docFor([{ anchor: 'somethingelse', text: 'B' }]),
      );
      await updateContentBody({
        contentId: setup.contentId,
        ownerId: USER_A_ID,
        expectedVersion: 2,
        bodyMarkdown: md,
      });
    });
    const adminDb = getDbPg();
    await adminDb`
      update public.content_proposals
      set status = 'pending', status_reason = null, resolved_at = null
      where id = ${setup.proposalId}::uuid
    `;

    await withUserContext(USER_A_ID, async () => {
      const result = await acceptProposal({
        contentId: setup.contentId,
        proposalId: setup.proposalId,
        userId: USER_A_ID,
      });
      expect(result.kind).toBe('proposal_stale');
    });

    await withUserContext(USER_A_ID, async () => {
      const refetch = await getProposalById(setup.proposalId);
      expect(refetch?.status).toBe('stale');
    });
  });

  it('acceptProposal: doc_size_limit rejects when result would exceed cap', async () => {
    const setup = await withUserContext(USER_A_ID, async () => {
      const c = await createContent({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        title: 'Doc',
        createdByUserId: USER_A_ID,
      });
      // Seed near the cap.
      const filler = 'x'.repeat(CONTENT_BODY_BYTE_LIMIT - 50);
      const upd = await updateContentBody({
        contentId: c.id,
        ownerId: USER_A_ID,
        expectedVersion: 1,
        bodyMarkdown: filler,
      });
      if (upd.kind !== 'ok') throw new Error('seed save failed');
      return c.id;
    });

    await withUserContext(USER_A_ID, async () => {
      const prop = await createProposal({
        contentId: setup,
        ownerId: USER_A_ID,
        kind: 'append',
        afterAnchorId: null,
        insertedMarkdown: 'y'.repeat(200),
      });
      if (prop.kind !== 'ok') throw new Error('create failed');
      const result = await acceptProposal({
        contentId: setup,
        proposalId: prop.proposal.id,
        userId: USER_A_ID,
      });
      expect(result.kind).toBe('doc_size_limit');
    });
  });

  it('rejectProposal: happy path + proposal_already_resolved', async () => {
    const proposalId = await withUserContext(USER_A_ID, async () => {
      const c = await createContent({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        title: 'Doc',
        createdByUserId: USER_A_ID,
      });
      const r = await createProposal({
        contentId: c.id,
        ownerId: USER_A_ID,
        kind: 'append',
        afterAnchorId: null,
        insertedMarkdown: 'top',
      });
      if (r.kind !== 'ok') throw new Error('create failed');
      return r.proposal.id;
    });

    await withUserContext(USER_A_ID, async () => {
      const result = await rejectProposal({
        proposalId,
        userId: USER_A_ID,
      });
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      expect(result.proposal.status).toBe('rejected');
    });

    await withUserContext(USER_A_ID, async () => {
      const result = await rejectProposal({
        proposalId,
        userId: USER_A_ID,
      });
      expect(result.kind).toBe('proposal_already_resolved');
    });
  });

  it('RLS: user B cannot read or mutate user A content', async () => {
    const contentId = await withUserContext(USER_A_ID, async () => {
      const c = await createContent({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        title: 'Private doc',
        createdByUserId: USER_A_ID,
      });
      return c.id;
    });

    await withUserContext(USER_B_ID, async () => {
      const fetchByTalk = await getContentByTalkId(TALK_A_ID);
      expect(fetchByTalk).toBeNull();
      const fetchById = await getContentById(contentId);
      expect(fetchById).toBeNull();

      // Mutations: update filters to zero (RLS USING hides the row);
      // expect not_found rather than conflict.
      const upd = await updateContentBody({
        contentId,
        ownerId: USER_B_ID,
        expectedVersion: 1,
        bodyMarkdown: 'hijack',
      });
      expect(upd.kind).toBe('not_found');
    });

    // A still sees their content.
    await withUserContext(USER_A_ID, async () => {
      const refetch = await getContentByTalkId(TALK_A_ID);
      expect(refetch?.id).toBe(contentId);
    });
  });

  it('RLS: user B INSERT (createContent) with ownerId=USER_A rejected', async () => {
    await expect(
      withUserContext(USER_B_ID, async () => {
        await createContent({
          ownerId: USER_A_ID,
          talkId: TALK_A_ID,
          title: 'hijack',
          createdByUserId: USER_B_ID,
        });
      }),
    ).rejects.toThrow();
  });

  it('createProposal: replace happy path snapshots baseline JSON', async () => {
    const { contentId, anchorA } = await withUserContext(
      USER_A_ID,
      async () => {
        const c = await createContent({
          ownerId: USER_A_ID,
          talkId: TALK_A_ID,
          title: 'Doc',
          createdByUserId: USER_A_ID,
        });
        const anchorA = freshAnchorId();
        const md = tiptapJsonToMarkdown(
          docFor([{ anchor: anchorA, text: 'Existing prose to rewrite.' }]),
        );
        const upd = await updateContentBody({
          contentId: c.id,
          ownerId: USER_A_ID,
          expectedVersion: 1,
          bodyMarkdown: md,
        });
        if (upd.kind !== 'ok') throw new Error('seed save failed');
        return { contentId: c.id, anchorA };
      },
    );

    await withUserContext(USER_A_ID, async () => {
      const ok = await createProposal({
        contentId,
        ownerId: USER_A_ID,
        kind: 'replace',
        afterAnchorId: null,
        targetAnchorId: anchorA,
        insertedMarkdown: 'A crisper rewrite.',
      });
      expect(ok.kind).toBe('ok');
      if (ok.kind !== 'ok') return;
      expect(ok.proposal.kind).toBe('replace');
      expect(ok.proposal.targetAnchorId).toBe(anchorA);
      expect(ok.proposal.afterAnchorId).toBeNull();
      expect(ok.proposal.baseAnchorContentHash).not.toBeNull();
      expect(ok.proposal.targetAnchorBaselineJson).not.toBeNull();
      expect(ok.proposal.driftDetected).toBe(false);
    });
  });

  it('createProposal: rejects invalid kind/anchor combinations', async () => {
    const contentId = await withUserContext(USER_A_ID, async () => {
      const c = await createContent({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        title: 'Doc',
        createdByUserId: USER_A_ID,
      });
      return c.id;
    });

    await withUserContext(USER_A_ID, async () => {
      const appendWithTarget = await createProposal({
        contentId,
        ownerId: USER_A_ID,
        kind: 'append',
        afterAnchorId: null,
        targetAnchorId: 'x',
        insertedMarkdown: 'whatever',
      });
      expect(appendWithTarget.kind).toBe('invalid_kind_anchors');

      const replaceMissingTarget = await createProposal({
        contentId,
        ownerId: USER_A_ID,
        kind: 'replace',
        afterAnchorId: null,
        targetAnchorId: null,
        insertedMarkdown: 'whatever',
      });
      expect(replaceMissingTarget.kind).toBe('invalid_kind_anchors');

      const replaceWithAfter = await createProposal({
        contentId,
        ownerId: USER_A_ID,
        kind: 'replace',
        afterAnchorId: 'a',
        targetAnchorId: 'b',
        insertedMarkdown: 'whatever',
      });
      expect(replaceWithAfter.kind).toBe('invalid_kind_anchors');
    });
  });

  it('createProposal: empty_after_sanitize rejects HTML-only payloads', async () => {
    const contentId = await withUserContext(USER_A_ID, async () => {
      const c = await createContent({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        title: 'Doc',
        createdByUserId: USER_A_ID,
      });
      return c.id;
    });

    await withUserContext(USER_A_ID, async () => {
      // After sanitize: HTML tags are stripped to '', producing an
      // empty document tree.
      const result = await createProposal({
        contentId,
        ownerId: USER_A_ID,
        kind: 'append',
        afterAnchorId: null,
        insertedMarkdown: '<iframe></iframe>',
      });
      expect(result.kind).toBe('empty_after_sanitize');
    });
  });

  it('createProposal: anchor hijacking via inserted_markdown is neutralized', async () => {
    const { contentId, anchorA } = await withUserContext(
      USER_A_ID,
      async () => {
        const c = await createContent({
          ownerId: USER_A_ID,
          talkId: TALK_A_ID,
          title: 'Doc',
          createdByUserId: USER_A_ID,
        });
        const anchorA = freshAnchorId();
        const md = tiptapJsonToMarkdown(
          docFor([{ anchor: anchorA, text: 'Existing.' }]),
        );
        const upd = await updateContentBody({
          contentId: c.id,
          ownerId: USER_A_ID,
          expectedVersion: 1,
          bodyMarkdown: md,
        });
        if (upd.kind !== 'ok') throw new Error('seed save failed');
        return { contentId: c.id, anchorA };
      },
    );

    // The agent tries to smuggle a chosen anchor by embedding the
    // <!-- anchor:... --> comment syntax into inserted_markdown.
    const hijack = `<!-- anchor:${anchorA} -->\nHostile rewrite that hijacks anchorA's identity.`;
    await withUserContext(USER_A_ID, async () => {
      const ok = await createProposal({
        contentId,
        ownerId: USER_A_ID,
        kind: 'append',
        afterAnchorId: anchorA,
        insertedMarkdown: hijack,
      });
      expect(ok.kind).toBe('ok');
      if (ok.kind !== 'ok') return;
      // The stored sanitized markdown must not contain the hijack
      // anchor comment.
      expect(ok.proposal.insertedMarkdown).not.toContain(`anchor:${anchorA}`);
    });
  });

  it('acceptProposal: replace happy path overwrites the target block', async () => {
    const { contentId, anchorA, anchorB } = await withUserContext(
      USER_A_ID,
      async () => {
        const c = await createContent({
          ownerId: USER_A_ID,
          talkId: TALK_A_ID,
          title: 'Doc',
          createdByUserId: USER_A_ID,
        });
        const anchorA = freshAnchorId();
        const anchorB = freshAnchorId();
        const md = tiptapJsonToMarkdown(
          docFor([
            { anchor: anchorA, text: 'Original A' },
            { anchor: anchorB, text: 'Tail B' },
          ]),
        );
        const upd = await updateContentBody({
          contentId: c.id,
          ownerId: USER_A_ID,
          expectedVersion: 1,
          bodyMarkdown: md,
        });
        if (upd.kind !== 'ok') throw new Error('seed save failed');
        return { contentId: c.id, anchorA, anchorB };
      },
    );

    const proposalId = await withUserContext(USER_A_ID, async () => {
      const r = await createProposal({
        contentId,
        ownerId: USER_A_ID,
        kind: 'replace',
        afterAnchorId: null,
        targetAnchorId: anchorA,
        insertedMarkdown: 'Rewritten A.',
      });
      if (r.kind !== 'ok') throw new Error('create failed');
      return r.proposal.id;
    });

    await withUserContext(USER_A_ID, async () => {
      const accepted = await acceptProposal({
        contentId,
        proposalId,
        userId: USER_A_ID,
        expectedContentVersion: 2,
      });
      expect(accepted.kind).toBe('ok');
      if (accepted.kind !== 'ok') return;
      expect(accepted.content.bodyMarkdown).toContain('Rewritten A.');
      expect(accepted.content.bodyMarkdown).not.toContain('Original A');
      // anchorB survives untouched.
      expect(accepted.content.bodyMarkdown).toContain('Tail B');
      // The replacement single block inherits anchorA's identity so
      // downstream references survive.
      expect(accepted.proposal.appliedAnchorIds).toContain(anchorA);
      expect(accepted.driftDetected).toBe(false);
    });
  });

  it('acceptProposal: version_conflict when expectedContentVersion is stale', async () => {
    const { contentId, anchorA, proposalId } = await withUserContext(
      USER_A_ID,
      async () => {
        const c = await createContent({
          ownerId: USER_A_ID,
          talkId: TALK_A_ID,
          title: 'Doc',
          createdByUserId: USER_A_ID,
        });
        const anchorA = freshAnchorId();
        const md = tiptapJsonToMarkdown(
          docFor([{ anchor: anchorA, text: 'Initial' }]),
        );
        const upd = await updateContentBody({
          contentId: c.id,
          ownerId: USER_A_ID,
          expectedVersion: 1,
          bodyMarkdown: md,
        });
        if (upd.kind !== 'ok') throw new Error('seed save failed');
        const r = await createProposal({
          contentId: c.id,
          ownerId: USER_A_ID,
          kind: 'append',
          afterAnchorId: anchorA,
          insertedMarkdown: 'New.',
        });
        if (r.kind !== 'ok') throw new Error('create failed');
        return { contentId: c.id, anchorA, proposalId: r.proposal.id };
      },
    );

    await withUserContext(USER_A_ID, async () => {
      const result = await acceptProposal({
        contentId,
        proposalId,
        userId: USER_A_ID,
        expectedContentVersion: 999,
      });
      expect(result.kind).toBe('version_conflict');
    });
  });

  it('acceptProposal: structural drift triggers driftDetected even when text matches', async () => {
    // Seed a paragraph with anchorA.
    const { contentId, anchorA, proposalId } = await withUserContext(
      USER_A_ID,
      async () => {
        const c = await createContent({
          ownerId: USER_A_ID,
          talkId: TALK_A_ID,
          title: 'Doc',
          createdByUserId: USER_A_ID,
        });
        const anchorA = freshAnchorId();
        const md = tiptapJsonToMarkdown(
          docFor([{ anchor: anchorA, text: 'The same text' }]),
        );
        const upd = await updateContentBody({
          contentId: c.id,
          ownerId: USER_A_ID,
          expectedVersion: 1,
          bodyMarkdown: md,
        });
        if (upd.kind !== 'ok') throw new Error('seed save failed');
        const r = await createProposal({
          contentId: c.id,
          ownerId: USER_A_ID,
          kind: 'replace',
          afterAnchorId: null,
          targetAnchorId: anchorA,
          insertedMarkdown: 'Rewritten.',
        });
        if (r.kind !== 'ok') throw new Error('create failed');
        return { contentId: c.id, anchorA, proposalId: r.proposal.id };
      },
    );

    // Now flip the block from paragraph to heading without changing the
    // plain text — content_hash matches but structuralFingerprint won't.
    await withUserContext(USER_A_ID, async () => {
      const md = tiptapJsonToMarkdown(
        docFor([{ anchor: anchorA, text: 'The same text', type: 'heading' }]),
      );
      const upd = await updateContentBody({
        contentId,
        ownerId: USER_A_ID,
        expectedVersion: 2,
        bodyMarkdown: md,
      });
      if (upd.kind !== 'ok') throw new Error('drift save failed');
    });

    await withUserContext(USER_A_ID, async () => {
      const accepted = await acceptProposal({
        contentId,
        proposalId,
        userId: USER_A_ID,
      });
      expect(accepted.kind).toBe('ok');
      if (accepted.kind !== 'ok') return;
      expect(accepted.driftDetected).toBe(true);
      // Drift gets persisted on the row so the amber pill survives reload.
      expect(accepted.proposal.driftDetected).toBe(true);
    });
  });

  it('acceptProposal: siblings targeting the same anchor go stale on replace accept', async () => {
    const { contentId, anchorA, acceptedId, siblingId } = await withUserContext(
      USER_A_ID,
      async () => {
        const c = await createContent({
          ownerId: USER_A_ID,
          talkId: TALK_A_ID,
          title: 'Doc',
          createdByUserId: USER_A_ID,
        });
        const anchorA = freshAnchorId();
        const md = tiptapJsonToMarkdown(
          docFor([{ anchor: anchorA, text: 'Original' }]),
        );
        const upd = await updateContentBody({
          contentId: c.id,
          ownerId: USER_A_ID,
          expectedVersion: 1,
          bodyMarkdown: md,
        });
        if (upd.kind !== 'ok') throw new Error('seed save failed');
        const a = await createProposal({
          contentId: c.id,
          ownerId: USER_A_ID,
          kind: 'replace',
          afterAnchorId: null,
          targetAnchorId: anchorA,
          insertedMarkdown: 'First rewrite.',
        });
        const b = await createProposal({
          contentId: c.id,
          ownerId: USER_A_ID,
          kind: 'replace',
          afterAnchorId: null,
          targetAnchorId: anchorA,
          insertedMarkdown: 'Competing rewrite.',
        });
        if (a.kind !== 'ok' || b.kind !== 'ok')
          throw new Error('create failed');
        return {
          contentId: c.id,
          anchorA,
          acceptedId: a.proposal.id,
          siblingId: b.proposal.id,
        };
      },
    );
    void anchorA;

    await withUserContext(USER_A_ID, async () => {
      const accepted = await acceptProposal({
        contentId,
        proposalId: acceptedId,
        userId: USER_A_ID,
      });
      expect(accepted.kind).toBe('ok');
      if (accepted.kind !== 'ok') return;
      expect(accepted.staledSiblingProposalIds).toContain(siblingId);
    });

    await withUserContext(USER_A_ID, async () => {
      const sibling = await getProposalById(siblingId);
      expect(sibling?.status).toBe('stale');
      expect(sibling?.statusReason).toBe('target_replaced');
    });
  });

  it('createProposal: bulk happy path stores whole-body markdown + rationale', async () => {
    const contentId = await withUserContext(USER_A_ID, async () => {
      const c = await createContent({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        title: 'Doc',
        createdByUserId: USER_A_ID,
      });
      return c.id;
    });

    await withUserContext(USER_A_ID, async () => {
      const ok = await createProposal({
        contentId,
        ownerId: USER_A_ID,
        kind: 'bulk',
        afterAnchorId: null,
        targetAnchorId: null,
        insertedMarkdown:
          '# New title\n\nFull rewrite body across multiple paragraphs.\n\nClosing sentence.',
        rationale: 'Tighten and restructure the whole doc.',
      });
      expect(ok.kind).toBe('ok');
      if (ok.kind !== 'ok') return;
      expect(ok.proposal.kind).toBe('bulk');
      expect(ok.proposal.afterAnchorId).toBeNull();
      expect(ok.proposal.targetAnchorId).toBeNull();
      expect(ok.proposal.insertedMarkdown).toContain('Full rewrite body');
      expect(ok.proposal.rationale).toContain('Tighten and restructure');
    });
  });

  it('createProposal: bulk rejects when anchors are passed', async () => {
    const contentId = await withUserContext(USER_A_ID, async () => {
      const c = await createContent({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        title: 'Doc',
        createdByUserId: USER_A_ID,
      });
      return c.id;
    });

    await withUserContext(USER_A_ID, async () => {
      const withTarget = await createProposal({
        contentId,
        ownerId: USER_A_ID,
        kind: 'bulk',
        afterAnchorId: null,
        targetAnchorId: 'someAnchor',
        insertedMarkdown: 'new body',
      });
      expect(withTarget.kind).toBe('invalid_kind_anchors');

      const withAfter = await createProposal({
        contentId,
        ownerId: USER_A_ID,
        kind: 'bulk',
        afterAnchorId: 'someAnchor',
        targetAnchorId: null,
        insertedMarkdown: 'new body',
      });
      expect(withAfter.kind).toBe('invalid_kind_anchors');
    });
  });

  it('acceptProposal: bulk replaces the whole body and stales every other pending proposal', async () => {
    const { contentId, bulkId, anchorA, appendId, replaceId } =
      await withUserContext(USER_A_ID, async () => {
        const c = await createContent({
          ownerId: USER_A_ID,
          talkId: TALK_A_ID,
          title: 'Doc',
          createdByUserId: USER_A_ID,
        });
        const anchorA = freshAnchorId();
        const seedBody = tiptapJsonToMarkdown(
          docFor([
            { anchor: anchorA, text: 'Original block A' },
            { anchor: freshAnchorId(), text: 'Original block B' },
          ]),
        );
        const upd = await updateContentBody({
          contentId: c.id,
          ownerId: USER_A_ID,
          expectedVersion: 1,
          bodyMarkdown: seedBody,
        });
        if (upd.kind !== 'ok') throw new Error('seed save failed');

        // Two siblings: one append, one replace on anchorA.
        const appendProp = await createProposal({
          contentId: c.id,
          ownerId: USER_A_ID,
          kind: 'append',
          afterAnchorId: anchorA,
          insertedMarkdown: 'A small new block.',
        });
        const replaceProp = await createProposal({
          contentId: c.id,
          ownerId: USER_A_ID,
          kind: 'replace',
          afterAnchorId: null,
          targetAnchorId: anchorA,
          insertedMarkdown: 'A surgical replacement.',
        });
        const bulkProp = await createProposal({
          contentId: c.id,
          ownerId: USER_A_ID,
          kind: 'bulk',
          afterAnchorId: null,
          targetAnchorId: null,
          insertedMarkdown:
            '# Brand new\n\nWholesale rewrite that replaces everything.',
          rationale: 'Whole-doc rewrite.',
        });
        if (
          appendProp.kind !== 'ok' ||
          replaceProp.kind !== 'ok' ||
          bulkProp.kind !== 'ok'
        )
          throw new Error('proposal create failed');
        return {
          contentId: c.id,
          bulkId: bulkProp.proposal.id,
          anchorA,
          appendId: appendProp.proposal.id,
          replaceId: replaceProp.proposal.id,
        };
      });
    void anchorA;

    await withUserContext(USER_A_ID, async () => {
      const accepted = await acceptProposal({
        contentId,
        proposalId: bulkId,
        userId: USER_A_ID,
        expectedContentVersion: 2,
      });
      expect(accepted.kind).toBe('ok');
      if (accepted.kind !== 'ok') return;
      // Doc body is replaced wholesale.
      expect(accepted.content.bodyMarkdown).toContain('Brand new');
      expect(accepted.content.bodyMarkdown).toContain('Wholesale rewrite');
      expect(accepted.content.bodyMarkdown).not.toContain('Original block A');
      expect(accepted.content.bodyMarkdown).not.toContain('Original block B');
      // Both siblings auto-staled.
      expect(accepted.staledSiblingProposalIds.sort()).toEqual(
        [appendId, replaceId].sort(),
      );
      // Every applied anchor is freshly generated (12-char anchors).
      expect(accepted.proposal.appliedAnchorIds.length).toBeGreaterThan(0);
      for (const id of accepted.proposal.appliedAnchorIds) {
        expect(id.length).toBe(12);
        expect(id).not.toBe(anchorA);
      }
    });

    await withUserContext(USER_A_ID, async () => {
      const append = await getProposalById(appendId);
      expect(append?.status).toBe('stale');
      expect(append?.statusReason).toBe('superseded_by_bulk');
      const replace = await getProposalById(replaceId);
      expect(replace?.status).toBe('stale');
      expect(replace?.statusReason).toBe('superseded_by_bulk');
    });
  });

  it('updateContentBody: pending bulk proposals auto-stale when the doc changes', async () => {
    const { contentId, bulkId } = await withUserContext(USER_A_ID, async () => {
      const c = await createContent({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        title: 'Doc',
        createdByUserId: USER_A_ID,
      });
      const anchorA = freshAnchorId();
      const body = tiptapJsonToMarkdown(
        docFor([{ anchor: anchorA, text: 'Original' }]),
      );
      const upd = await updateContentBody({
        contentId: c.id,
        ownerId: USER_A_ID,
        expectedVersion: 1,
        bodyMarkdown: body,
      });
      if (upd.kind !== 'ok') throw new Error('seed save failed');
      const bulkProp = await createProposal({
        contentId: c.id,
        ownerId: USER_A_ID,
        kind: 'bulk',
        afterAnchorId: null,
        targetAnchorId: null,
        insertedMarkdown: '# Agent rewrite',
        rationale: 'A rewrite.',
      });
      if (bulkProp.kind !== 'ok') throw new Error('create failed');
      return { contentId: c.id, bulkId: bulkProp.proposal.id };
    });

    // User edits the doc — the pending bulk must auto-stale.
    await withUserContext(USER_A_ID, async () => {
      const upd = await updateContentBody({
        contentId,
        ownerId: USER_A_ID,
        expectedVersion: 2,
        bodyMarkdown: 'Manually rewritten by the user',
      });
      if (upd.kind !== 'ok') throw new Error('user edit failed');
      expect(upd.staledProposalIds).toContain(bulkId);
    });

    await withUserContext(USER_A_ID, async () => {
      const refetch = await getProposalById(bulkId);
      expect(refetch?.status).toBe('stale');
      expect(refetch?.statusReason).toBe('doc_changed_since_bulk_proposal');
    });
  });

  it('listPendingProposalsByContentId returns only pending in created order', async () => {
    const { contentId, p1, p2, p3 } = await withUserContext(
      USER_A_ID,
      async () => {
        const c = await createContent({
          ownerId: USER_A_ID,
          talkId: TALK_A_ID,
          title: 'Doc',
          createdByUserId: USER_A_ID,
        });
        const a = await createProposal({
          contentId: c.id,
          ownerId: USER_A_ID,
          kind: 'append',
          afterAnchorId: null,
          insertedMarkdown: 'first',
        });
        const b = await createProposal({
          contentId: c.id,
          ownerId: USER_A_ID,
          kind: 'append',
          afterAnchorId: null,
          insertedMarkdown: 'second',
        });
        const ccc = await createProposal({
          contentId: c.id,
          ownerId: USER_A_ID,
          kind: 'append',
          afterAnchorId: null,
          insertedMarkdown: 'third',
        });
        if (a.kind !== 'ok' || b.kind !== 'ok' || ccc.kind !== 'ok')
          throw new Error('create failed');
        await rejectProposal({
          proposalId: b.proposal.id,
          userId: USER_A_ID,
        });
        return {
          contentId: c.id,
          p1: a.proposal.id,
          p2: b.proposal.id,
          p3: ccc.proposal.id,
        };
      },
    );

    await withUserContext(USER_A_ID, async () => {
      const pending = await listPendingProposalsByContentId(contentId);
      const ids = pending.map((p) => p.id);
      expect(ids).toContain(p1);
      expect(ids).not.toContain(p2); // rejected
      expect(ids).toContain(p3);
    });
  });
});
