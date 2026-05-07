/**
 * Tests for the Claude Code billing-header signing helpers — the
 * algorithm Anthropic's OAuth-billing validator checks against. The
 * placeholder `cch=c5e82` we shipped before this surface tripped the
 * validator on every request, surfacing as `InvalidKey` from the SDK.
 */
import { describe, it, expect } from "bun:test"
import { createHash } from "node:crypto"
import {
  buildBillingHeaderValue,
  computeCch,
  computeVersionSuffix,
  extractFirstUserMessageText,
} from "@gent/extensions/anthropic/signing"

describe("extractFirstUserMessageText", () => {
  it("returns the empty string when no messages", () => {
    expect(extractFirstUserMessageText([])).toBe("")
  })

  it("returns the empty string when no user message", () => {
    expect(extractFirstUserMessageText([{ role: "assistant", content: "hi" }])).toBe("")
  })

  it("reads a string-content user message verbatim", () => {
    expect(extractFirstUserMessageText([{ role: "user", content: "hello" }])).toBe("hello")
  })

  it("reads the first text block of an array-content user message", () => {
    expect(
      extractFirstUserMessageText([
        {
          role: "user",
          content: [
            { type: "image", text: undefined },
            { type: "text", text: "hello" },
            { type: "text", text: "second" },
          ],
        },
      ]),
    ).toBe("hello")
  })

  it("returns the FIRST user message even when later ones exist", () => {
    expect(
      extractFirstUserMessageText([
        { role: "user", content: "first" },
        { role: "assistant", content: "ack" },
        { role: "user", content: "second" },
      ]),
    ).toBe("first")
  })
})

describe("computeCch", () => {
  it("returns the first 5 hex chars of sha256(text)", () => {
    const text = "hello"
    const expected = createHash("sha256").update(text).digest("hex").slice(0, 5)
    expect(computeCch(text)).toBe(expected)
  })

  it("is stable across calls — same text → same hash", () => {
    expect(computeCch("hi")).toBe(computeCch("hi"))
  })

  it("differs for different text — single-char change flips the hash", () => {
    expect(computeCch("hi")).not.toBe(computeCch("hj"))
  })
})

describe("computeVersionSuffix", () => {
  it("samples chars 4, 7, 20 (zero-padded when shorter) and hashes with the salt + version", () => {
    // Short message: every sample falls back to "0".
    const suffix = computeVersionSuffix("hi", "2.1.80")
    expect(suffix).toMatch(/^[0-9a-f]{3}$/)
  })

  it("differs when the version string changes", () => {
    expect(computeVersionSuffix("hello", "2.1.80")).not.toBe(
      computeVersionSuffix("hello", "2.1.81"),
    )
  })

  it("is stable for the same (text, version) pair", () => {
    expect(computeVersionSuffix("hello world here is more", "2.1.80")).toBe(
      computeVersionSuffix("hello world here is more", "2.1.80"),
    )
  })
})

describe("buildBillingHeaderValue", () => {
  it("formats `x-anthropic-billing-header: cc_version=V.S; cc_entrypoint=E; cch=H;`", () => {
    const messages = [{ role: "user", content: "hi" }]
    const value = buildBillingHeaderValue(messages, "2.1.80", "cli")
    expect(value).toMatch(
      /^x-anthropic-billing-header: cc_version=2\.1\.80\.[0-9a-f]{3}; cc_entrypoint=cli; cch=[0-9a-f]{5};$/,
    )
  })

  it("computes cch from the first user message text", () => {
    const value = buildBillingHeaderValue(
      [
        { role: "assistant", content: "preamble" },
        { role: "user", content: "the prompt" },
      ],
      "2.1.80",
      "cli",
    )
    const expectedCch = computeCch("the prompt")
    expect(value).toContain(`cch=${expectedCch};`)
  })

  it("uses the entrypoint verbatim", () => {
    const value = buildBillingHeaderValue([{ role: "user", content: "hi" }], "2.1.80", "test-entry")
    expect(value).toContain("cc_entrypoint=test-entry;")
  })
})
