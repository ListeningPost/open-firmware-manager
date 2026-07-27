import semver from 'semver'

/**
 * Return true if candidate is strictly greater than current (valid semver).
 * Invalid versions return false.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const c = semver.valid(semver.coerce(candidate))
  const cur = semver.valid(semver.coerce(current))
  if (!c || !cur) return false
  return semver.gt(c, cur)
}

/**
 * Monotonic upgrade check. allowDowngrade permits any different version.
 */
export function mayApplyVersion(
  candidate: string,
  current: string | undefined,
  options: { allowDowngrade?: boolean } = {},
): boolean {
  if (!current) return semver.valid(semver.coerce(candidate)) !== null
  if (options.allowDowngrade) {
    return semver.valid(semver.coerce(candidate)) !== null
  }
  return isNewerVersion(candidate, current)
}
