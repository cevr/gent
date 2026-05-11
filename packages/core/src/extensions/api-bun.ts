/**
 * Bun-flavoured platform layer for extension authors who need to run their
 * setup/runtime effects against the real `GentPlatform` shape (hash, ids,
 * OS info, etc.) on a Bun host.
 *
 * Kept as a separate entry point from `@gent/core/extensions/api` so the
 * core extension authoring surface stays platform-agnostic. Shipped Bun
 * extensions (and tests that need synchronous SHA256 via `Effect.runSync`)
 * import `BunGentPlatformLive` from here; pure-logic extensions never need it.
 *
 * @module
 */
export { BunGentPlatformLive } from "../runtime/gent-platform-bun.js"
