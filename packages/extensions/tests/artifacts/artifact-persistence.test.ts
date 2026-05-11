/**
 * Integration tests verifying that plan/audit/review tools
 * persist artifacts via ArtifactsWrite.
 */

import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer } from "effect"
import { narrowR } from "../../../core/tests/helpers/effect"

// PlanTool/AuditTool/ReviewTool execution signatures inherit their
// dependency channels from Gent metadata. Tests run
// with no real services beyond ctx, so we narrow R to never at the
// call site for it.live compatibility.
import {
  AgentRunResult,
  type AgentName,
  type ExtensionContextService,
} from "@gent/core/extensions/api"
import { AllBuiltinAgents } from "../helpers/builtin-agents.js"
import {
  ArtifactId,
  BranchId,
  type BranchId as BranchIdType,
  SessionId,
} from "@gent/core-internal/domain/ids"
import { getToolEffect } from "@gent/core-internal/domain/capability/tool"
import type { Artifact } from "../../src/artifacts-protocol.js"
import { PlanTool } from "../../src/plan-tool.js"
import { AuditTool } from "../../src/audit/audit-tool.js"
import { ReviewTool } from "../../src/review/review-tool.js"
import { testToolContext } from "@gent/core-internal/test-utils/extension-harness"
import { RuntimeEnvironment } from "@gent/core-internal/runtime/runtime-environment"
import {
  ArtifactsWrite,
  type ArtifactSaveInput,
  type ArtifactUpdateInput,
} from "../../src/artifacts/store.js"

// ── Spy helpers ──

interface RequestCall {
  sessionId: SessionId
  branchId: BranchIdType
  input: ArtifactSaveInput
}

const FIXTURE_MS = 1_700_000_000_000

const fakeArtifact = (sourceTool: string): Artifact => ({
  id: ArtifactId.make("fake-id"),
  label: "test",
  sourceTool,
  content: "test content",
  status: "active",
  createdAt: FIXTURE_MS,
  updatedAt: FIXTURE_MS,
})

const createArtifactSpy = () => {
  const calls: RequestCall[] = []
  const service = {
    read: () => Effect.succeed<Artifact | null>(null),
    list: () => Effect.succeed<ReadonlyArray<Artifact>>([]),
    save: (sessionId: SessionId, branchId: BranchId, input: ArtifactSaveInput) => {
      calls.push({ sessionId, branchId, input })
      return Effect.succeed(fakeArtifact(input.sourceTool))
    },
    update: (_sessionId: SessionId, _branchId: BranchId, _input: ArtifactUpdateInput) =>
      Effect.succeed<Artifact | null>(null),
    clear: () => Effect.void,
  }
  return { calls, layer: Layer.succeed(ArtifactsWrite, service) }
}

// ── Shared agent run stub ──

const stubAgentRun =
  (textFn?: (prompt: string) => string) =>
  (params: Parameters<ExtensionContextService["Agent"]["run"]>[0]) =>
    Effect.succeed(
      AgentRunResult.Success.make({
        text: textFn?.(params.prompt) ?? "output",
        sessionId: SessionId.make("s1"),
        agentName: params.agent.name,
      }),
    )

const agentLookup = {
  get: (name: AgentName) => Effect.succeed(AllBuiltinAgents.find((a) => a.name === name)),
  require: (name: AgentName) => {
    const agent = AllBuiltinAgents.find((a) => a.name === name)
    return agent !== undefined ? Effect.succeed(agent) : Effect.die(`Agent "${name}" not found`)
  },
  listAgents: () => Effect.succeed(AllBuiltinAgents),
}

const runtimeEnvironmentLayer = RuntimeEnvironment.Test({
  cwd: process.cwd(),
  home: "/tmp/test-home",
  platform: "test",
})

// ── Tests ──

