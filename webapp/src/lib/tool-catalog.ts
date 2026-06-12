// Talk tool display metadata. The composer chips still expose coarse family
// toggles, while the header Tools popover follows the mock's canonical
// per-tool menu.
//
// Heavy families (shell/filesystem/browser) are intentionally excluded — the
// Claude container that ran them is gone, so they never appear on the bar.

export const TOOL_FAMILY_GROUPS: Record<string, string[]> = {
  'Web tools': ['web'],
  Connectors: ['connectors'],
  'Google Workspace': [
    'google_read',
    'google_write',
    'gmail_read',
    'gmail_send',
  ],
  Messaging: ['messaging'],
};

export const TOOL_NAMES: Record<string, string> = {
  web: 'Web',
  connectors: 'Connectors',
  google_read: 'Google Read',
  google_write: 'Google Write',
  gmail_read: 'Gmail Read',
  gmail_send: 'Gmail Send',
  messaging: 'Messaging',
};

// Per-chip tooltip copy, also used to compose the discovery hint surfaced
// when a Talk has no tools active yet (the all-off default).
export const TOOL_HINTS: Record<string, string> = {
  web: 'Live web search and page fetch',
  connectors: 'Connected third-party integrations',
  google_read: 'Read Google Docs, Drive, and Sheets',
  google_write: 'Create and edit Google Docs and Sheets',
  gmail_read: 'Read and search Gmail',
  gmail_send: 'Send Gmail messages',
  messaging: 'Post to Slack and Discord',
};

/**
 * Flat list of family slugs in display order (Web → Connectors → Google →
 * Messaging). ToolChipsBar uses this to render chips in a stable order.
 */
export const TOOL_FAMILY_ORDER: string[] =
  Object.values(TOOL_FAMILY_GROUPS).flat();

export type TalkToolMenuIcon =
  | 'search'
  | 'globe'
  | 'sparkle'
  | 'doc'
  | 'eye'
  | 'send'
  | 'chat'
  | 'bolt'
  | 'folder';

export interface TalkToolMenuItem {
  toolId: string;
  family: string;
  label: string;
  description: string;
  icon: TalkToolMenuIcon;
}

export interface TalkToolMenuGroup {
  id: string;
  title: string;
  items: TalkToolMenuItem[];
}

export const TALK_TOOL_MENU_GROUPS: TalkToolMenuGroup[] = [
  {
    id: 'web',
    title: 'Web',
    items: [
      {
        toolId: 'web-search',
        family: 'web',
        label: 'Web search',
        description: 'Agents may search the open web for facts and comps.',
        icon: 'search',
      },
      {
        toolId: 'web-fetch',
        family: 'web',
        label: 'Web fetch',
        description: 'Agents may open a specific URL and read it.',
        icon: 'globe',
      },
      {
        toolId: 'news-monitor',
        family: 'web',
        label: 'News monitor',
        description:
          'Send a topic summary of this Talk to the workspace news feed.',
        icon: 'sparkle',
      },
    ],
  },
  {
    id: 'google',
    title: 'Google Workspace',
    items: [
      {
        toolId: 'gdrive-read',
        family: 'google_read',
        label: 'Drive · read',
        description: 'Agents may read Google Docs / Sheets you share.',
        icon: 'doc',
      },
      {
        toolId: 'gdrive-write',
        family: 'google_write',
        label: 'Drive · write',
        description: 'Agents may create or edit Google Docs.',
        icon: 'doc',
      },
      {
        toolId: 'gmail-read',
        family: 'gmail_read',
        label: 'Gmail · read',
        description: 'Agents may search and read your inbox.',
        icon: 'eye',
      },
      {
        toolId: 'gmail-send',
        family: 'gmail_send',
        label: 'Gmail · send',
        description: 'Agents may compose and send mail on your behalf.',
        icon: 'send',
      },
    ],
  },
  {
    id: 'communication',
    title: 'Communication',
    items: [
      {
        toolId: 'messaging',
        family: 'messaging',
        label: 'Slack messages',
        description: 'Agents may post into Slack channels you select.',
        icon: 'chat',
      },
    ],
  },
  {
    id: 'work',
    title: 'Work Tools',
    items: [
      {
        toolId: 'linear',
        family: 'connectors',
        label: 'Linear · issues',
        description: 'Agents may file and update Linear issues.',
        icon: 'bolt',
      },
      {
        toolId: 'github-read',
        family: 'connectors',
        label: 'GitHub · read',
        description: 'Agents may read PR diffs and file contents.',
        icon: 'folder',
      },
    ],
  },
];

export const TALK_TOOL_MENU_ITEMS: TalkToolMenuItem[] =
  TALK_TOOL_MENU_GROUPS.flatMap((group) => group.items);
