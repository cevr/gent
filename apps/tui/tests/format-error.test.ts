import { describe, test, expect } from "bun:test"
import { formatError, ClientError } from "../src/utils/format-error"
import type { UiError } from "../src/utils/format-error"

describe("formatError", () => {
  test("ClientError → message", () => {
    expect(formatError(ClientError("connection lost"))).toBe("connection lost")
  })

  test("StorageError → prefixed", () => {
    const err = { _tag: "StorageError", message: "disk full" } as UiError
    expect(formatError(err)).toBe("Storage: disk full")
  })

  test("AgentLoopError → prefixed", () => {
    const err = { _tag: "AgentLoopError", message: "max turns" } as UiError
    expect(formatError(err)).toBe("Agent: max turns")
  })

  test("ProviderError → model:message", () => {
    const err = { _tag: "ProviderError", message: "rate limited", model: "gpt-4" } as UiError
    expect(formatError(err)).toBe("gpt-4: rate limited")
  })

  test("EventStoreError → prefixed", () => {
    const err = { _tag: "EventStoreError", message: "replay failed" } as UiError
    expect(formatError(err)).toBe("Events: replay failed")
  })

  test("NotFoundError → prefixed", () => {
    const err = { _tag: "NotFoundError", message: "session abc" } as UiError
    expect(formatError(err)).toBe("Not found: session abc")
  })

  test("ActorProcessError → prefixed", () => {
    const err = { _tag: "ActorProcessError", message: "crash" } as UiError
    expect(formatError(err)).toBe("Actor: crash")
  })

  test("PlatformError → prefixed", () => {
    const err = { _tag: "PlatformError", message: "file not found" } as UiError
    expect(formatError(err)).toBe("Platform: file not found")
  })

  test("ProviderAuthError → prefixed", () => {
    const err = { _tag: "ProviderAuthError", message: "invalid key" } as UiError
    expect(formatError(err)).toBe("Auth: invalid key")
  })
})