describe("PlanTool artifact persistence", () => {
  it.live("saves artifact on approved plan (decision=yes)", () => {
    const spy = createArtifactSpy()
    const ctx = testToolContext({
      Agent: {
        ...agentLookup,
        run: stubAgentRun(),
      },
      Interaction: {
        approve: () => Effect.die("approve not wired"),
        present: () => Effect.die("present not wired"),
        confirm: () => Effect.die("confirm not wired"),
        review: () => Effect.succeed({ decision: "yes" as const, path: "/tmp/plan.md" }),
      },
    })

    return narrowR(
      getToolEffect(PlanTool)({ prompt: "implement auth" }, ctx).pipe(
        Effect.map(() => {
          const saves = spy.calls
          expect(saves.length).toBe(1)
          expect(saves[0]!.input.sourceTool).toBe("plan")
          expect(saves[0]!.input.label).toContain("Plan:")
          expect(saves[0]!.branchId).toBe(BranchId.make("test-branch"))
        }),
        Effect.provide(spy.layer),
      ),
    )
  })

  it.live("saves artifact on edited plan (decision=edit)", () => {
    const spy = createArtifactSpy()
    const ctx = testToolContext({
      Agent: {
        ...agentLookup,
        run: stubAgentRun(),
      },
      Interaction: {
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
      getToolEffect(PlanTool)({ prompt: "implement auth" }, ctx).pipe(
        Effect.map(() => {
          const saves = spy.calls
          expect(saves.length).toBe(1)
          expect(saves[0]!.input.content).toBe("edited plan content")
        }),
        Effect.provide(spy.layer),
      ),
    )
  })

  it.live("does NOT save artifact on rejected plan (decision=no)", () => {
    const spy = createArtifactSpy()
    const ctx = testToolContext({
      Agent: {
        ...agentLookup,
        run: stubAgentRun(),
      },
      Interaction: {
        approve: () => Effect.die("approve not wired"),
        present: () => Effect.die("present not wired"),
        confirm: () => Effect.die("confirm not wired"),
        review: () => Effect.succeed({ decision: "no" as const, path: "/tmp/plan.md" }),
      },
    })

    return narrowR(
      getToolEffect(PlanTool)({ prompt: "implement auth" }, ctx).pipe(
        Effect.map(() => {
          const saves = spy.calls
          expect(saves.length).toBe(0)
        }),
        Effect.provide(spy.layer),
      ),
    )
  })

  it.live("fix mode saves artifact after execution", () => {
    const spy = createArtifactSpy()
    const ctx = testToolContext({
      Agent: {
        ...agentLookup,
        run: stubAgentRun(),
      },
    })

    return narrowR(
      getToolEffect(PlanTool)({ prompt: "implement caching", mode: "fix" }, ctx).pipe(
        Effect.map(() => {
          const saves = spy.calls
          expect(saves.length).toBe(1)
          expect(saves[0]!.input.sourceTool).toBe("plan")
        }),
        Effect.provide(spy.layer),
      ),
    )
  })
})

describe("AuditTool artifact persistence", () => {
  it.live("saves audit findings as artifact after synthesis", () => {
    const spy = createArtifactSpy()
    const ctx = testToolContext({
      Agent: {
        ...agentLookup,
        run: stubAgentRun((prompt) => {
          if (prompt.includes("Synthesize"))
            return "1. [warning] src/auth.ts - missing input validation"
          return "1. error handling: check error paths"
        }),
      },
      Interaction: {
        approve: () => Effect.die("approve not wired"),
        present: () => Effect.succeed(undefined as never),
        confirm: () => Effect.die("confirm not wired"),
        review: () => Effect.die("review not wired"),
      },
    })

    return narrowR(
      getToolEffect(AuditTool)({ paths: ["src/auth.ts"], mode: "report" }, ctx).pipe(
        Effect.map(() => {
          const saves = spy.calls
          expect(saves.length).toBe(1)
          expect(saves[0]!.input.sourceTool).toBe("audit")
          expect(saves[0]!.input.label).toContain("Audit:")
          expect(saves[0]!.input.metadata).toBeDefined()
        }),
        Effect.provide(spy.layer),
      ),
    )
  })
})

describe("ReviewTool artifact persistence", () => {
  it.live("saves review comments as artifact after synthesis", () => {
    const spy = createArtifactSpy()
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
      Agent: {
        ...agentLookup,
        run: stubAgentRun(() => reviewJson),
      },
    })

    return narrowR(
      getToolEffect(ReviewTool)({ content: "diff --git a/auth.ts b/auth.ts\n+code" }, ctx).pipe(
        Effect.map(() => {
          const saves = spy.calls
          expect(saves.length).toBe(1)
          expect(saves[0]!.input.sourceTool).toBe("review")
          expect(saves[0]!.input.label).toContain("Review:")
          expect(saves[0]!.input.metadata).toBeDefined()
        }),
        Effect.provide(Layer.merge(runtimeEnvironmentLayer, spy.layer)),
      ),
    )
  })
})
