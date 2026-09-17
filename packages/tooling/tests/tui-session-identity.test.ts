import { describe, expect, test } from "bun:test"
import { findTuiSessionIdentityReads } from "../src/tui-session-identity"

const FILE = "apps/tui/src/hooks/use-thing.ts"

const linesOf = (text: string): ReadonlyArray<number> =>
  findTuiSessionIdentityReads(FILE, text).map((finding) => finding.line)

describe("TUI session identity guard", () => {
  test("flags the record as an `on` source", () => {
    const text = [
      "  createEffect(",
      "    on(",
      "      () => client.session(),",
      "      (session) => startTracking(session),",
      "    ),",
      "  )",
    ].join("\n")
    expect(linesOf(text)).toEqual([3])
    expect(findTuiSessionIdentityReads(FILE, text)[0]?.message).toContain("sessionIdentity()")
  })

  test("flags the record read in a createEffect body", () => {
    const text = [
      "  createEffect(() => {",
      "    const current = Option.fromNullishOr(client.session())",
      "    if (Option.isNone(current)) return",
      "  })",
    ].join("\n")
    expect(linesOf(text)).toEqual([2])
  })

  test("flags the record read in a createMemo", () => {
    const text = [
      "  const identity = createMemo(() =>",
      "    Option.map(Option.fromNullishOr(sessionClient.session()), (s) => s.sessionId),",
      "  )",
    ].join("\n")
    expect(linesOf(text)).toEqual([2])
  })

  test("reports one finding per reactive scope, not one per opener", () => {
    const text = [
      "  createEffect(",
      "    on(",
      "      () => client.session(),",
      "      () => {},",
      "    ),",
      "  )",
    ].join("\n")
    expect(linesOf(text)).toHaveLength(1)
  })

  test("allows the record in an event handler", () => {
    const text = ["  const onSelect = () => {", "    const s = client.session()", "  }"].join("\n")
    expect(linesOf(text)).toEqual([])
  })

  test("allows the record in a JSX expression", () => {
    const text = ["  return (", "    <text>{client.session()?.name}</text>", "  )"].join("\n")
    expect(linesOf(text)).toEqual([])
  })

  test("allows the narrowed identity accessors", () => {
    const text = [
      "  createEffect(() => {",
      "    const current = client.activeSessionId()",
      "    const identity = client.sessionIdentity()",
      "  })",
    ].join("\n")
    expect(linesOf(text)).toEqual([])
  })

  test("allows the transport identity accessor", () => {
    const text = [
      "  createEffect(() => {",
      "    const session = Option.fromNullishOr(opts.transport.currentSession())",
      "  })",
    ].join("\n")
    expect(linesOf(text)).toEqual([])
  })

  test("leaves files outside the TUI source alone", () => {
    const text = ["  createEffect(() => {", "    const s = client.session()", "  })"].join("\n")
    expect(findTuiSessionIdentityReads("packages/core/src/runtime/thing.ts", text)).toEqual([])
    expect(findTuiSessionIdentityReads("apps/tui/tests/thing.test.ts", text)).toEqual([])
  })
})
