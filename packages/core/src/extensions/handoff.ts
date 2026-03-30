import { Effect, Schema } from "effect"
import { defineExtension, defineInterceptor } from "../domain/extension.js"
import type { TurnAfterInput } from "../domain/extension.js"
import type { Message } from "../domain/message.js"
import { HandoffHandler } from "../domain/interaction-handlers.js"
import { HandoffTool } from "../tools/handoff.js"
import { Storage } from "../storage/sqlite-storage.js"
import { ExtensionRegistry } from "../runtime/extensions/registry.js"
import { ExtensionStateRuntime } from "../runtime/extensions/state-runtime.js"
import { resolveAgentModel, DEFAULT_MODEL_ID } from "../domain/agent.js"
import { estimateContextPercent } from "../runtime/context-estimation.js"
import { DEFAULTS } from "../domain/defaults.js"
import { fromReducer } from "../runtime/extensions/from-reducer.js"

// Cooldown state — per session, managed by actor lifecycle
interface CooldownState {
  readonly cooldown: number
}

const CooldownIntent = Schema.TaggedStruct("Suppress", { count: Schema.Number })
type CooldownIntent = typeof CooldownIntent.Type

const EXTENSION_ID = "@gent/handoff"

const { spawnActor: CooldownActor } = fromReducer<CooldownState, CooldownIntent>({
  id: EXTENSION_ID,
  initial: { cooldown: 0 },
  intentSchema: CooldownIntent,
  reduce: (state, event) => {
    // Decrement cooldown on each completed turn
    if (event._tag === "TurnCompleted" && state.cooldown > 0) {
      return { state: { cooldown: state.cooldown - 1 } }
    }
    return { state }
  },
  handleIntent: (state, intent) => {
    if (intent._tag === "Suppress") {
      return { state: { cooldown: intent.count } }
    }
    return { state }
  },
})

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

// Auto-handoff interceptor — runs in agent loop scope where services are ambient
const autoHandoffImpl = (
  input: TurnAfterInput,
  next: (input: TurnAfterInput) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    yield* next(input)

    if (input.interrupted) return

    // Read cooldown from actor state
    const stateRuntime = yield* ExtensionStateRuntime
    const actorState = yield* stateRuntime.getUiSnapshots(input.sessionId, input.branchId).pipe(
      Effect.map((snapshots) => {
        const snap = snapshots.find((s) => s.extensionId === EXTENSION_ID)
        return (snap?.model as CooldownState | undefined)?.cooldown ?? 0
      }),
      Effect.catchEager(() => Effect.succeed(0)),
    )

    if (actorState > 0) return // Cooldown active — actor handles decrement via TurnCompleted

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
      // Set cooldown via actor intent — will be cleaned up when session terminates
      yield* stateRuntime
        .handleIntent(input.sessionId, EXTENSION_ID, { _tag: "Suppress", count: 5 }, 0)
        .pipe(Effect.catchEager(() => Effect.void))
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
  manifest: { id: EXTENSION_ID },
  setup: () =>
    Effect.succeed({
      tools: [HandoffTool],
      interactionHandlers: [{ type: "handoff" as const, layer: HandoffHandler.Live }],
      hooks: { interceptors: [autoHandoffInterceptor] },
      spawnActor: CooldownActor,
      projection: { deriveUi: (state: unknown) => state },
    }),
})
