import { Effect } from "effect"
import { defineExtension, defineInterceptor } from "../domain/extension.js"
import type { TurnAfterInput } from "../domain/extension.js"
import type { Message } from "../domain/message.js"
import { HandoffHandler } from "../domain/interaction-handlers.js"
import { HandoffTool } from "../tools/handoff.js"
import { Storage } from "../storage/sqlite-storage.js"
import { ExtensionRegistry } from "../runtime/extensions/registry.js"
import { resolveAgentModel, DEFAULT_MODEL_ID } from "../domain/agent.js"
import { estimateContextPercent } from "../runtime/context-estimation.js"
import { DEFAULTS } from "../domain/defaults.js"

/** Cooldown counter per session:branch — suppresses auto-handoff for N turns after rejection */
const cooldowns = new Map<string, number>()

const cooldownKey = (sessionId: string, branchId: string) => `${sessionId}:${branchId}`

const summarizeRecentMessages = (messages: ReadonlyArray<Message>) => {
  const recentText = messages
    .slice(-20)
    .map((m) => {
      const text = m.parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("\n")
      return text !== "" ? `${m.role}: ${text}` : ""
    })
    .filter((line) => line.length > 0)
    .join("\n\n")
  return recentText.length > 0 ? recentText.slice(0, 4000) : "Session context"
}

// Auto-handoff interceptor — runs in agent loop scope where Storage/Registry/HandoffHandler are available
const autoHandoffImpl = (
  input: TurnAfterInput,
  next: (input: TurnAfterInput) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    yield* next(input)

    if (input.interrupted) return

    const key = cooldownKey(input.sessionId, input.branchId)
    const suppress = cooldowns.get(key) ?? 0
    if (suppress > 0) {
      cooldowns.set(key, suppress - 1)
      return
    }

    const storage = yield* Storage
    const registry = yield* ExtensionRegistry

    const allMessages = yield* storage.listMessages(input.branchId)
    const currentAgentDef = yield* registry.getAgent(input.agentName)
    const coworkDef = yield* registry.getAgent("cowork")
    const agentForModel = currentAgentDef ?? coworkDef
    const modelId =
      agentForModel !== undefined ? resolveAgentModel(agentForModel) : DEFAULT_MODEL_ID
    const contextPercent = estimateContextPercent(allMessages, modelId)
    if (contextPercent < DEFAULTS.handoffThresholdPercent) return

    yield* Effect.logInfo("auto-handoff.threshold").pipe(
      Effect.annotateLogs({
        contextPercent,
        threshold: DEFAULTS.handoffThresholdPercent,
      }),
    )

    const handoffHandler = yield* HandoffHandler
    const decision = yield* handoffHandler
      .present({
        sessionId: input.sessionId,
        branchId: input.branchId,
        summary: summarizeRecentMessages(allMessages),
        reason: `Context at ${contextPercent}% (threshold: ${DEFAULTS.handoffThresholdPercent}%)`,
      })
      .pipe(Effect.catchEager(() => Effect.succeed("reject" as const)))

    if (decision === "reject") {
      cooldowns.set(key, 5)
    }
  }).pipe(Effect.catchEager(() => Effect.void))

// Cast: interceptor runs in agent loop fiber where these services exist in scope
const autoHandoffInterceptor = defineInterceptor(
  "turn.after",
  autoHandoffImpl as unknown as (
    input: TurnAfterInput,
    next: (input: TurnAfterInput) => Effect.Effect<void>,
  ) => Effect.Effect<void>,
)

export const HandoffExtension = defineExtension({
  manifest: { id: "@gent/handoff" },
  setup: () =>
    Effect.succeed({
      tools: [HandoffTool],
      interactionHandlers: [{ type: "handoff" as const, layer: HandoffHandler.Live }],
      hooks: { interceptors: [autoHandoffInterceptor] },
    }),
})
