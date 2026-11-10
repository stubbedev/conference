interface Present {
  id: string
  name: string
}

export function membershipChanges(before: readonly Present[], after: readonly Present[]): string[] {
  const beforeIds = new Set(before.map((member) => member.id))
  const afterIds = new Set(after.map((member) => member.id))
  return [
    ...after.filter((member) => !beforeIds.has(member.id)).map((member) => `${member.name} joined`),
    ...before.filter((member) => !afterIds.has(member.id)).map((member) => `${member.name} left`),
  ]
}
