import { describe, test, expect } from "bun:test"
import { AgentDefinition } from "@gent/core/domain/agent"
import type { ExtensionTurnContext } from "@gent/core/domain/extension"
import { BranchId, SessionId } from "@gent/core/domain/ids"
import {
  ExecutorActorConfig,
  projectSnapshot,
  type ExecutorState,
} from "@gent/core/extensions/executor/actor"
import {
  resolveSettings,
  ExecutorSettingsDefaults,
  type ExecutorSettings,
} from "@gent/core/extensions/executor/domain"
import { readExecutionId, normalizeToolResult } from "@gent/core/extensions/executor/mcp-bridge"

// ── Helpers ──

const { reduce, initial } = ExecutorActorConfig

const stubCtx: ExtensionTurnContext = {
  sessionId: SessionId.of("test-session"),
  branchId: BranchId.of("test-branch"),
  agent: new AgentDefinition({ name: "test" as never }),
  allTools: [],
  interactive: true,
}

const derive = (state: ExecutorState) => ExecutorActorConfig.derive(state, stubCtx)

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

// ── Turn projection ──

describe("Executor turn projection", () => {
  test("Idle → exclude [execute, resume]", () => {
    const result = derive(initial)
    expect(result.toolPolicy?.exclude).toEqual(["execute", "resume"])
  })

  test("Connecting → exclude [execute, resume]", () => {
    const connecting = reduce(initial, connect).state
    const result = derive(connecting)
    expect(result.toolPolicy?.exclude).toEqual(["execute", "resume"])
  })

  test("Error → exclude [execute, resume]", () => {
    const error: ExecutorState = { _tag: "Error", message: "failed" }
    const result = derive(error)
    expect(result.toolPolicy?.exclude).toEqual(["execute", "resume"])
  })

  test("Ready → no exclusions (both tools visible)", () => {
    const ready: ExecutorState = {
      _tag: "Ready",
      mode: "local",
      baseUrl: "http://127.0.0.1:4788",
      scopeId: "s1",
    }
    const result = derive(ready)
    expect(result.toolPolicy).toBeUndefined()
  })

  test("Ready + executorPrompt → prompt section at priority 85", () => {
    const ready: ExecutorState = {
      _tag: "Ready",
      mode: "local",
      baseUrl: "http://127.0.0.1:4788",
      scopeId: "s1",
      executorPrompt: "Use tools.search to discover APIs",
    }
    const result = derive(ready)
    expect(result.promptSections).toHaveLength(1)
    expect(result.promptSections![0]!.id).toBe("executor-guidance")
    expect(result.promptSections![0]!.priority).toBe(85)
    expect(result.promptSections![0]!.content).toContain("Use tools.search to discover APIs")
  })

  test("Ready without executorPrompt → no prompt sections", () => {
    const ready: ExecutorState = {
      _tag: "Ready",
      mode: "local",
      baseUrl: "http://127.0.0.1:4788",
      scopeId: "s1",
    }
    const result = derive(ready)
    expect(result.promptSections ?? []).toHaveLength(0)
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
    expect(readExecutionId({ status: "waiting_for_interaction", executionId: "exec-1" })).toBe(
      "exec-1",
    )
  })

  test("readExecutionId returns undefined for non-waiting status", () => {
    expect(readExecutionId({ status: "completed" })).toBeUndefined()
  })

  test("readExecutionId returns undefined for non-object", () => {
    expect(readExecutionId("string")).toBeUndefined()
    expect(readExecutionId(null)).toBeUndefined()
    expect(readExecutionId(undefined)).toBeUndefined()
  })
})

// ── Snapshot projection ──

describe("Executor snapshot projection", () => {
  test("Idle → { status: 'idle' }", () => {
    const result = projectSnapshot({ _tag: "Idle" } as never)
    expect(result).toEqual({ status: "idle" })
  })

  test("Connecting → { status: 'connecting' }", () => {
    const result = projectSnapshot({ _tag: "Connecting", cwd: "/test" } as never)
    expect(result).toEqual({ status: "connecting" })
  })

  test("Ready → { status: 'ready', mode, baseUrl }", () => {
    const result = projectSnapshot({
      _tag: "Ready",
      mode: "remote",
      baseUrl: "http://example.com",
      scopeId: "s1",
    } as never)
    expect(result).toEqual({ status: "ready", mode: "remote", baseUrl: "http://example.com" })
  })

  test("Error → { status: 'error', errorMessage }", () => {
    const result = projectSnapshot({ _tag: "Error", message: "timeout" } as never)
    expect(result).toEqual({ status: "error", errorMessage: "timeout" })
  })
})

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
      structuredContent: { status: "waiting_for_interaction", executionId: "exec-xyz" },
    })
    expect(result.executionId).toBe("exec-xyz")
  })

  test("no executionId when status is not waiting_for_interaction", () => {
    const result = normalizeToolResult({
      content: [{ type: "text", text: "done" }],
      structuredContent: { status: "completed" },
    })
    expect(result.executionId).toBeUndefined()
  })
})
