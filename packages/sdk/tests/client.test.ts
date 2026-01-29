import { describe, test, expect } from "bun:test"
import { Effect, Layer } from "effect"
import type { Runtime } from "effect"
import {
  createClient,
  HttpTransport,
  extractText,
  extractImages,
  extractToolCalls,
  buildToolResultMap,
  type GentRpcClient,
  type MessageInfoReadonly,
} from "../src/index"

describe("createClient", () => {
  test("creates client with all methods", () => {
    // Mock RPC client with minimal implementation
    const mockRpcClient = {
      createSession: () =>
        Effect.succeed({ sessionId: "s1", branchId: "b1", name: "Test", bypass: false }),
      listSessions: () => Effect.succeed([]),
      getSession: () => Effect.succeed(null),
      deleteSession: () => Effect.void,
      listBranches: () => Effect.succeed([]),
      createBranch: () => Effect.succeed({ branchId: "b2" }),
      getBranchTree: () => Effect.succeed([]),
      switchBranch: () => Effect.void,
      forkBranch: () => Effect.succeed({ branchId: "b3" }),
      sendMessage: () => Effect.void,
      listMessages: () => Effect.succeed([]),
      getSessionState: () =>
        Effect.succeed({
          sessionId: "s1",
          branchId: "b1",
          messages: [],
          lastEventId: null,
          isStreaming: false,
          agent: "default" as const,
        }),
      steer: () => Effect.void,
      subscribeEvents: () => Effect.succeed([]),
      respondQuestions: () => Effect.void,
      respondPermission: () => Effect.void,
      respondPlan: () => Effect.void,
      compactBranch: () => Effect.void,
      updateSessionBypass: () => Effect.succeed({ bypass: true }),
      getPermissionRules: () => Effect.succeed([]),
      deletePermissionRule: () => Effect.void,
      listAuthProviders: () => Effect.succeed([]),
      setAuthKey: () => Effect.void,
      deleteAuthKey: () => Effect.void,
      listModels: () => Effect.succeed([]),
    } as unknown as GentRpcClient

    const runtime = Effect.runSync(Effect.runtime<never>()) as Runtime.Runtime<unknown>
    const client = createClient(mockRpcClient, runtime)

    // Verify all methods exist
    expect(typeof client.createSession).toBe("function")
    expect(typeof client.listSessions).toBe("function")
    expect(typeof client.sendMessage).toBe("function")
    expect(typeof client.subscribeEvents).toBe("function")
    expect(typeof client.steer).toBe("function")
    expect(typeof client.respondQuestions).toBe("function")
    expect(typeof client.respondPermission).toBe("function")
    expect(typeof client.respondPlan).toBe("function")
    expect(typeof client.listMessages).toBe("function")
    expect(typeof client.getSessionState).toBe("function")
    expect(typeof client.listBranches).toBe("function")
    expect(typeof client.createBranch).toBe("function")
    expect(typeof client.getBranchTree).toBe("function")
    expect(typeof client.switchBranch).toBe("function")
    expect(typeof client.forkBranch).toBe("function")
    expect(typeof client.compactBranch).toBe("function")
    expect(typeof client.updateSessionBypass).toBe("function")
    expect(typeof client.getPermissionRules).toBe("function")
    expect(typeof client.deletePermissionRule).toBe("function")
    expect(typeof client.listAuthProviders).toBe("function")
    expect(typeof client.setAuthKey).toBe("function")
    expect(typeof client.deleteAuthKey).toBe("function")
    expect(typeof client.listModels).toBe("function")
    expect(client.runtime).toBeDefined()
  })

  test("createSession returns mapped result", async () => {
    const mockRpcClient = {
      createSession: () =>
        Effect.succeed({
          sessionId: "session-123",
          branchId: "branch-456",
          name: "My Session",
          bypass: true,
        }),
    } as unknown as GentRpcClient

    const runtime = Effect.runSync(Effect.runtime<never>()) as Runtime.Runtime<unknown>
    const client = createClient(mockRpcClient, runtime)

    const result = await Effect.runPromise(client.createSession())
    expect(result.sessionId).toBe("session-123")
    expect(result.branchId).toBe("branch-456")
    expect(result.name).toBe("My Session")
    expect(result.bypass).toBe(true)
  })

  test("createBranch returns branchId string", async () => {
    const mockRpcClient = {
      createBranch: () => Effect.succeed({ branchId: "new-branch-id" }),
    } as unknown as GentRpcClient

    const runtime = Effect.runSync(Effect.runtime<never>()) as Runtime.Runtime<unknown>
    const client = createClient(mockRpcClient, runtime)

    const branchId = await Effect.runPromise(client.createBranch("session-1", "feature"))
    expect(branchId).toBe("new-branch-id")
  })

  test("forkBranch returns branchId in object", async () => {
    const mockRpcClient = {
      forkBranch: () => Effect.succeed({ branchId: "forked-branch" }),
    } as unknown as GentRpcClient

    const runtime = Effect.runSync(Effect.runtime<never>()) as Runtime.Runtime<unknown>
    const client = createClient(mockRpcClient, runtime)

    const result = await Effect.runPromise(
      client.forkBranch({
        sessionId: "s1",
        fromBranchId: "b1",
        atMessageId: "m1",
      }),
    )
    expect(result.branchId).toBe("forked-branch")
  })
})

describe("HttpTransport", () => {
  test("creates layer without headers", () => {
    const transport = HttpTransport({ url: "http://localhost:3000/rpc" })
    expect(Layer.isLayer(transport)).toBe(true)
  })

  test("creates layer with headers", () => {
    const transport = HttpTransport({
      url: "http://localhost:3000/rpc",
      headers: { Authorization: "Bearer token" },
    })
    expect(Layer.isLayer(transport)).toBe(true)
  })
})

describe("utility functions", () => {
  test("extractText extracts text from parts", () => {
    const parts = [{ type: "text" as const, text: "Hello world" }]
    expect(extractText(parts)).toBe("Hello world")
  })

  test("extractImages extracts image info", () => {
    const parts = [{ type: "image" as const, image: "base64data", mediaType: "image/png" }]
    const images = extractImages(parts)
    expect(images.length).toBe(1)
    expect(images[0]?.mediaType).toBe("image/png")
  })

  test("extractToolCalls extracts tool calls", () => {
    const parts = [
      { type: "tool-call" as const, toolCallId: "tc1", toolName: "read", input: { path: "/foo" } },
    ]
    const calls = extractToolCalls(parts)
    expect(calls.length).toBe(1)
    expect(calls[0]?.id).toBe("tc1")
    expect(calls[0]?.toolName).toBe("read")
  })

  test("buildToolResultMap builds map from messages", () => {
    const messages: MessageInfoReadonly[] = [
      {
        id: "m1",
        sessionId: "s1",
        branchId: "b1",
        role: "tool",
        parts: [
          {
            type: "tool-result",
            toolCallId: "tc1",
            toolName: "read",
            output: { type: "json", value: "file contents" },
          },
        ],
        createdAt: Date.now(),
      },
    ]
    const map = buildToolResultMap(messages)
    expect(map.size).toBe(1)
    expect(map.get("tc1")?.output).toBe("file contents")
  })
})
