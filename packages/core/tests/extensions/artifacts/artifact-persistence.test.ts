/**
 * Integration tests verifying that plan/audit/review tools
 * persist artifacts via ArtifactRpc.Save.
 */

import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"

// PlanTool/AuditTool/ReviewTool .effect signatures inherit R=any from
// the AnyCapabilityContribution cast in the tool() factory. Tests run
// with no real services beyond ctx, so we narrow R to never at the
// call site for it.live compatibility.
const narrowR = <A, E>(e: Effect.Effect<A, E, unknown>): Effect.Effect<A, E, never> =>
  e as Effect.Effect<A, E, never>
import { AgentRunResult } from "@gent/core/domain/agent"
import { Agents } from "@gent/extensions/all-agents"
import type { AgentName } from "@gent/core/domain/agent"
import { ArtifactId, SessionId } from "@gent/core/domain/ids"
import { ModelId } from "@gent/core/domain/model"
import { ref } from "@gent/core/extensions/api"
import type { Artifact } from "@gent/extensions/artifacts-protocol"
import { ARTIFACTS_EXTENSION_ID, ArtifactRpc } from "@gent/extensions/artifacts-protocol"
import { PlanTool } from "@gent/extensions/plan-tool"
import { AuditTool } from "@gent/extensions/audit/audit-tool"
import { ReviewTool } from "@gent/extensions/review/review-tool"
import { testToolContext } from "@gent/core/test-utils/extension-harness"
import type { ExtensionHostContext } from "@gent/core/domain/extension-host-context"
import { RuntimePlatform } from "../../../src/runtime/runtime-platform"

// ── Spy helpers ──

