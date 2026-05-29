import {
  canUserAccessTalk,
  canUserEditTalk,
  canUserEditTalkFromRecord,
} from '../../db/index.js';
import type { TalkWithAccessRecord } from '../../db/index.js';

export async function canAccessTalk(talkId: string): Promise<boolean> {
  return canUserAccessTalk(talkId);
}

export async function canEditTalk(talkId: string): Promise<boolean> {
  return canUserEditTalk(talkId);
}

export function canEditTalkFromRecord(
  talk: TalkWithAccessRecord | undefined,
): boolean {
  return canUserEditTalkFromRecord(talk);
}
