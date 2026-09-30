import { describe, expect, test } from "bun:test"
import * as RuntimePublicSdk from "../src/index"

describe("SDK public surface", () => {
  test("exports only stable runtime values", () => {
    expect(Object.keys(RuntimePublicSdk).sort()).toEqual([
      "Gent",
      "ServerLockEntry",
      "ServerLockStatus",
      "buildLogPaths",
      "classifyLogFile",
      "dataPaths",
      "ensureLogDir",
      "makeJsonFileLogger",
      "serverLock",
    ])
    expect("GentRpcs" in RuntimePublicSdk).toBe(false)
    expect("RpcHandlersLive" in RuntimePublicSdk).toBe(false)
    expect("makeRpcClient" in RuntimePublicSdk).toBe(false)
  })

  test("the server lock offers a client status, probe and stop only", () => {
    // Reading, writing, removing and holding the lock is `Gent.server`'s own work.
    expect(Object.keys(RuntimePublicSdk.serverLock).sort()).toEqual(["probe", "status", "stop"])
  })

  test("does not expose unstable or redundant type aliases", () => {
    // @ts-expect-error -- session.create result is read from the namespaced client method
    type _BadCreateSessionResult = RuntimePublicSdk.CreateSessionResult
    // @ts-expect-error -- client options are an inline constructor parameter, not a named API
    type _BadGentClientOptions = RuntimePublicSdk.GentClientOptions
    // @ts-expect-error -- state specs are constructed through Gent.state factories
    type _BadStateSpec = RuntimePublicSdk.StateSpec
    // @ts-expect-error -- provider specs are constructed through Gent.provider factories
    type _BadProviderSpec = RuntimePublicSdk.ProviderSpec
    // @ts-expect-error -- the TUI's `--debug` seeds its own session through `seed`
    type _BadDebugOption = Parameters<typeof RuntimePublicSdk.Gent.server>[0]["debug"]
    // @ts-expect-error -- prompt part aliases come from Effect AI, not the SDK
    type _BadTextPart = RuntimePublicSdk.TextPart
    // @ts-expect-error -- prompt part aliases come from Effect AI, not the SDK
    type _BadReasoningPart = RuntimePublicSdk.ReasoningPart
    // @ts-expect-error -- prompt part aliases come from Effect AI, not the SDK
    type _BadToolCallPart = RuntimePublicSdk.ToolCallPart
    // @ts-expect-error -- prompt part aliases come from Effect AI, not the SDK
    type _BadToolResultPart = RuntimePublicSdk.ToolResultPart

    expect(true).toBe(true)
  })
})
