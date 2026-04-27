import { describe, test, expect } from "bun:test"
import {
  ExecutorState,
  transitionConnect,
  transitionConnected,
  transitionConnectionFailed,
  transitionDisconnect,
  executorBehavior,
} from "@gent/extensions/executor/actor"
import {
  resolveSettings,
  ExecutorSettingsDefaults,
  type ExecutorSettings,
} from "@gent/extensions/executor/domain"
import { readExecutionId, normalizeToolResult } from "@gent/extensions/executor/mcp-bridge"
import { ExecutorProjection } from "@gent/extensions/executor/projection"

// ── State machine ──
//
// Pure transitions are exposed as standalone functions; the Behavior
// composes them into a `receive` switch. We test the transitions
// directly — that's the W10-1b/c test pattern. End-to-end coverage
// (actor mailbox + connection runner) lives in the integration test.

const idle = executorBehavior.initialState
const connectingFrom = (cwd = "/test") => transitionConnect(idle, cwd)

describe("Executor state machine", () => {
  test("initial state is Idle", () => {
    expect(idle._tag).toBe("Idle")
  })

  test("Connect → Connecting", () => {
    const next = transitionConnect(idle, "/test")
    expect(next._tag).toBe("Connecting")
    if (next._tag === "Connecting") {
      expect(next.cwd).toBe("/test")
    }
  })

  test("Connected → Ready with baseUrl, scopeId, executorPrompt", () => {
    const connecting = connectingFrom()
    const next = transitionConnected(connecting, {
      mode: "local",
      baseUrl: "http://127.0.0.1:4788",
      scopeId: "scope-1",
      executorPrompt: "Use tools.search",
    })
    expect(next._tag).toBe("Ready")
    if (next._tag === "Ready") {
      expect(next.baseUrl).toBe("http://127.0.0.1:4788")
      expect(next.scopeId).toBe("scope-1")
      expect(next.mode).toBe("local")
      expect(next.executorPrompt).toBe("Use tools.search")
    }
  })

  test("ConnectionFailed → Error with message", () => {
    const connecting = connectingFrom()
    const next = transitionConnectionFailed(connecting, "port exhausted")
    expect(next._tag).toBe("Error")
    if (next._tag === "Error") {
      expect(next.message).toBe("port exhausted")
    }
  })

  test("Disconnect from Ready → Idle", () => {
    const ready = transitionConnected(connectingFrom(), {
      mode: "local",
      baseUrl: "http://127.0.0.1:4788",
      scopeId: "scope-1",
    })
    const next = transitionDisconnect(ready)
    expect(next._tag).toBe("Idle")
  })

  test("Connect from Error → Connecting (retry)", () => {
    const error = transitionConnectionFailed(connectingFrom(), "timeout")
    const next = transitionConnect(error, "/test")
    expect(next._tag).toBe("Connecting")
  })

  test("Connected while Idle → no-op (out-of-order message dropped)", () => {
    const next = transitionConnected(idle, {
      mode: "local",
      baseUrl: "http://127.0.0.1:4788",
      scopeId: "scope-1",
    })
    expect(next._tag).toBe("Idle")
  })

  test("Disconnect while Connecting → Idle (cancels in-flight handshake)", () => {
    // The connection runner observes the state stream and interrupts
    // the in-flight `runConnection` fork when state leaves Connecting,
    // so honoring user disconnect intent is safe — late `Connected`
    // tells from a cancelled fork would no-op against Idle anyway via
    // `transitionConnected`'s state guard.
    const next = transitionDisconnect(connectingFrom())
    expect(next._tag).toBe("Idle")
  })

  test("Connect while Ready → no-op (Ready is a terminal Connect target)", () => {
    const ready = transitionConnected(connectingFrom(), {
      mode: "local",
      baseUrl: "http://127.0.0.1:4788",
      scopeId: "scope-1",
    })
    const next = transitionConnect(ready, "/test")
    expect(next._tag).toBe("Ready")
  })

  test("ExecutorState constructors round-trip through tag discriminants", () => {
    expect(ExecutorState.Idle.make({})._tag).toBe("Idle")
    expect(ExecutorState.Connecting.make({ cwd: "/x" })._tag).toBe("Connecting")
  })
})

// ── Turn projection (new C2 path) ──
//
// `ExecutorActorConfig.derive` is gone. Prompt/policy come from
// `ExecutorProjection.prompt(snapshot)` / `.policy(snapshot)` — pure
// functions of the typed reply schema. We test those directly.

describe("ExecutorProjection prompt + policy", () => {
  test("Idle: excludes execute + resume, no prompt section", () => {
    const policy = ExecutorProjection.policy!({ status: "idle" }, undefined as never)
    expect(policy).toEqual({ exclude: ["execute", "resume"] })
    const sections = ExecutorProjection.prompt!({ status: "idle" })
    expect(sections).toEqual([])
  })

  test("Connecting: excludes execute + resume", () => {
    const policy = ExecutorProjection.policy!({ status: "connecting" }, undefined as never)
    expect(policy).toEqual({ exclude: ["execute", "resume"] })
  })

  test("Error: excludes execute + resume", () => {
    const policy = ExecutorProjection.policy!(
      { status: "error", errorMessage: "boom", baseUrl: undefined, executorPrompt: undefined },
      undefined as never,
    )
    expect(policy).toEqual({ exclude: ["execute", "resume"] })
  })

  test("Ready without instructions: no prompt section, no policy exclusions", () => {
    const policy = ExecutorProjection.policy!(
      { status: "ready", baseUrl: "http://x" },
      undefined as never,
    )
    expect(policy).toEqual({})
    const sections = ExecutorProjection.prompt!({ status: "ready", baseUrl: "http://x" })
    expect(sections).toEqual([])
  })

  test("Ready with instructions: prompt section includes guidance", () => {
    const sections = ExecutorProjection.prompt!({
      status: "ready",
      baseUrl: "http://x",
      executorPrompt: "use frobnicator API",
    })
    expect(sections.length).toBe(1)
    expect(sections[0]!.id).toBe("executor-guidance")
    expect(sections[0]!.content).toContain("use frobnicator API")
  })
})

