import { describe, expect, it, test } from "effect-bun-test"
import { Effect, Stream } from "effect"
import { RpcClient } from "effect/unstable/rpc"
import * as Prompt from "effect/unstable/ai/Prompt"
import { Gent, extractText, extractImages, type Message as DomainMessage } from "../src/index"
import { makeNamespacedClient } from "../src/namespaced-client"
import { GentRpcs, type GentRpcClient } from "@gent/core-internal/server/rpcs"
import { BranchId, MessageId, SessionId, ToolCallId } from "@gent/core-internal/domain/ids"
import { dateFromMillis, Message } from "@gent/core-internal/domain/message"
import { projectMessagesWithToolInteractions } from "@gent/core-internal/domain/message-part-projection"
import { WORKSPACE_ID_HEADER } from "@gent/core-internal/server/workspace-rpc"
import { workspaceHeadersForCwd, workspaceIdForCwd } from "../src/transport-headers"

describe("sdk client helpers", () => {
  test("sdk entrypoint exports the public constructors", () => {
    expect(typeof Gent.server).toBe("function")
    expect(typeof Gent.client).toBe("function")
    expect(typeof Gent.test).toBe("function")
    expect(typeof Gent.state.sqlite).toBe("function")
    expect(typeof Gent.state.memory).toBe("function")
    expect(typeof Gent.provider.live).toBe("function")
    expect(typeof Gent.provider.mock).toBe("function")
  })

  test("extractText extracts text from message parts", () => {
    const parts = [Prompt.textPart({ text: "Hello world" })]
    expect(extractText(parts)).toBe("Hello world")
  })

  test("extractImages extracts image metadata", () => {
    const parts = [Prompt.filePart({ data: "base64data", mediaType: "image/png" })]
    const images = extractImages(parts)
    expect(images.length).toBe(1)
    expect(images[0]?.mediaType).toBe("image/png")
  })

  test("canonical tool interactions expose running calls", () => {
    const message = Message.cases.regular.make({
      id: MessageId.make("m1"),
      sessionId: SessionId.make("s1"),
      branchId: BranchId.make("b1"),
      role: "assistant",
      parts: [
        Prompt.toolCallPart({
          id: ToolCallId.make("tc1"),
          name: "read",
          params: { path: "/foo" },
          providerExecuted: false,
        }),
      ],
      createdAt: dateFromMillis(0),
    })
    const projected = projectMessagesWithToolInteractions([message])[0]
    expect(projected?.toolInteractions.length).toBe(1)
    expect(projected?.toolInteractions[0]?.id).toBe(ToolCallId.make("tc1"))
    expect(projected?.toolInteractions[0]?.toolName).toBe("read")
    expect(projected?.toolInteractions[0]?.status).toBe("running")
  })

  test("canonical tool interactions include completed results", () => {
    const messages: DomainMessage[] = [
      Message.cases.regular.make({
        id: MessageId.make("m1"),
        sessionId: SessionId.make("s1"),
        branchId: BranchId.make("b1"),
        role: "assistant",
        parts: [
          Prompt.toolCallPart({
            id: ToolCallId.make("tc1"),
            name: "read",
            params: { path: "/foo" },
            providerExecuted: false,
          }),
        ],
        createdAt: dateFromMillis(0),
      }),
      Message.cases.regular.make({
        id: MessageId.make("m2"),
        sessionId: SessionId.make("s1"),
        branchId: BranchId.make("b1"),
        role: "tool",
        parts: [
          Prompt.toolResultPart({
            id: ToolCallId.make("tc1"),
            name: "read",
            isFailure: false,
            result: "file contents",
          }),
        ],
        createdAt: dateFromMillis(1),
      }),
    ]
    const projected = projectMessagesWithToolInteractions(messages)[0]
    expect(projected?.toolInteractions[0]?.status).toBe("completed")
    expect(projected?.toolInteractions[0]?.output).toBe("file contents")
  })

  test("namespaced client exposes every RPC key from GentRpcs", () => {
    const handlers = new Map<string, () => Effect.Effect<void>>(
      [...GentRpcs.requests.keys()].map((key) => [key, () => Effect.void]),
    )
    const flat = new Proxy(Object.create(null) as GentRpcClient, {
      get: (_target, property) =>
        typeof property === "string" ? handlers.get(property) : undefined,
    })
    const namespaced = makeNamespacedClient(flat)
    expect(namespaced.session).toBe(namespaced.session)

    for (const key of GentRpcs.requests.keys()) {
      const separator = key.indexOf(".")
      if (separator === -1) {
        throw new Error(`RPC key is not namespaced: ${key}`)
      }
      const namespace = key.slice(0, separator)
      const method = key.slice(separator + 1)
      const namespaceClient = namespaced[namespace as keyof typeof namespaced]
      expect(namespaceClient).toBeDefined()
      expect(namespace in namespaced).toBe(true)
      expect(method in namespaceClient).toBe(true)
      const methodClient = (namespaceClient as Readonly<Record<string, unknown>>)[method]
      expect(methodClient).toBeDefined()
      expect(methodClient).toBe(handlers.get(key))
    }
  })

  test("workspace id is a stable hash of canonical cwd", () => {
    expect(workspaceIdForCwd("/tmp/gent/../gent")).toBe(workspaceIdForCwd("/tmp/gent"))
    expect(workspaceIdForCwd("/tmp/gent")).toMatch(/^[a-f0-9]{64}$/)
    expect(workspaceHeadersForCwd("/tmp/gent")[WORKSPACE_ID_HEADER]).toBe(
      workspaceIdForCwd("/tmp/gent"),
    )
  })

  it.live("namespaced client attaches workspace header to RPC effects", () =>
    Effect.gen(function* () {
      let observed: string | undefined
      const flat = new Proxy(Object.create(null) as GentRpcClient, {
        get: (_target, property) =>
          property === "session.list"
            ? () =>
                Effect.gen(function* () {
                  const headers = yield* RpcClient.CurrentHeaders
                  observed = headers[WORKSPACE_ID_HEADER]
                  return []
                })
            : undefined,
      })
      const client = makeNamespacedClient(flat, workspaceHeadersForCwd("/tmp/gent"))
      yield* client.session.list()
      expect(observed).toBe(workspaceIdForCwd("/tmp/gent"))
    }),
  )

  it.live("namespaced client attaches workspace header to RPC streams", () =>
    Effect.gen(function* () {
      let observed: string | undefined
      const flat = new Proxy(Object.create(null) as GentRpcClient, {
        get: (_target, property) =>
          property === "session.watchRuntime"
            ? () =>
                Stream.fromEffect(
                  Effect.gen(function* () {
                    const headers = yield* RpcClient.CurrentHeaders
                    observed = headers[WORKSPACE_ID_HEADER]
                    return undefined
                  }),
                )
            : undefined,
      })
      const client = makeNamespacedClient(flat, workspaceHeadersForCwd("/tmp/gent"))
      yield* Stream.runDrain(
        client.session.watchRuntime({
          sessionId: SessionId.make("session-stream-header"),
          branchId: BranchId.make("branch-stream-header"),
        }),
      )
      expect(observed).toBe(workspaceIdForCwd("/tmp/gent"))
    }),
  )
})
