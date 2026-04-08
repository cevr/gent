import type { Schema } from "effect"
import type { GentExtension } from "./extension"
import type {
  ExtensionClientContext,
  ExtensionClientModule,
  ExtensionClientSetup,
} from "./extension-client.js"

/**
 * Unified extension package — ties server extension + snapshot schema together.
 *
 * Client modules (*.client.ts) stay in apps/tui because they import Solid UI.
 * They reference the package's snapshot schema via normal imports.
 *
 * TSnapshot defaults to `never` — packages without a snapshot schema produce
 * `never | undefined = undefined` from the zero-arg getSnapshot overload.
 */
export interface ExtensionPackage<TSnapshot = never> {
  readonly id: string
  readonly server: GentExtension
  /** Snapshot schema for typed client-side decoding. */
  readonly snapshot?: Schema.Decoder<TSnapshot>
  /** Create a paired TUI client module. ID is derived from this package. */
  readonly tui: <TComponent = unknown>(
    setup: (ctx: PairedTuiContext<TSnapshot>) => ExtensionClientSetup<TComponent>,
  ) => ExtensionClientModule<TComponent>
}

/**
 * Extended context for paired TUI modules.
 * Zero-arg getSnapshot returns the package's own typed snapshot.
 * Two-arg overload delegates to the base context for cross-extension reads.
 */
export interface PairedTuiContext<TSnapshot> extends ExtensionClientContext {
  readonly getSnapshot: {
    (): TSnapshot | undefined
    <A>(extensionId: string, schema: Schema.Decoder<A>): A | undefined
  }
}

/** Factory helper for defining a unified extension package. */
export const defineExtensionPackage = <TSnapshot = never>(
  pkg: Omit<ExtensionPackage<TSnapshot>, "tui"> & {
    readonly snapshot?: Schema.Decoder<TSnapshot>
  },
): ExtensionPackage<TSnapshot> => {
  if (pkg.id !== pkg.server.manifest.id) {
    throw new Error(
      `ExtensionPackage id "${pkg.id}" does not match server manifest id "${pkg.server.manifest.id}"`,
    )
  }

  const result: ExtensionPackage<TSnapshot> = {
    ...pkg,
    tui: <TComponent = unknown>(
      setup: (ctx: PairedTuiContext<TSnapshot>) => ExtensionClientSetup<TComponent>,
    ): ExtensionClientModule<TComponent> => ({
      id: pkg.id,
      setup: (ctx: ExtensionClientContext) => {
        const pairedGetSnapshot = ((...args: readonly unknown[]) => {
          if (args.length === 0) {
            // Zero-arg: pre-bound to own package snapshot
            if (!pkg.snapshot) return undefined
            return ctx.getSnapshot(pkg.id, pkg.snapshot)
          }
          // Two-arg: delegate to base context
          return ctx.getSnapshot(args[0] as string, args[1] as Schema.Decoder<unknown>)
        }) as PairedTuiContext<TSnapshot>["getSnapshot"]

        const pairedCtx: PairedTuiContext<TSnapshot> = {
          ...ctx,
          getSnapshot: pairedGetSnapshot,
        }
        return setup(pairedCtx)
      },
    }),
  }
  return result
}

/**
 * Static factory for standalone TUI client modules (no server companion).
 * Use `package.tui(setup)` for paired modules instead.
 */
const standaloneClientModule = <TComponent = unknown>(
  id: string,
  setup: (ctx: ExtensionClientContext) => ExtensionClientSetup<TComponent>,
): ExtensionClientModule<TComponent> => ({ id, setup })

// Attach as static method on the ExtensionPackage namespace
export const ExtensionPackage = {
  tui: standaloneClientModule,
}

/** Input accepted by loaders — either a raw GentExtension or a unified package. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ExtensionInput = GentExtension | ExtensionPackage<any>

/** Type guard for ExtensionPackage (has `server` + `id`). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const isExtensionPackage = (value: ExtensionInput): value is ExtensionPackage<any> =>
  "server" in value && "id" in value

/** Extract GentExtension from either shape. */
export const resolveExtensionInput = (input: ExtensionInput): GentExtension =>
  isExtensionPackage(input) ? input.server : input
