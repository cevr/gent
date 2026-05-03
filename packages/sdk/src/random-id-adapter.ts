/**
 * Random ID adapter — wraps `Bun.randomUUIDv7` so the SDK server can mint
 * server identifiers without exposing the `Bun` global to product code.
 *
 * The `no-bun-outside-adapter` lint rule restricts `Bun.*` usage to files
 * matching the `*-adapter.ts` suffix; this module is the canonical home for
 * SDK-side platform-id minting.
 */

export const randomServerId = (): string => Bun.randomUUIDv7()
