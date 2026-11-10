// What the browser says about a permission, or 'unknown' when it cannot
// be asked: Safari before 16 has no Permissions API, and an API that
// does not know a name rejects it with a TypeError, as Firefox before
// 132 does for the camera and the microphone. Neither is a failure; any
// other rejection is, and is reported.
export type QueriedPermission = PermissionStatus | 'unknown'

export async function queryPermission(permissions: Pick<Permissions, 'query'> | undefined, name: PermissionName): Promise<QueriedPermission> {
  if (!permissions) return 'unknown'
  try {
    return await permissions.query({ name })
  } catch (err) {
    if (!(err instanceof TypeError)) console.warn(`permission: asking the browser about "${name}"`, err)
    return 'unknown'
  }
}
