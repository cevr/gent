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
import { describe, test, expect } from "bun:test"
import { Effect, Layer, ManagedRuntime, Schema } from "effect"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { ExtensionMessage } from "@gent/core/domain/extension-protocol.js"
import { type AutocompleteItem, autocompleteContribution } from "../src/extensions/client-facets.js"
import {
  ClientTransport,
  type ClientTransportShape,
  makeClientTransportLayer,
  NoActiveSessionError,
  askExtension,
} from "../src/extensions/client-transport"
import {
  makeClientComposerLayer,
  makeClientLifecycleLayer,
  makeClientShellLayer,
  makeClientWorkspaceLayer,
} from "../src/extensions/client-services"
import { runAutocompleteItems } from "../src/components/autocomplete-popup-boundary"
import type { BranchId, SessionId } from "@gent/core/domain/ids.js"
import type { GentNamespacedClient, GentRuntime } from "@gent/sdk"

const ListThings = ExtensionMessage.reply(
  "@test/autocomplete",
  "ListThings",
  {},
  Schema.Array(Schema.String),
)

const makeFakeTransport = (
  opts: {
    readonly currentSession?: () => { sessionId: SessionId; branchId: BranchId } | undefined
    readonly askReply?: unknown
  } = {},
): ClientTransportShape => {
  const ask = () => Effect.succeed(opts.askReply ?? [])
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const fakeClient = {
    extension: { ask },
  } as unknown as GentNamespacedClient
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const fakeRuntime = {} as GentRuntime
  return {
    client: fakeClient,
    runtime: fakeRuntime,
    currentSession:
      opts.currentSession ??
      (() => ({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        sessionId: "sess-1" as SessionId,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        branchId: "branch-1" as BranchId,
      })),
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
        send: () => {},
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
  test("Effect items yielding ClientTransport resolves via runtime.runPromise", async () => {
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

    const result = await runAutocompleteItems(contribution, "hello", runtime)
    expect(result).toEqual([{ id: "hello", label: "got:hello" }])
    await runtime.dispose()
  })

  test("askExtension fails with NoActiveSessionError when no session active", async () => {
    const transport = makeFakeTransport({ currentSession: () => undefined })
    const runtime = makeTestRuntime(transport)

    const exit = await runtime.runPromiseExit(askExtension(ListThings()))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      // The cause should carry the typed NoActiveSessionError.
      const causeStr = JSON.stringify(exit.cause)
      expect(causeStr).toContain("NoActiveSessionError")
    }
    await runtime.dispose()
  })

  test("popup adapter pattern: askExtension failure normalizes to []", async () => {
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
          const reply = yield* askExtension(ListThings())
          return [{ id: "x", label: String(reply) }] as const
        }),
    })

    const result = await runAutocompleteItems(contribution, "filter", runtime).catch(
      () => [] as readonly AutocompleteItem[],
    )
    expect(result).toEqual([])
    await runtime.dispose()
  })

  test("NoActiveSessionError is a Schema.TaggedError instance", () => {
    const err = new NoActiveSessionError()
    expect(err._tag).toBe("NoActiveSessionError")
  })

  test("askExtension seals transport failures to ClientTransportRequestError", async () => {
    const transport = makeFakeTransport()
    transport.client.extension.ask = () => Effect.fail(new Error("transport boom"))
    const runtime = makeTestRuntime(transport)

    const exit = await runtime.runPromiseExit(askExtension(ListThings()))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const causeStr = JSON.stringify(exit.cause)
      expect(causeStr).toContain("ClientTransportRequestError")
      expect(causeStr).toContain("transport boom")
    }
    await runtime.dispose()
  })

  test("askExtension seals decode failures to ClientTransportReplyDecodeError", async () => {
    const transport = makeFakeTransport({ askReply: { nope: true } })
    const runtime = makeTestRuntime(transport)

    const exit = await runtime.runPromiseExit(askExtension(ListThings()))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const causeStr = JSON.stringify(exit.cause)
      expect(causeStr).toContain("ClientTransportReplyDecodeError")
    }
    await runtime.dispose()
  })

  test("makeClientTransportLayer constructs a Layer that provides ClientTransport", async () => {
    const transport = makeFakeTransport()
    const runtime = makeTestRuntime(transport)
    const resolved = await runtime.runPromise(
      Effect.gen(function* () {
        return yield* ClientTransport
      }),
    )
    expect(resolved.currentSession()).toEqual({
      sessionId: "sess-1" as SessionId,
      branchId: "branch-1" as BranchId,
    })
    await runtime.dispose()
  })
})
