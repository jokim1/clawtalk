import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../../lib/api';
import { TalkToolsPill } from './TalkToolsPill';

const TALK_ID = 'talk-abc';
const ALL_FAMILIES = [
  'web',
  'connectors',
  'google_read',
  'google_write',
  'gmail_read',
  'gmail_send',
  'messaging',
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('TalkToolsPill', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getTalkTools').mockResolvedValue({
      talkId: TALK_ID,
      active: { web: true, google_read: true },
      activeToolIds: ['web-search', 'web-fetch', 'news-monitor', 'gdrive-read'],
      available: ALL_FAMILIES,
    });
  });

  it('renders the mock-style grouped tool popover', async () => {
    render(<TalkToolsPill talkId={TALK_ID} />);

    const trigger = await screen.findByRole('button', {
      name: 'Tools, 4 of 10 on',
    });
    await userEvent.click(trigger);

    expect(screen.getByText('Tools in this Talk')).toBeInTheDocument();
    expect(screen.getByText('4 of 10 on')).toBeInTheDocument();
    expect(screen.getByText('Web')).toBeInTheDocument();
    expect(screen.getByText('Google Workspace')).toBeInTheDocument();
    expect(screen.getByText('Communication')).toBeInTheDocument();
    expect(screen.getByText('Work Tools')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Web search/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(
      screen.getByRole('button', { name: /Drive · write/i }),
    ).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
  });

  it('toggles individual tools from the popover', async () => {
    const update = vi.spyOn(api, 'updateTalkTool').mockResolvedValueOnce({
      talkId: TALK_ID,
      active: { web: true, google_read: true, google_write: true },
      activeToolIds: [
        'web-search',
        'web-fetch',
        'news-monitor',
        'gdrive-read',
        'gdrive-write',
      ],
      available: ALL_FAMILIES,
    });

    render(<TalkToolsPill talkId={TALK_ID} />);
    const trigger = await screen.findByRole('button', {
      name: 'Tools, 4 of 10 on',
    });
    await userEvent.click(trigger);

    const driveWrite = screen.getByRole('button', { name: /Drive · write/i });
    await userEvent.click(driveWrite);

    await waitFor(() => {
      expect(update).toHaveBeenCalledWith({
        talkId: TALK_ID,
        toolId: 'gdrive-write',
        enabled: true,
      });
    });
    expect(driveWrite).toHaveAttribute('aria-pressed', 'true');
    expect(
      screen.getByRole('button', { name: 'Tools, 5 of 10 on' }),
    ).toBeInTheDocument();
  });
});
