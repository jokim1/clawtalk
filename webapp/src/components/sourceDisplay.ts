const UUID_SOURCE_REF =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isRawUuidSourceRef(sourceRef: string): boolean {
  return UUID_SOURCE_REF.test(sourceRef.trim());
}

export function getSourceDisplayRef(
  source: { sourceRef: string },
  displayIndex: number,
): string {
  if (!isRawUuidSourceRef(source.sourceRef)) {
    return source.sourceRef;
  }

  const index = Number.isFinite(displayIndex)
    ? Math.max(0, Math.trunc(displayIndex))
    : 0;

  return `Source ${index + 1}`;
}
