import { describe, expect, it } from 'vitest';

import { buildThreadHref, getTabFromPath } from './useTalkDetailTabs';

describe('getTabFromPath', () => {
  it('maps the documents path to the documents tab', () => {
    expect(getTabFromPath('/app/talks/t1/documents', 't1')).toBe('documents');
  });

  it('preserves existing tab mappings and defaults to talk', () => {
    expect(getTabFromPath('/app/talks/t1', 't1')).toBe('talk');
    expect(getTabFromPath('/app/talks/t1/agents', 't1')).toBe('agents');
    expect(getTabFromPath('/app/talks/t1/context', 't1')).toBe('context');
    expect(getTabFromPath('/app/talks/t1/jobs', 't1')).toBe('jobs');
    expect(getTabFromPath('/app/talks/t1/runs', 't1')).toBe('runs');
    expect(getTabFromPath('/app/talks/t1/connectors', 't1')).toBe('connectors');
  });
});

describe('buildThreadHref', () => {
  it('builds a thread-aware documents href', () => {
    expect(buildThreadHref('t1', 'th1', 'documents')).toBe(
      '/app/talks/t1/documents?thread=th1',
    );
  });

  it('round-trips back to the documents tab (ignoring the query string)', () => {
    const href = buildThreadHref('t1', 'th1', 'documents');
    const pathname = href.split('?')[0];
    expect(getTabFromPath(pathname, 't1')).toBe('documents');
  });
});
