// @ts-nocheck — fixture file consumed by lint/fixtures.test.ts; not part of the build
// EXPECTED: rule `gent/no-runpromise-outside-boundary` fires exactly 9 times
import { Effect, ManagedRuntime } from "effect"

declare const runtime: ManagedRuntime.ManagedRuntime<never, never>
declare const clientRuntime: ManagedRuntime.ManagedRuntime<never, never>
declare const extensionUI: { clientRuntime: ManagedRuntime.ManagedRuntime<never, never> }

// Effect statics — 3 hits
export const bad = () => Effect.runPromise(Effect.succeed(1))
export const badWith = () => Effect.runPromiseWith(undefined as never)(Effect.succeed(1))
export const badExit = () => Effect.runPromiseExit(Effect.succeed(1))

// Runtime instance methods — 3 hits
export const badRuntime = () => runtime.runPromise(Effect.succeed(1))
export const badClientRuntime = () => clientRuntime.runPromise(Effect.succeed(1))
export const badRuntimeExit = () => runtime.runPromiseExit(Effect.succeed(1))

// Nested member access — `extensionUI.clientRuntime.<method>(...)` — 3 hits
export const badNested = () => extensionUI.clientRuntime.runPromise(Effect.succeed(1))
export const badNestedWith = () =>
  extensionUI.clientRuntime.runPromiseWith(undefined as never)(Effect.succeed(1))
export const badNestedExit = () => extensionUI.clientRuntime.runPromiseExit(Effect.succeed(1))
