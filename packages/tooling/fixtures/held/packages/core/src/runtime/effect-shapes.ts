// @ts-nocheck — held-shapes fixture
// Retired with oxlint-plugin-effect 0.18 (01c98e897): no-hand-rolled-tagged-union,
// no-lint-evasion, no-positional-log-error, no-runpromise-outside-boundary,
// no-with-wrapper-call; then no-define-extension-throw (eb1a9f72e) and
// no-platform-module-export-alias (1841a6bbf).
import { BunServices } from "@effect/platform-bun"
import * as PlatformBun from "@effect/platform-bun"
import { Effect, Option, Schema } from "effect"

declare const error: unknown
declare const runtime: { runPromise: (effect: Effect.Effect<number>) => Promise<number> }
declare const extensionUI: {
  clientRuntime: { runPromiseExit: (effect: Effect.Effect<number>) => Promise<number> }
}
declare const withBoundary: <A>(effect: Effect.Effect<A>) => Effect.Effect<A>
declare const withPath: <A>(use: (path: string) => A) => A
declare const makeEffect: () => Effect.Effect<void>
declare const definePackage: (config: { readonly setup: () => void }) => void

export type WorkerLifecycleState =
  | { readonly _tag: "Idle" } // held-by: effect/preferSchemaTaggedUnion
  | { readonly _tag: "Running"; readonly pid: number }
export type SidecarRecord =
  | { readonly "_tag": "Spawned"; readonly pid: number } // held-by: effect/preferSchemaTaggedUnion
  | { readonly "_tag": "Exited"; readonly code: number }

export const absent = Option.getOrUndefined(Option.none()) // held-by: effect/noLintEvasion
export type Payload = Schema.Schema.Type<typeof Schema.Unknown> // held-by: effect/noLintEvasion

export const warned = Effect.logWarning("request failed", error) // held-by: effect/noPositionalLogArguments
export const logged = Effect.logError("request failed", error, "retrying") // held-by: effect/noPositionalLogArguments

export const ran = () => Effect.runPromise(Effect.succeed(1)) // held-by: effect/noRunPromise
export const ranExit = () => Effect.runPromiseExit(Effect.succeed(1)) // held-by: effect/noRunPromise
export const ranRuntime = () => runtime.runPromise(Effect.succeed(1)) // held-by: effect/noRunPromise
export const ranNested = () => extensionUI.clientRuntime.runPromiseExit(Effect.succeed(1)) // held-by: effect/noRunPromise

export const wrapped = withBoundary(makeEffect()) // held-by: effect/noWithWrapperCall
export const scoped = withPath((path) => path) // held-by: effect/noWithWrapperCall
export const withThing = <A>(effect: Effect.Effect<A>, value: string) => // held-by: effect/noWithWrapperCall
  effect.pipe(Effect.annotateLogs({ value }))

export const ext = definePackage({
  setup: () => {
    throw new Error("missing prereq during setup") // held-by: effect/noThrowStatement
  },
})

const Local = BunServices
export const Services = BunServices // held-by: effect/noPlatformLayerOutsideEntry
export const FileSystem = PlatformBun.BunFileSystem // held-by: effect/noPlatformLayerOutsideEntry
export const LocalServices = Local // held-by: effect/noPlatformLayerOutsideEntry
