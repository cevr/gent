/**
 * C9.2 lock: autocomplete `items()` returning an Effect that yields
 * `ClientTransport` flows through a `ManagedRuntime` providing the transport
 * layer, mirroring how `autocomplete-popup-boundary.ts` dispatches
 * Effect-typed results to the resource.
 *
 * This locks the C9.2 proof path counsel called out: the existing
 * `extension-effect-setup.test.ts` only proves an Effect-typed `setup` resolves
 * `FileSystem | Path`. Here we prove the *contribution-time* adapter path
 * (Effect items() → runtime.runPromise → typed transport → decoded reply)
 * matches the legacy `ctx.ask` semantics: success returns the items, missing
 * session yields a typed `NoActiveSessionError` that the popup adapter
 * normalizes to `[]`.
 */
import { describe, it, test, expect } from "effect-bun-test"
import { Effect, Layer, ManagedRuntime, Schema } from "effect"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { ExtensionId, ref, request } from "@gent/core/extensions/api"
import {
  type AutocompleteItem,
  autocompleteContribution,
} from "../../src/extensions/client-facets.js"
import {
  ClientTransport,
  type ClientTransportShape,
  makeClientTransportLayer,
  NoActiveSessionError,
  requestExtension,
} from "../../src/extensions/client-transport"
import {
  makeClientComposerLayer,
  makeClientLifecycleLayer,
  makeClientShellLayer,
  makeClientWorkspaceLayer,
} from "../../src/extensions/client-services"
import { runAutocompleteItems } from "../../src/components/autocomplete-popup-boundary"
import type { GentNamespacedClient, GentRuntime } from "@gent/sdk"
import { BranchId, SessionId } from "@gent/core/domain/ids"
const ListThingsRpc = request({
  id: "list-things",
  extensionId: ExtensionId.make("@test/autocomplete"),
  intent: "read",
  input: Schema.Struct({}),
  output: Schema.Array(Schema.String),
  execute: () => Effect.succeed([]),
})
const makeFakeTransport = (
  opts: {
    readonly currentSession?: () =>
      | {
          sessionId: SessionId
          branchId: BranchId
        }
      | undefined
    readonly requestReply?: unknown
  } = {},
): ClientTransportShape => {
  const extension = {
    request: ((): Effect.Effect<unknown, unknown> => Effect.succeed(opts.requestReply ?? [])) as (
      ...args: unknown[]
    ) => Effect.Effect<unknown, unknown>,
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture owns intentionally partial typed values
  const fakeClient = {
    extension,
  } as unknown as GentNamespacedClient
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture owns intentionally partial typed values
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture owns intentionally partial typed values
  const fakeRuntime = { run: Effect.runPromise } as unknown as GentRuntime
  return {
    client: fakeClient,
    runtime: fakeRuntime,
    currentSession:
      opts.currentSession ??
      (() => ({
        sessionId: SessionId.make("sess-1"),
        branchId: BranchId.make("branch-1"),
      })),
    onExtensionStateChanged: () => () => {},
    onSessionEvent: () => () => {},
  }
}
const makeTestRuntime = (transport: ClientTransportShape) =>
  ManagedRuntime.make(
    Layer.mergeAll(
      BunFileSystem.layer,
      BunServices.layer,
      makeClientTransportLayer(transport),
      makeClientWorkspaceLayer({ cwd: "/tmp/test-cwd", home: "/tmp/test-home" }),
      makeClientShellLayer({
        sendMessage: () => {},
        openOverlay: () => {},
        closeOverlay: () => {},
      }),
      makeClientComposerLayer({
        state: () => ({
          draft: "",
          mode: "editing" as const,
          inputFocused: false,
          autocompleteOpen: false,
        }),
      }),
      makeClientLifecycleLayer({ addCleanup: () => {} }),
    ),
  )
describe("autocomplete Effect items() through ClientTransport (C9.2)", () => {
  it.live("Effect items yielding ClientTransport resolves via runtime.runPromise", () =>
    Effect.gen(function* () {
      const transport = makeFakeTransport()
      const runtime = makeTestRuntime(transport)
      const contribution = autocompleteContribution({
        prefix: "$",
        title: "Test",
        items: (filter: string) =>
          Effect.gen(function* () {
            const t = yield* ClientTransport
            // Touch the transport so the test proves the service resolved.
            const session = t.currentSession()
            expect(session).toBeDefined()
            return [{ id: filter, label: `got:${filter}` }] as const
          }),
      })
      const result = yield* Effect.promise(() =>
        runAutocompleteItems(contribution, "hello", runtime),
      )
      expect(result).toEqual([{ id: "hello", label: "got:hello" }])
      yield* Effect.promise(() => runtime.dispose())
    }),
  )
  it.live("requestExtension fails with NoActiveSessionError when no session active", () =>
    Effect.gen(function* () {
      const transport = makeFakeTransport({ currentSession: () => undefined })
      const runtime = makeTestRuntime(transport)
      const exit = yield* Effect.promise(() =>
        runtime.runPromiseExit(requestExtension(ref(ListThingsRpc), {})),
      )
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        // The cause should carry the typed NoActiveSessionError.
        const causeStr = JSON.stringify(exit.cause)
        expect(causeStr).toContain("NoActiveSessionError")
      }
      yield* Effect.promise(() => runtime.dispose())
    }),
  )
  it.live("popup adapter pattern: requestExtension failure normalizes to []", () =>
    Effect.gen(function* () {
      // The popup wraps `runAutocompleteItems(...).catch(() => [])` per
      // `autocomplete-popup.tsx:70`. Prove that pattern still produces an empty
      // array when the underlying transport call fails (no active session).
      const transport = makeFakeTransport({ currentSession: () => undefined })
      const runtime = makeTestRuntime(transport)
      const contribution = autocompleteContribution({
        prefix: "$",
        title: "Test",
        items: (_filter: string) =>
          Effect.gen(function* () {
            const reply = yield* requestExtension(ref(ListThingsRpc), {})
            return reply.map((label) => ({ id: label, label })) as readonly AutocompleteItem[]
          }),
      })
      const result = yield* Effect.promise(() =>
        runAutocompleteItems(contribution, "filter", runtime).catch(
          () => [] as readonly AutocompleteItem[],
        ),
      )
      expect(result).toEqual([])
      yield* Effect.promise(() => runtime.dispose())
    }),
  )
  test("requestExtension dispatches extension.request through the transport runtime", () => {
    const transport = makeFakeTransport({ requestReply: ["effect-v4", "react"] })
    const runtime = makeTestRuntime(transport)
    return runtime.runPromise(requestExtension(ref(ListThingsRpc), {})).then((result) => {
      expect(result).toEqual(["effect-v4", "react"])
      return runtime.dispose()
    })
  })
  test("popup adapter pattern: requestExtension failure normalizes to []", () => {
    const transport = makeFakeTransport({ currentSession: () => undefined })
    const runtime = makeTestRuntime(transport)
    const contribution = autocompleteContribution({
      prefix: "$",
      title: "Test",
      items: (_filter: string) =>
        Effect.gen(function* () {
          const reply = yield* requestExtension(ref(ListThingsRpc), {})
          return reply.map((label) => ({ id: label, label })) as readonly AutocompleteItem[]
        }),
    })
    return runAutocompleteItems(contribution, "filter", runtime)
      .catch(() => [] as readonly AutocompleteItem[])
      .then((result) => {
        expect(result).toEqual([])
        return runtime.dispose()
      })
  })
  test("NoActiveSessionError is a Schema.TaggedError instance", () => {
    const err = new NoActiveSessionError()
    expect(err._tag).toBe("NoActiveSessionError")
  })
  it.live("requestExtension seals transport failures to ClientTransportRequestError", () =>
    Effect.gen(function* () {
      const transport = makeFakeTransport()
      ;(
        transport.client.extension as unknown as {
          request: () => Effect.Effect<unknown, unknown>
        }
      ).request = () => Effect.fail(new Error("transport boom"))
      const runtime = makeTestRuntime(transport)
      const exit = yield* Effect.promise(() =>
        runtime.runPromiseExit(requestExtension(ref(ListThingsRpc), {})),
      )
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const causeStr = JSON.stringify(exit.cause)
        expect(causeStr).toContain("ClientTransportRequestError")
        expect(causeStr).toContain("transport boom")
      }
      yield* Effect.promise(() => runtime.dispose())
    }),
  )
  it.live("requestExtension seals decode failures to ClientTransportReplyDecodeError", () =>
    Effect.gen(function* () {
      const transport = makeFakeTransport({ requestReply: { nope: true } })
      const runtime = makeTestRuntime(transport)
      const exit = yield* Effect.promise(() =>
        runtime.runPromiseExit(requestExtension(ref(ListThingsRpc), {})),
      )
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const causeStr = JSON.stringify(exit.cause)
        expect(causeStr).toContain("ClientTransportReplyDecodeError")
      }
      yield* Effect.promise(() => runtime.dispose())
    }),
  )
  it.live("makeClientTransportLayer constructs a Layer that provides ClientTransport", () =>
    Effect.gen(function* () {
      const transport = makeFakeTransport()
      const runtime = makeTestRuntime(transport)
      const resolved = yield* Effect.promise(() =>
        runtime.runPromise(
          Effect.gen(function* () {
            return yield* ClientTransport
          }),
        ),
      )
      expect(resolved.currentSession()).toEqual({
        sessionId: SessionId.make("sess-1") as SessionId,
        branchId: BranchId.make("branch-1") as BranchId,
      })
      yield* Effect.promise(() => runtime.dispose())
    }),
  )
})
