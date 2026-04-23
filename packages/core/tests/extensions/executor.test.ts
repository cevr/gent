import { describe, test, expect } from "bun:test"
import { ExecutorActorConfig } from "@gent/extensions/executor/actor"
import {
  resolveSettings,
  ExecutorSettingsDefaults,
  type ExecutorSettings,
} from "@gent/extensions/executor/domain"
import { readExecutionId, normalizeToolResult } from "@gent/extensions/executor/mcp-bridge"
import { ExecutorProjection } from "@gent/extensions/executor/projection"

// ── Helpers ──

const { reduce, initial } = ExecutorActorConfig

const connect = { _tag: "Connect" as const, cwd: "/test" }
const disconnect = { _tag: "Disconnect" as const }
const connected = (opts?: {
  mode?: "local" | "remote"
  baseUrl?: string
  scopeId?: string
  executorPrompt?: string
}) => ({
  _tag: "Connected" as const,
  mode: opts?.mode ?? "local",
  baseUrl: opts?.baseUrl ?? "http://127.0.0.1:4788",
  scopeId: opts?.scopeId ?? "scope-1",
  executorPrompt: opts?.executorPrompt,
})
const connectionFailed = (message: string) => ({
  _tag: "ConnectionFailed" as const,
  message,
})

// ── State machine ──

describe("Executor state machine", () => {
  test("initial state is Idle", () => {
    expect(initial._tag).toBe("Idle")
  })

  test("Connect → Connecting", () => {
    const { state } = reduce(initial, connect)
    expect(state._tag).toBe("Connecting")
  })

  test("Connected → Ready with baseUrl, scopeId, executorPrompt", () => {
    const connecting = reduce(initial, connect).state
    const { state } = reduce(connecting, connected({ executorPrompt: "Use tools.search" }))
    expect(state._tag).toBe("Ready")
    if (state._tag === "Ready") {
      expect(state.baseUrl).toBe("http://127.0.0.1:4788")
      expect(state.scopeId).toBe("scope-1")
      expect(state.mode).toBe("local")
      expect(state.executorPrompt).toBe("Use tools.search")
    }
  })

  test("ConnectionFailed → Error with message", () => {
    const connecting = reduce(initial, connect).state
    const { state } = reduce(connecting, connectionFailed("port exhausted"))
    expect(state._tag).toBe("Error")
    if (state._tag === "Error") {
      expect(state.message).toBe("port exhausted")
    }
  })

  test("Disconnect from Ready → Idle", () => {
    const ready = reduce(reduce(initial, connect).state, connected()).state
    const { state } = reduce(ready, disconnect)
    expect(state._tag).toBe("Idle")
  })

  test("Connect from Error → Connecting (retry)", () => {
    const error = reduce(reduce(initial, connect).state, connectionFailed("timeout")).state
    const { state } = reduce(error, connect)
    expect(state._tag).toBe("Connecting")
  })

  test("unrecognized event → no-op", () => {
    const { state } = reduce(initial, connected())
    expect(state._tag).toBe("Idle")
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