// ── Settings resolution ──

describe("Executor settings", () => {
  test("defaults are applied when no overrides", () => {
    const result = resolveSettings()
    expect(result).toEqual(ExecutorSettingsDefaults)
  })

  test("global overrides defaults", () => {
    const result = resolveSettings({ mode: "remote" })
    expect(result.mode).toBe("remote")
    expect(result.autoStart).toBe(true) // untouched default
  })

  test("project overrides global", () => {
    const result = resolveSettings(
      { mode: "remote", remoteUrl: "http://global" },
      { remoteUrl: "http://project" },
    )
    expect(result.mode).toBe("remote")
    expect(result.remoteUrl).toBe("http://project")
  })

  test("undefined fields don't erase previous layer", () => {
    const globalSettings: ExecutorSettings = { mode: "remote", remoteUrl: "http://example.com" }
    const projectSettings: ExecutorSettings = { autoStart: false }
    const result = resolveSettings(globalSettings, projectSettings)
    expect(result.mode).toBe("remote")
    expect(result.remoteUrl).toBe("http://example.com")
    expect(result.autoStart).toBe(false)
  })
})

// ── MCP result normalization ──

describe("Executor MCP normalization", () => {
  test("readExecutionId extracts from waiting_for_interaction", () => {
    expect(
      readExecutionId({
        _tag: "waiting_for_interaction",
        executionId: "exec-1",
        interaction: { _tag: "form", message: "Approve?" },
      }),
    ).toBe("exec-1")
  })

  test("readExecutionId returns undefined for non-waiting status", () => {
    expect(readExecutionId({ _tag: "completed", result: { ok: true }, logs: [] })).toBeUndefined()
  })

  test("readExecutionId returns undefined for non-object", () => {
    expect(readExecutionId("string")).toBeUndefined()
    expect(readExecutionId(null)).toBeUndefined()
    expect(readExecutionId(undefined)).toBeUndefined()
  })
})

// ── Snapshot projection ──
// TODO(c2): "Executor snapshot projection" — removed.
// `projectSnapshot` was a private helper for the deleted UI snapshot pipeline;
// the new GetSnapshot reply path is exercised in executor-integration.test.ts.

// ── normalizeToolResult ──

describe("normalizeToolResult", () => {
  test("content array with text items", () => {
    const result = normalizeToolResult({
      content: [
        { type: "text", text: "line 1" },
        { type: "text", text: "line 2" },
      ],
    })
    expect(result.text).toBe("line 1\nline 2")
    expect(result.isError).toBe(false)
    expect(result.executionId).toBeUndefined()
  })

  test("missing content falls back to toolResult", () => {
    const result = normalizeToolResult({
      toolResult: { answer: 42 },
    } as never)
    expect(result.text).toContain("42")
    expect(result.structuredContent).toEqual({ answer: 42 })
  })

  test("missing content and no toolResult → default text", () => {
    const result = normalizeToolResult({} as never)
    expect(result.text).toBe("(no result)")
    expect(result.structuredContent).toBeNull()
  })

  test("structuredContent extracted", () => {
    const result = normalizeToolResult({
      content: [{ type: "text", text: "ok" }],
      structuredContent: { data: "value" },
    })
    expect(result.structuredContent).toEqual({ data: "value" })
  })

  test("isError flag propagated", () => {
    const result = normalizeToolResult({
      content: [{ type: "text", text: "error" }],
      isError: true,
    })
    expect(result.isError).toBe(true)
  })

  test("executionId from waiting_for_interaction", () => {
    const result = normalizeToolResult({
      content: [{ type: "text", text: "waiting" }],
      structuredContent: {
        status: "waiting_for_interaction",
        executionId: "exec-xyz",
        interaction: { kind: "form", message: "Approve?" },
      },
    })
    expect(result.executionId).toBe("exec-xyz")
    expect(result.structuredContent).toEqual({
      _tag: "waiting_for_interaction",
      executionId: "exec-xyz",
      interaction: { _tag: "form", message: "Approve?" },
    })
  })

  test("no executionId when status is not waiting_for_interaction", () => {
    const result = normalizeToolResult({
      content: [{ type: "text", text: "done" }],
      structuredContent: { status: "completed", result: { ok: true } },
    })
    expect(result.executionId).toBeUndefined()
    expect(result.structuredContent).toEqual({
      _tag: "completed",
      result: { ok: true },
      logs: [],
    })
  })

  test("error status normalizes to tagged error content", () => {
    const result = normalizeToolResult({
      content: [{ type: "text", text: "boom" }],
      structuredContent: { status: "error", errorMessage: "boom" },
      isError: true,
    })
    expect(result.structuredContent).toEqual({
      _tag: "error",
      error: "boom",
      logs: [],
    })
  })
})
