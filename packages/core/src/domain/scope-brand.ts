/**
 * Pure type-level scope brands used by Resource declarations.
 *
 * Encodes the lifetime of a `Scope.Scope` at the type level.
 *
 * Today Resource hosting supports only process-scoped services:
 *
 *   - {@link ServerScope} — survives for the server's lifetime
 *
 * Add new brands only when their resource host lifecycle exists. These types
 * carry no runtime payload; they are purely structural markers.
 *
 * @module
 */

declare const ServerBrand: unique symbol

export type ServerScope = { readonly [ServerBrand]: true }
