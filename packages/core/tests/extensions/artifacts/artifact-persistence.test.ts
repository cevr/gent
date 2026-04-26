/**
 * Integration tests verifying that plan/audit/review tools
 * persist artifacts via ArtifactProtocol.Save.
 */

import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { AgentRunResult } from "@gent/core/domain/agent"
import { Agents } from "@gent/extensions/all-agents"
import { ArtifactId, SessionId } from "@gent/core/domain/ids"
import type { Artifact } from "@gent/extensions/artifacts-protocol"
import { ARTIFACTS_EXTENSION_ID } from "@gent/extensions/artifacts-protocol"
import { PlanTool } from "@gent/extensions/plan-tool"
import { AuditTool } from "@gent/extensions/audit/audit-tool"
import { ReviewTool } from "@gent/extensions/review/review-tool"
import { testToolContext } from "@gent/core/test-utils/extension-harness"
import type { ExtensionHostContext } from "@gent/core/domain/extension-host-context"
import { RuntimePlatform } from "../../../src/runtime/runtime-platform"

// ── Spy helpers ──

interface AskCall {
  extensionId: string
  tag: string
  message: Record<string, unknown>
  branchId?: string
}

const fakeArtifact = (sourceTool: string): Artifact => ({
  id: ArtifactId.make("fake-id"),
  label: "test",
  sourceTool,
  content: "test content",
  status: "active",
  createdAt: Date.now(),
  updatedAt: Date.now(),
})

const createAskSpy = () => {
  const calls: AskCall[] = []
  const ask = (message: { extensionId: string; _tag: string } & Record<string, unknown>) => {
    calls.push({
      extensionId: message.extensionId,
      tag: message._tag,
      message,
      branchId: message.branchId as string | undefined,
    })
    return Effect.succeed(fakeArtifact(message.sourceTool as string))
  }
  return { calls, ask }
}

// ── Shared agent run stub ──

const stubAgentRun =
  (textFn?: (prompt: string) => string) =>
  (params: Parameters<ExtensionHostContext.Agent["run"]>[0]) =>
    Effect.succeed(
      AgentRunResult.Success.make({
        text: textFn?.(params.prompt) ?? "output",
        sessionId: SessionId.make("s1"),
        agentName: params.agent.name,
      }),
    )

const agentLookup = {
  get: (name: string) => Effect.succeed(Object.values(Agents).find((a) => a.name === name)),
  require: (name: string) => {
    const agent = Object.values(Agents).find((a) => a.name === name)
    return agent !== undefined ? Effect.succeed(agent) : Effect.die(`Agent "${name}" not found`)
  },
  resolveDualModelPair: () =>
    Effect.succeed(["anthropic/claude-opus-4-6", "openai/gpt-5.4"] as const),
}

const runtimePlatformLayer = RuntimePlatform.Test({
  cwd: process.cwd(),
  home: "/tmp/test-home",
  platform: "test",
})

// ── Tests ──