interface RequestCall {
  extensionId: string
  capabilityId: string
  input: Record<string, unknown>
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

const ArtifactSaveRef = ref(ArtifactRpc.Save)

const createRequestSpy = () => {
  const calls: RequestCall[] = []
  const request = (
    capability: typeof ArtifactSaveRef,
    input: Record<string, unknown>,
  ): Effect.Effect<Artifact> => {
    calls.push({
      extensionId: capability.extensionId,
      capabilityId: capability.capabilityId,
      input,
    })
    return Effect.succeed(fakeArtifact(input["sourceTool"] as string))
  }
  return { calls, request }
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
  get: (name: AgentName) => Effect.succeed(Object.values(Agents).find((a) => a.name === name)),
  require: (name: AgentName) => {
    const agent = Object.values(Agents).find((a) => a.name === name)
    return agent !== undefined ? Effect.succeed(agent) : Effect.die(`Agent "${name}" not found`)
  },
  resolveDualModelPair: () =>
    Effect.succeed([
      ModelId.make("anthropic/claude-opus-4-6"),
      ModelId.make("openai/gpt-5.4"),
    ] as const),
}

const runtimePlatformLayer = RuntimePlatform.Test({
  cwd: process.cwd(),
  home: "/tmp/test-home",
  platform: "test",
})

// ── Tests ──

describe("PlanTool artifact persistence", () => {
  it.live("saves artifact on approved plan (decision=yes)", () => {
    const spy = createRequestSpy()
    const ctx = testToolContext({
      extension: {
        send: () => Effect.die("send not wired"),
        request: spy.request as never,
        ask: () => Effect.die("ask not wired"),
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

    return narrowR(
      PlanTool.effect({ prompt: "implement auth" }, ctx).pipe(
        Effect.map(() => {
          const saves = spy.calls.filter(
            (c) => c.extensionId === ARTIFACTS_EXTENSION_ID && c.capabilityId === "artifact.save",
          )
          expect(saves.length).toBe(1)
          expect(saves[0]!.input["sourceTool"]).toBe("plan")
          expect(saves[0]!.input["label"]).toContain("Plan:")
          expect(saves[0]!.input["branchId"]).toBe("test-branch")
        }),
      ),
    )
  })

  it.live("saves artifact on edited plan (decision=edit)", () => {
    const spy = createRequestSpy()
    const ctx = testToolContext({
      extension: {
        send: () => Effect.die("send not wired"),
        request: spy.request as never,
        ask: () => Effect.die("ask not wired"),
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

    return narrowR(
      PlanTool.effect({ prompt: "implement auth" }, ctx).pipe(
        Effect.map(() => {
          const saves = spy.calls.filter(
            (c) => c.extensionId === ARTIFACTS_EXTENSION_ID && c.capabilityId === "artifact.save",
          )
          expect(saves.length).toBe(1)
          expect(saves[0]!.input["content"]).toBe("edited plan content")
        }),
      ),
    )
  })

  it.live("does NOT save artifact on rejected plan (decision=no)", () => {
    const spy = createRequestSpy()
    const ctx = testToolContext({
      extension: {
        send: () => Effect.die("send not wired"),
        request: spy.request as never,
        ask: () => Effect.die("ask not wired"),
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

    return narrowR(
      PlanTool.effect({ prompt: "implement auth" }, ctx).pipe(
        Effect.map(() => {
          const saves = spy.calls.filter(
            (c) => c.extensionId === ARTIFACTS_EXTENSION_ID && c.capabilityId === "artifact.save",
          )
          expect(saves.length).toBe(0)
        }),
      ),
    )
  })

  it.live("fix mode saves artifact after execution", () => {
    const spy = createRequestSpy()
    const ctx = testToolContext({
      extension: {
        send: () => Effect.die("send not wired"),
        request: spy.request as never,
        ask: () => Effect.die("ask not wired"),
      },
      agent: {
        ...agentLookup,
        run: stubAgentRun(),
      },
    })

    return narrowR(
      PlanTool.effect({ prompt: "implement caching", mode: "fix" }, ctx).pipe(
        Effect.map(() => {
          const saves = spy.calls.filter(
            (c) => c.extensionId === ARTIFACTS_EXTENSION_ID && c.capabilityId === "artifact.save",
          )
          expect(saves.length).toBe(1)
          expect(saves[0]!.input["sourceTool"]).toBe("plan")
        }),
      ),
    )
  })
})

describe("AuditTool artifact persistence", () => {
  it.live("saves audit findings as artifact after synthesis", () => {
    const spy = createRequestSpy()
    const ctx = testToolContext({
      extension: {
        send: () => Effect.die("send not wired"),
        request: spy.request as never,
        ask: () => Effect.die("ask not wired"),
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

    return narrowR(
      AuditTool.effect({ paths: ["src/auth.ts"], mode: "report" }, ctx).pipe(
        Effect.map(() => {
          const saves = spy.calls.filter(
            (c) => c.extensionId === ARTIFACTS_EXTENSION_ID && c.capabilityId === "artifact.save",
          )
          expect(saves.length).toBe(1)
          expect(saves[0]!.input["sourceTool"]).toBe("audit")
          expect(saves[0]!.input["label"]).toContain("Audit:")
          expect(saves[0]!.input["metadata"]).toBeDefined()
        }),
      ),
    )
  })
})

describe("ReviewTool artifact persistence", () => {
  it.live("saves review comments as artifact after synthesis", () => {
    const spy = createRequestSpy()
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
        request: spy.request as never,
        ask: () => Effect.die("ask not wired"),
      },
      agent: {
        ...agentLookup,
        run: stubAgentRun(() => reviewJson),
      },
    })

    return narrowR(
      ReviewTool.effect({ content: "diff --git a/auth.ts b/auth.ts\n+code" }, ctx).pipe(
        Effect.map(() => {
          const saves = spy.calls.filter(
            (c) => c.extensionId === ARTIFACTS_EXTENSION_ID && c.capabilityId === "artifact.save",
          )
          expect(saves.length).toBe(1)
          expect(saves[0]!.input["sourceTool"]).toBe("review")
          expect(saves[0]!.input["label"]).toContain("Review:")
          expect(saves[0]!.input["metadata"]).toBeDefined()
        }),
        Effect.provide(runtimePlatformLayer),
      ),
    )
  })
})
