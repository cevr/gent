import { describe, test, expect } from "bun:test"
import { isSecretFile } from "@gent/core/tools/read"

describe("isSecretFile", () => {
  test(".env → true", () => {
    expect(isSecretFile(".env")).toBe(true)
  })

  test(".env.local → true", () => {
    expect(isSecretFile(".env.local")).toBe(true)
  })

  test(".env.production → true", () => {
    expect(isSecretFile(".env.production")).toBe(true)
  })

  test(".env.example → false", () => {
    expect(isSecretFile(".env.example")).toBe(false)
  })

  test(".env.sample → false", () => {
    expect(isSecretFile(".env.sample")).toBe(false)
  })

  test(".env.template → false", () => {
    expect(isSecretFile(".env.template")).toBe(false)
  })

  test("config.ts → false", () => {
    expect(isSecretFile("config.ts")).toBe(false)
  })

  test("path/to/.env → true (extracts basename)", () => {
    expect(isSecretFile("path/to/.env")).toBe(true)
  })
})
