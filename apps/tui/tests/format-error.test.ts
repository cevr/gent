import { describe, test, expect } from "bun:test"
import { formatError, ClientError } from "../src/utils/format-error"
import { StorageError } from "@gent/core-internal/domain/storage-error"
import { EventStoreError } from "@gent/core-internal/domain/event"
import { ProviderError } from "@gent/core-internal/domain/provider-error"
import { DriverError, DriverFailureId, ProviderAuthError } from "@gent/core-internal/domain/driver"
import { NotFoundError, PlatformErrorSchema } from "@gent/core-internal/server/errors"
import { SessionRuntimeError } from "@gent/core-internal/runtime/session-runtime"

describe("formatError", () => {
  test("ClientError → message", () => {
    expect(formatError(ClientError("connection lost"))).toBe("connection lost")
  })

  test("StorageError → prefixed", () => {
    const err = new StorageError({ message: "disk full" })
    expect(formatError(err)).toBe("Storage: disk full")
  })

  test("SessionRuntimeError → prefixed", () => {
    const err = new SessionRuntimeError({ message: "max turns" })
    expect(formatError(err)).toBe("Runtime: max turns")
  })

  test("ProviderError → model:message", () => {
    const err = new ProviderError({ message: "rate limited", model: "gpt-4" })
    expect(formatError(err)).toBe("gpt-4: rate limited")
  })

  test("EventStoreError → prefixed", () => {
    const err = new EventStoreError({ message: "replay failed" })
    expect(formatError(err)).toBe("Events: replay failed")
  })

  test("NotFoundError → prefixed", () => {
    const err = new NotFoundError({ message: "session abc", entity: "session" })
    expect(formatError(err)).toBe("Not found: session abc")
  })

  test("PlatformError → prefixed", () => {
    const err = new PlatformErrorSchema({ message: "file not found", reason: "not found" })
    expect(formatError(err)).toBe("Platform: file not found")
  })

  test("ProviderAuthError → prefixed", () => {
    const err = new ProviderAuthError({ message: "invalid key" })
    expect(formatError(err)).toBe("Auth: invalid key")
  })

  test("DriverError → driver and reason", () => {
    const err = new DriverError({
      driver: { _tag: "model", id: DriverFailureId.make("openai") },
      reason: "catalog filter failed",
    })
    expect(formatError(err)).toBe("Driver model: openai: catalog filter failed")
  })
})
