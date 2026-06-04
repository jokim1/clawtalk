// Shared SQL expression for deriving a final-schema context source status.
// Assumes the source table is aliased as `s`; keep this branch-equivalent with
// `sourceStatus` in greenfield-context-accessors.ts.
export const CONTEXT_SOURCE_STATUS_SQL = [
  'case',
  "  when lower(nullif(trim(s.meta_json->>'status'), '')) in ('pending', 'ready', 'failed')",
  "    then lower(trim(s.meta_json->>'status'))",
  "  when nullif(s.meta_json->>'extractionError', '') is not null",
  "    and nullif(trim(coalesce(s.extracted_text, '')), '') is null",
  "    and nullif(trim(coalesce(s.summary, '')), '') is null",
  "    then 'failed'",
  "  when nullif(trim(coalesce(s.extracted_text, '')), '') is not null",
  "    or nullif(trim(coalesce(s.summary, '')), '') is not null",
  "    then 'ready'",
  "  when s.kind in ('url', 'file', 'document', 'past_talk', 'news')",
  "    then 'pending'",
  "  else 'ready'",
  'end',
].join('\n');

export const CONTEXT_SOURCE_TITLE_SLUG_SQL = [
  'nullif(',
  "  trim(both '-' from regexp_replace(lower(s.name), '[^a-z0-9]+', '-', 'g')),",
  "  ''",
  ')',
].join('\n');

export const CONTEXT_SOURCE_FILE_SIZE_SQL = [
  'case',
  "  when s.meta_json->>'fileSize' ~ '^[0-9]+$'",
  "    and length(s.meta_json->>'fileSize') <= 15",
  "    then (s.meta_json->>'fileSize')::double precision",
  '  else null',
  'end',
].join('\n');

export const CONTEXT_SOURCE_TEXT_SQL = [
  'case',
  "  when nullif(trim(coalesce(s.extracted_text, '')), '') is not null",
  '    then s.extracted_text',
  '  else s.summary',
  'end',
].join('\n');
