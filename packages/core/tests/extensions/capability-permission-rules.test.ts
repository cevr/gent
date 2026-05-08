/**
 *  — end-to-end capability permissionRules denial.
 *
 * Proves that a capability declaring `permissionRules: [deny("bash")]` causes
 * a real tool-call denial in a full agent session:
 *   1. bash tool contributed via `tool()` factory (so it appears in the registry)
 *   2. A separate extension capability carries `permissionRules: [deny("bash")]`
 *   3. `Permission.Live` is seeded with those rules (overrides `Permission.Test`)
 *   4. Provider scripts a tool call to `bash`
 *   5. Assert `ToolCallFailed` event is published for `bash`
 */
import { describe, it, expect } from "effect-bun-test"
import { Effect, type Layer, Ref, Stream, Schema } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { toolCallStep, textStep } from "@gent/core-internal/debug/provider"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { createE2ELayer } from "@gent/core-internal/test-utils/e2e-layer"
import { ensureStorageParents } from "@gent/core-internal/test-utils"
import { SessionRuntime } from "../../src/runtime/session-runtime"
import { EventStore, type EventEnvelope } from "@gent/core-internal/domain/event"
import { dateFromMillis, Message } from "@gent/core-internal/domain/message"
import { AgentName } from "@gent/core-internal/domain/agent"
import { BranchId, ExtensionId, MessageId, SessionId } from "@gent/core-internal/domain/ids"
import { Permission, PermissionRule } from "@gent/core-internal/domain/permission"
import { tool } from "@gent/core/extensions/api"
import { AllBuiltinAgents } from "../../../extensions/tests/helpers/builtin-agents.js"
import type { LoadedExtension } from "../../src/domain/extension.js"

// ── Session constants ──────────────────────────────────────────────────────

const sessionId = SessionId.make("perm-rules-e2e-session")
const branchId = BranchId.make("perm-rules-e2e-branch")
const FIXTURE_DATE = dateFromMillis(0)

const makeMessage = (text: string) =>
  Message.Regular.make({
    id: MessageId.make(`msg-perm-${text.replaceAll(" ", "-").toLowerCase()}`),
    sessionId,
    branchId,
    role: "user",
    parts: [Prompt.textPart({ text })],
    createdAt: FIXTURE_DATE,
  })

const runAgentMessage = (message: Message) =>
  Effect.gen(function* () {
    const sessionRuntime = yield* SessionRuntime
    const text = message.parts.map((part) => (part.type === "text" ? part.text : "")).join("")
    yield* sessionRuntime.runPrompt({
      sessionId: message.sessionId,
      branchId: message.branchId,
      agentName: AgentName.make("cowork"),
      prompt: text,
    })
  })

// ── Tool definitions ────────────────────────────────────────────────────────

/** Stub bash tool — the LLM will call this; permission rules will deny it. */
const bashTool = tool({
  id: "bash",
  description: "Run shell commands",
  params: Schema.Struct({ command: Schema.String }),
  output: Schema.String,
  execute: (_params) => Effect.succeed("should not run"),
})

/** A second capability whose permissionRules deny bash.
 *  In production these rules come from the winning capability on the bash tool
 *  itself; here we put them on a separate sentinel capability to prove that
 *  rules contributed by *any* winning capability reach the Permission service. */
const permissionSentinel = tool({
  id: "permission-sentinel",
  description: "Carries deny rule for bash — never called by the LLM",
  params: Schema.Struct({}),
  output: Schema.String,
  permissionRules: [new PermissionRule({ tool: "bash", action: "deny" })],
  execute: () => Effect.succeed("sentinel"),
})

// ── Extension stubs ─────────────────────────────────────────────────────────

const bashExtension: LoadedExtension = {
  manifest: { id: ExtensionId.make("test-bash-ext") },
  scope: "builtin",
  sourcePath: "test",
  contributions: { tools: [bashTool] },
}

const permissionRulesExtension: LoadedExtension = {
  manifest: { id: ExtensionId.make("test-perm-rules-ext") },
  scope: "builtin",
  sourcePath: "test",
  contributions: { tools: [permissionSentinel] },
}

