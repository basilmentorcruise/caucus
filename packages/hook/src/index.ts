/**
 * @caucus/hook — Claude Code turn-start awareness hook.
 *
 * Placeholder only. Real behavior arrives in later tickets; this package
 * currently exports just its identity so the workspace and coverage gate have
 * something to exercise.
 */
export const PACKAGE_NAME = "@caucus/hook" as const;

/** Returns the package name. Trivial placeholder used to seed the coverage gate. */
export function packageName(): typeof PACKAGE_NAME {
  return PACKAGE_NAME;
}
