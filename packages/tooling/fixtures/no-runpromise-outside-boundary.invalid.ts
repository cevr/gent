// @ts-nocheck — fixture file consumed by lint/fixtures.test.ts; not part of the build
// EXPECTED: rule `gent/no-runpromise-outside-boundary` fires
import { Effect, ManagedRuntime } from "effect"

declare const runtime: ManagedRuntime.ManagedRuntime<never, never>
declare const clientRuntime: ManagedRuntime.ManagedRuntime<never, never>
declare const extensionUI: { clientRuntime: ManagedRuntime.ManagedRuntime<never, never> }

// Effect statics
export const bad = () => Effect.runPromise(Effect.succeed(1))
export const badWith = () => Effect.runPromiseWith(undefined as never)(Effect.succeed(1))
export const badExit = () => Effect.runPromiseExit(Effect.succeed(1))

// Runtime instance methods
export const badRuntime = () => runtime.runPromise(Effect.succeed(1))
export const badClientRuntime = () => clientRuntime.runPromise(Effect.succeed(1))
// Nested member access — `extensionUI.clientRuntime.runPromise(...)`
export const badNested = () => extensionUI.clientRuntime.runPromise(Effect.succeed(1))
