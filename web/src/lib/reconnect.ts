// What survives a reconnect. The call keeps its pictures on screen while
// a replacement connection negotiates underneath, so afterwards the only
// tiles that are no longer real are those of members who left meanwhile.

/** The tiles whose members are still in the call. */
export function tilesOfMembers<T extends { sourceId: string }>(
  tiles: readonly T[],
  memberIds: Iterable<string>,
): T[] {
  const present = new Set(memberIds)

  return tiles.filter((tile) => present.has(tile.sourceId))
}