// ── Test ────────────────────────────────────────────────────────────────────

describe("capability permissionRules E2E", () => {
  it.live(
    "bash tool call denied when Permission.Live has deny rule for bash",
    () =>
      Effect.gen(function* () {
        // Step 1: model calls bash → step 2: model sends text after seeing error result
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          toolCallStep("bash", { command: "ls -la" }),
          textStep("Understood, bash is denied."),
        ])

        // Override Permission.Test() with a live instance seeded with the deny rule
        const permissionLive = Permission.Live(
          [new PermissionRule({ tool: "bash", action: "deny" })],
          "allow",
        )

        const e2eLayer = createE2ELayer({
          agents: AllBuiltinAgents,
          extensionInputs: [],
          // Pass extensions directly — bypass setupBuiltinExtensions overhead
          extensions: [bashExtension, permissionRulesExtension],
          providerLayer,
          extraLayers: [permissionLive as Layer.Layer<never>],
        })

        yield* Effect.gen(function* () {
          const eventStore = yield* EventStore
          yield* ensureStorageParents({ sessionId, branchId })

          // Subscribe to events before running so we catch everything
          const envelopesRef = yield* Ref.make<EventEnvelope[]>([])
          yield* Effect.forkChild(
            eventStore.subscribe({ sessionId, branchId }).pipe(
              Stream.runForEach((env) => Ref.update(envelopesRef, (current) => [...current, env])),
              Effect.catchCause(() => Effect.void),
            ),
          )

          yield* runAgentMessage(makeMessage("run ls"))

          const envelopes = yield* Ref.get(envelopesRef)

          const failed = envelopes.filter((e) => e.event._tag === "ToolCallFailed")
          expect(failed.length).toBeGreaterThanOrEqual(1)

          const bashFailed = failed.find(
            (e) => (e.event as { toolName: string }).toolName === "bash",
          )
          expect(bashFailed).toBeDefined()

          // Sanity: no ToolCallSucceeded for bash
          const succeeded = envelopes.filter(
            (e) =>
              e.event._tag === "ToolCallSucceeded" &&
              (e.event as { toolName: string }).toolName === "bash",
          )
          expect(succeeded.length).toBe(0)
        }).pipe(Effect.provide(e2eLayer))
      }).pipe(Effect.timeout("28 seconds")),
    30_000,
  )

  it.live(
    "bash tool call allowed when no deny rule is present (control case)",
    () =>
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          toolCallStep("bash", { command: "echo hello" }),
          textStep("Bash ran successfully."),
        ])

        // Default Permission.Test() — always allow; no extraLayers override
        const e2eLayer = createE2ELayer({
          agents: AllBuiltinAgents,
          extensionInputs: [],
          extensions: [bashExtension],
          providerLayer,
        })

        yield* Effect.gen(function* () {
          const eventStore = yield* EventStore
          yield* ensureStorageParents({ sessionId, branchId })

          const envelopesRef = yield* Ref.make<EventEnvelope[]>([])
          yield* Effect.forkChild(
            eventStore.subscribe({ sessionId, branchId }).pipe(
              Stream.runForEach((env) => Ref.update(envelopesRef, (current) => [...current, env])),
              Effect.catchCause(() => Effect.void),
            ),
          )

          yield* runAgentMessage(makeMessage("run echo"))

          const envelopes = yield* Ref.get(envelopesRef)

          // With Permission.Test() (always allow), bash call must succeed
          const succeeded = envelopes.filter(
            (e) =>
              e.event._tag === "ToolCallSucceeded" &&
              (e.event as { toolName: string }).toolName === "bash",
          )
          expect(succeeded.length).toBe(1)

          const failed = envelopes.filter(
            (e) =>
              e.event._tag === "ToolCallFailed" &&
              (e.event as { toolName: string }).toolName === "bash",
          )
          expect(failed.length).toBe(0)
        }).pipe(Effect.provide(e2eLayer))
      }).pipe(Effect.timeout("28 seconds")),
    30_000,
  )
})
