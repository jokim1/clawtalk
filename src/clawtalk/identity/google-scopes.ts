const GOOGLE_SCOPE_URL_BY_ALIAS: Record<string, string> = {
  'drive.readonly': 'https://www.googleapis.com/auth/drive.readonly',
  'gmail.readonly': 'https://www.googleapis.com/auth/gmail.readonly',
  'gmail.send': 'https://www.googleapis.com/auth/gmail.send',
  documents: 'https://www.googleapis.com/auth/documents',
  'documents.readonly': 'https://www.googleapis.com/auth/documents.readonly',
  spreadsheets: 'https://www.googleapis.com/auth/spreadsheets',
  'spreadsheets.readonly':
    'https://www.googleapis.com/auth/spreadsheets.readonly',
};

const GOOGLE_SCOPE_ALIAS_BY_URL = Object.fromEntries(
  Object.entries(GOOGLE_SCOPE_URL_BY_ALIAS).map(([alias, url]) => [url, alias]),
);

export function expandGoogleScopeAliases(scopes: string[]): string[] {
  return Array.from(
    new Set(
      scopes
        .map((scope) => GOOGLE_SCOPE_URL_BY_ALIAS[scope] || scope)
        .filter(Boolean),
    ),
  );
}

export function normalizeGoogleScopeAliases(scopes: string[]): string[] {
  return Array.from(
    new Set(
      scopes
        .map((scope) => GOOGLE_SCOPE_ALIAS_BY_URL[scope] || scope)
        .filter(Boolean),
    ),
  ).sort();
}
