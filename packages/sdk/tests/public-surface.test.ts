import { describe, expect, test } from "bun:test"
import type * as PublicSdk from "../src/index"

describe("SDK public surface", () => {
  test("does not expose unstable or redundant type aliases", () => {
    // @ts-expect-error — session.create result is read from the namespaced client method
    type _BadCreateSessionResult = PublicSdk.CreateSessionResult
    // @ts-expect-error — client options are an inline constructor parameter, not a named API
    type _BadGentClientOptions = PublicSdk.GentClientOptions
    // @ts-expect-error — state specs are constructed through Gent.state factories
    type _BadStateSpec = PublicSdk.StateSpec
    // @ts-expect-error — provider specs are constructed through Gent.provider factories
    type _BadProviderSpec = PublicSdk.ProviderSpec
    // @ts-expect-error — prompt part aliases come from Effect AI, not the SDK
    type _BadTextPart = PublicSdk.TextPart
    // @ts-expect-error — prompt part aliases come from Effect AI, not the SDK
    type _BadReasoningPart = PublicSdk.ReasoningPart
    // @ts-expect-error — prompt part aliases come from Effect AI, not the SDK
    type _BadToolCallPart = PublicSdk.ToolCallPart
    // @ts-expect-error — prompt part aliases come from Effect AI, not the SDK
    type _BadToolResultPart = PublicSdk.ToolResultPart

    expect(true).toBe(true)
  })
})
