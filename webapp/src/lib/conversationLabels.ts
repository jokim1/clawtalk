import type { TalkConversation } from './api';

const MAX_CONVERSATION_TITLE_CHARS = 48;

export function formatConversationLabel(
  conversation: TalkConversation,
): string {
  return displayConversationTitle(conversation.title);
}

export function displayConversationTitle(
  title: string | null | undefined,
  fallback = 'New conversation',
): string {
  const compact = title?.replace(/\s+/g, ' ').trim();
  if (!compact || compact === 'Default Thread') {
    return fallback;
  }
  return compact;
}

export function inferConversationTitleFromContent(
  content: string | null | undefined,
): string | null {
  const compact = content?.replace(/\s+/g, ' ').trim() || '';
  if (!compact) {
    return null;
  }
  const unquoted = compact.replace(/^["'`]+|["'`]+$/g, '').trim() || compact;
  if (unquoted.length <= MAX_CONVERSATION_TITLE_CHARS) {
    return unquoted;
  }
  return `${unquoted.slice(0, MAX_CONVERSATION_TITLE_CHARS - 1).trimEnd()}…`;
}
