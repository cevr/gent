import type { Schema } from "effect"
import type { GentExtension } from "./extension"

/**
 * Unified extension package — ties server extension + snapshot schema together.
 *
 * Client modules (*.client.ts) stay in apps/tui because they import Solid UI.
 * They reference the package's snapshot schema via normal imports.
 */
export interface ExtensionPackage<TSnapshot = unknown> {
  readonly id: string
  readonly server: GentExtension
  /** Snapshot schema for typed client-side decoding. */
  readonly snapshot?: Schema.Decoder<TSnapshot>
}

/** Factory helper for defining a unified extension package. */
export const defineExtensionPackage = <TSnapshot = unknown>(
  pkg: ExtensionPackage<TSnapshot>,
): ExtensionPackage<TSnapshot> => pkg

/** Input accepted by loaders — either a raw GentExtension or a unified package. */
export type ExtensionInput = GentExtension | ExtensionPackage

/** Type guard for ExtensionPackage (has `server` + `id`). */
export const isExtensionPackage = (value: ExtensionInput): value is ExtensionPackage =>
  "server" in value && "id" in value

/** Extract GentExtension from either shape. */
export const resolveExtensionInput = (input: ExtensionInput): GentExtension =>
  isExtensionPackage(input) ? input.server : input
