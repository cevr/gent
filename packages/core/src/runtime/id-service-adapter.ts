/**
 * IdService platform adapter — owns the `Bun.randomUUIDv7` call used by
 * `IdService.Live`. Surrounding runtime code stays runtime-agnostic; only
 * this file imports the `Bun` global.
 *
 * The `no-bun-outside-adapter` lint rule restricts `Bun.*` usage to files
 * matching the `*-adapter.ts` suffix; this module owns the IdService
 * platform boundary.
 */

export const randomId = (): string => Bun.randomUUIDv7()
