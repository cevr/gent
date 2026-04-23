/**
 * C9.2 lock: autocomplete `items()` returning an Effect that yields
 * `ClientTransport` flows through a `ManagedRuntime` providing the transport
 * layer, mirroring how `autocomplete-popup.tsx`'s `runItems` adapter dispatches
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
import { Effect, ManagedRuntime, Schema } from "effect"
import { ExtensionMessage } from "@gent/core/domain/extension-protocol.js"
import {
  type AutocompleteContribution,
  type AutocompleteItem,
  autocompleteContribution,
} from "../src/extensions/client-facets.js"
import {
  ClientTransport,
  type ClientTransportShape,
  makeClientTransportLayer,
  NoActiveSessionError,
  askExtension,
} from "../src/extensions/client-transport"
import type { BranchId, SessionId } from "@gent/core/domain/ids.js"
import type { GentNamespacedClient, GentRuntime } from "@gent/sdk"

const ListThings = ExtensionMessage.reply(
  "@test/autocomplete",
  "ListThings",
  {},
  Schema.Array(Schema.String),
)

/** Mirror of the `runItems` adapter in `autocomplete-popup.tsx:51`. */
const runItems = async <R>(
  contribution: AutocompleteContribution,
  filter: string,
  runtime: ManagedRuntime.ManagedRuntime<R, never>,
): Promise<readonly AutocompleteItem[]> => {
  const out = contribution.items(filter)
  if (Effect.isEffect(out)) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    return runtime.runPromise(out as Effect.Effect<readonly AutocompleteItem[], unknown, unknown>)
  }
  return Promise.resolve(out)
}

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

describe("autocomplete Effect items() through ClientTransport (C9.2)", () => {
  test("Effect items yielding ClientTransport resolves via runtime.runPromise", async () => {
    const transport = makeFakeTransport()
    const layer = makeClientTransportLayer(transport)
    const runtime = ManagedRuntime.make(layer)

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

    const result = await runItems(contribution, "hello", runtime)
    expect(result).toEqual([{ id: "hello", label: "got:hello" }])
    await runtime.dispose()
  })

  test("askExtension fails with NoActiveSessionError when no session active", async () => {
    const transport = makeFakeTransport({ currentSession: () => undefined })
    const layer = makeClientTransportLayer(transport)
    const runtime = ManagedRuntime.make(layer)

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
    // The popup wraps `runItems(...).catch(() => [])` per
    // `autocomplete-popup.tsx:70`. Prove that pattern still produces an empty
    // array when the underlying transport call fails (no active session).
    const transport = makeFakeTransport({ currentSession: () => undefined })
    const layer = makeClientTransportLayer(transport)
    const runtime = ManagedRuntime.make(layer)

    const contribution = autocompleteContribution({
      prefix: "$",
      title: "Test",
      items: (_filter: string) =>
        Effect.gen(function* () {
          const reply = yield* askExtension(ListThings())
          return [{ id: "x", label: String(reply) }] as const
        }),
    })

    const result = await runItems(contribution, "filter", runtime).catch(
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
    const runtime = ManagedRuntime.make(makeClientTransportLayer(transport))

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
    const runtime = ManagedRuntime.make(makeClientTransportLayer(transport))

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
    const layer = makeClientTransportLayer(transport)
    const runtime = ManagedRuntime.make(layer)
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
