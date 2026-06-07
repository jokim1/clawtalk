import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { ArchivePage } from './ArchivePage';
import { ApiError } from '../lib/api';
import type { Talk } from '../lib/api';
import * as api from '../lib/api';

// Keep the real module (ApiError class + types); stub only the data calls.
vi.mock('../lib/api', async (importActual) => {
  const actual = await importActual<typeof import('../lib/api')>();
  return {
    ...actual,
    listArchivedTalks: vi.fn(),
    unarchiveTalk: vi.fn(),
  };
});

const mockApi = vi.mocked(api);

function talk(id: string, title: string): Talk {
  return {
    id,
    ownerId: 'u1',
    title,
    orchestrationMode: 'ordered',
    agents: [],
    status: 'archived',
    folderId: null,
    sortOrder: 0,
    version: 1,
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-02T00:00:00Z',
    accessRole: 'owner',
  };
}

function renderArchive(onRestored?: () => void): void {
  render(
    <MemoryRouter>
      <ArchivePage onRestored={onRestored} />
    </MemoryRouter>,
  );
}

describe('ArchivePage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });
  afterEach(() => {
    cleanup();
  });

  it('lists archived talks', async () => {
    mockApi.listArchivedTalks.mockResolvedValue([
      talk('t1', 'Old Pricing'),
      talk('t2', 'Old Launch'),
    ]);
    renderArchive();
    expect(await screen.findByText('Old Pricing')).toBeTruthy();
    expect(screen.getByText('Old Launch')).toBeTruthy();
  });

  it('shows an empty state when nothing is archived', async () => {
    mockApi.listArchivedTalks.mockResolvedValue([]);
    renderArchive();
    expect(await screen.findByText('No archived Talks.')).toBeTruthy();
  });

  it('restores a talk optimistically, calls the API, and notifies the parent', async () => {
    mockApi.listArchivedTalks.mockResolvedValue([talk('t1', 'Old Pricing')]);
    mockApi.unarchiveTalk.mockResolvedValue(undefined);
    const onRestored = vi.fn();
    renderArchive(onRestored);
    await screen.findByText('Old Pricing');

    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));

    await waitFor(() => expect(screen.queryByText('Old Pricing')).toBeNull());
    expect(mockApi.unarchiveTalk).toHaveBeenCalledWith('t1');
    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
  });

  it('re-adds the talk and surfaces an error when restore fails', async () => {
    mockApi.listArchivedTalks.mockResolvedValue([talk('t1', 'Old Pricing')]);
    mockApi.unarchiveTalk.mockRejectedValue(new Error('boom'));
    renderArchive();
    await screen.findByText('Old Pricing');

    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));

    await waitFor(() => expect(screen.getByText('Old Pricing')).toBeTruthy());
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('keeps the talk removed (no error) on a 404', async () => {
    mockApi.listArchivedTalks.mockResolvedValue([talk('t1', 'Old Pricing')]);
    mockApi.unarchiveTalk.mockRejectedValue(
      new ApiError('gone', 404, 'talk_not_found'),
    );
    renderArchive();
    await screen.findByText('Old Pricing');

    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));

    await waitFor(() => expect(screen.queryByText('Old Pricing')).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
