/**
 * @caucus/schema — versioned typed-message schema + codec (shared).
 *
 * Placeholder only. The real schema lives behind later tickets; this package
 * currently exports just its identity so the workspace and coverage gate have
 * something to exercise.
 */
export const PACKAGE_NAME = "@caucus/schema" as const;

/** Returns the package name. Trivial placeholder used to seed the coverage gate. */
export function packageName(): typeof PACKAGE_NAME {
  return PACKAGE_NAME;
}
