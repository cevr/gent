/**
 * `which` adapter — wraps `Bun.which` so the executor sidecar can resolve
 * the `executor` binary on PATH without referencing the `Bun` global from
 * product code.
 *
 * The `no-bun-outside-adapter` lint rule restricts `Bun.*` usage to files
 * matching the `*-adapter.ts` suffix; this is the canonical home for the
 * sidecar's PATH lookup.
 */

export const whichExecutor = (): string | null => Bun.which("executor")