describe("PlanTool artifact persistence", () => {
  it.live("saves artifact on approved plan (decision=yes)", () => {
    const spy = createAskSpy()
    const ctx = testToolContext({
      extension: {
        send: () => Effect.die("send not wired"),
        ask: spy.ask as never,
        getUiSnapshots: () => Effect.die("getUiSnapshots not wired"),
        getUiSnapshot: () => Effect.die("getUiSnapshot not wired"),
      },
      agent: {
        ...agentLookup,
        run: stubAgentRun(),
      },
      interaction: {
        approve: () => Effect.die("approve not wired"),
        present: () => Effect.die("present not wired"),
        confirm: () => Effect.die("confirm not wired"),
        review: () => Effect.succeed({ decision: "yes" as const, path: "/tmp/plan.md" }),
      },
    })

    return PlanTool.effect({ prompt: "implement auth" }, ctx).pipe(
      Effect.map(() => {
        const saves = spy.calls.filter(
          (c) => c.extensionId === ARTIFACTS_EXTENSION_ID && c.tag === "Save",
        )
        expect(saves.length).toBe(1)
        expect(saves[0]!.message.sourceTool).toBe("plan")
        expect(saves[0]!.message.label).toContain("Plan:")
        expect(saves[0]!.branchId).toBe("test-branch")
      }),
    )
  })

  it.live("saves artifact on edited plan (decision=edit)", () => {
    const spy = createAskSpy()
    const ctx = testToolContext({
      extension: {
        send: () => Effect.die("send not wired"),
        ask: spy.ask as never,
        getUiSnapshots: () => Effect.die("getUiSnapshots not wired"),
        getUiSnapshot: () => Effect.die("getUiSnapshot not wired"),
      },
      agent: {
        ...agentLookup,
        run: stubAgentRun(),
      },
      interaction: {
        approve: () => Effect.die("approve not wired"),
        present: () => Effect.die("present not wired"),
        confirm: () => Effect.die("confirm not wired"),
        review: () =>
          Effect.succeed({
            decision: "edit" as const,
            path: "/tmp/plan.md",
            content: "edited plan content",
          }),
      },
    })

    return PlanTool.effect({ prompt: "implement auth" }, ctx).pipe(
      Effect.map(() => {
        const saves = spy.calls.filter(
          (c) => c.extensionId === ARTIFACTS_EXTENSION_ID && c.tag === "Save",
        )
        expect(saves.length).toBe(1)
        expect(saves[0]!.message.content).toBe("edited plan content")
      }),
    )
  })

  it.live("does NOT save artifact on rejected plan (decision=no)", () => {
    const spy = createAskSpy()
    const ctx = testToolContext({
      extension: {
        send: () => Effect.die("send not wired"),
        ask: spy.ask as never,
        getUiSnapshots: () => Effect.die("getUiSnapshots not wired"),
        getUiSnapshot: () => Effect.die("getUiSnapshot not wired"),
      },
      agent: {
        ...agentLookup,
        run: stubAgentRun(),
      },
      interaction: {
        approve: () => Effect.die("approve not wired"),
        present: () => Effect.die("present not wired"),
        confirm: () => Effect.die("confirm not wired"),
        review: () => Effect.succeed({ decision: "no" as const, path: "/tmp/plan.md" }),
      },
    })

    return PlanTool.effect({ prompt: "implement auth" }, ctx).pipe(
      Effect.map(() => {
        const saves = spy.calls.filter(
          (c) => c.extensionId === ARTIFACTS_EXTENSION_ID && c.tag === "Save",
        )
        expect(saves.length).toBe(0)
      }),
    )
  })

  it.live("fix mode saves artifact after execution", () => {
    const spy = createAskSpy()
    const ctx = testToolContext({
      extension: {
        send: () => Effect.die("send not wired"),
        ask: spy.ask as never,
        getUiSnapshots: () => Effect.die("getUiSnapshots not wired"),
        getUiSnapshot: () => Effect.die("getUiSnapshot not wired"),
      },
      agent: {
        ...agentLookup,
        run: stubAgentRun(),
      },
    })

    return PlanTool.effect({ prompt: "implement caching", mode: "fix" }, ctx).pipe(
      Effect.map(() => {
        const saves = spy.calls.filter(
          (c) => c.extensionId === ARTIFACTS_EXTENSION_ID && c.tag === "Save",
        )
        expect(saves.length).toBe(1)
        expect(saves[0]!.message.sourceTool).toBe("plan")
      }),
    )
  })
})

describe("AuditTool artifact persistence", () => {
  it.live("saves audit findings as artifact after synthesis", () => {
    const spy = createAskSpy()
    const ctx = testToolContext({
      extension: {
        send: () => Effect.die("send not wired"),
        ask: spy.ask as never,
        getUiSnapshots: () => Effect.die("getUiSnapshots not wired"),
        getUiSnapshot: () => Effect.die("getUiSnapshot not wired"),
      },
      agent: {
        ...agentLookup,
        run: stubAgentRun((prompt) => {
          if (prompt.includes("Synthesize"))
            return "1. [warning] src/auth.ts - missing input validation"
          return "1. error handling: check error paths"
        }),
      },
      interaction: {
        approve: () => Effect.die("approve not wired"),
        present: () => Effect.succeed(undefined as never),
        confirm: () => Effect.die("confirm not wired"),
        review: () => Effect.die("review not wired"),
      },
    })

    return AuditTool.effect({ paths: ["src/auth.ts"], mode: "report" }, ctx).pipe(
      Effect.map(() => {
        const saves = spy.calls.filter(
          (c) => c.extensionId === ARTIFACTS_EXTENSION_ID && c.tag === "Save",
        )
        expect(saves.length).toBe(1)
        expect(saves[0]!.message.sourceTool).toBe("audit")
        expect(saves[0]!.message.label).toContain("Audit:")
        expect(saves[0]!.message.metadata).toBeDefined()
      }),
    )
  })
})

describe("ReviewTool artifact persistence", () => {
  it.live("saves review comments as artifact after synthesis", () => {
    const spy = createAskSpy()
    const reviewJson = JSON.stringify([
      {
        file: "src/auth.ts",
        line: 10,
        severity: "high",
        type: "bug",
        text: "null check missing",
      },
    ])

    const ctx = testToolContext({
      extension: {
        send: () => Effect.die("send not wired"),
        ask: spy.ask as never,
        getUiSnapshots: () => Effect.die("getUiSnapshots not wired"),
        getUiSnapshot: () => Effect.die("getUiSnapshot not wired"),
      },
      agent: {
        ...agentLookup,
        run: stubAgentRun(() => reviewJson),
      },
    })

    return ReviewTool.effect({ content: "diff --git a/auth.ts b/auth.ts\n+code" }, ctx).pipe(
      Effect.map(() => {
        const saves = spy.calls.filter(
          (c) => c.extensionId === ARTIFACTS_EXTENSION_ID && c.tag === "Save",
        )
        expect(saves.length).toBe(1)
        expect(saves[0]!.message.sourceTool).toBe("review")
        expect(saves[0]!.message.label).toContain("Review:")
        expect(saves[0]!.message.metadata).toBeDefined()
      }),
      Effect.provide(runtimePlatformLayer),
    )
  })
})
