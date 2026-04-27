import { Effect, Layer, Schema } from "effect"
import {
  defineExtension,
  defineResource,
  resource,
  behavior,
  ServiceKey,
  TaggedEnumClass,
  type Behavior,
  type ExtensionHostContext,
  type Message,
  type TurnAfterInput,
} from "@gent/core/extensions/api"
import { HandoffTool } from "./handoff-tool.js"
import { HANDOFF_EXTENSION_ID } from "./handoff-protocol.js"
import { AutoProtocol } from "./auto-protocol.js"

const EXTENSION_ID = HANDOFF_EXTENSION_ID

// ── Cooldown actor ──
//
// State: a single integer. Suppressed by `Suppress(count)`, decremented on
// every `TurnCompleted`. The slot handler below tells the actor on every
// post-turn tick (interim until W10-4 lifts subscriptions to actor messages).
// `GetCooldown` is the only legitimate cross-call read — workflows / actors
// declare effects, projections derive views, and neither owns ad-hoc state
// peeks (per `composability-not-flags`).

export const CooldownMsg = TaggedEnumClass("CooldownMsg", {
  TurnCompleted: {},
  Suppress: { count: Schema.Number },
  GetCooldown: {},
})
export type CooldownMsg = Schema.Schema.Type<typeof CooldownMsg>

interface CooldownState {
  readonly cooldown: number
}

export const CooldownService = ServiceKey<CooldownMsg>("@gent/handoff/cooldown")

const cooldownBehavior: Behavior<CooldownMsg, CooldownState, never> = {
  initialState: { cooldown: 0 },
  serviceKey: CooldownService,
  receive: (msg, state, ctx) =>
    Effect.gen(function* () {
      switch (msg._tag) {
        case "TurnCompleted":
          return state.cooldown > 0 ? { cooldown: state.cooldown - 1 } : state
        case "Suppress":
          return { cooldown: msg.count }
        case "GetCooldown":
          yield* ctx.reply(state.cooldown)
          return state
      }
    }),
}

// ── Subscription: turn.after — auto-handoff at context-fill threshold ──

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

const autoHandoffImpl = (input: TurnAfterInput, ctx: ExtensionHostContext) =>
  Effect.gen(function* () {
    if (input.interrupted) return

    const refs = yield* ctx.actors.find(CooldownService)
    const cooldownRef = refs[0]
    if (cooldownRef === undefined) return

    // Decrement bridge: turnAfter is the natural place to drive the
    // cooldown clock until W10-4 lifts subscriptions to actor messages.
    yield* ctx.actors
      .tell(cooldownRef, CooldownMsg.TurnCompleted.make({}))
      .pipe(Effect.catchEager(() => Effect.void))

    // Auto owns its own handoff flow — skip generic threshold handoff when active
    const autoActive = yield* ctx.extension
      .ask(AutoProtocol.IsActive.make())
      .pipe(Effect.catchEager(() => Effect.succeed(false)))
    if (autoActive) return

    const cooldown = yield* ctx.actors
      .ask(cooldownRef, CooldownMsg.GetCooldown.make({}), (n: number) => {
        // Reply token pins the answer type `A = number` for ask
        // correlation. The returned message is never enqueued — the
        // engine threads `n` back through the pending Deferred.
        void n
        return CooldownMsg.GetCooldown.make({})
      })
      .pipe(Effect.catchEager(() => Effect.succeed(0)))
    if (cooldown > 0) return

    const contextPercent = yield* ctx.session.estimateContextPercent()
    const handoffThreshold = 85
    if (contextPercent < handoffThreshold) return

    yield* Effect.logInfo("auto-handoff.threshold").pipe(
      Effect.annotateLogs({
        contextPercent,
        threshold: handoffThreshold,
      }),
    )

    const allMessages = yield* ctx.session.listMessages()
    const decision = yield* ctx.interaction
      .approve({
        text: summarizeRecentMessages(allMessages),
        metadata: {
          type: "handoff",
          reason: `Context at ${contextPercent}% (threshold: ${handoffThreshold}%)`,
        },
      })
      .pipe(Effect.catchEager(() => Effect.succeed({ approved: false })))

    if (!decision.approved) {
      yield* ctx.actors
        .tell(cooldownRef, CooldownMsg.Suppress.make({ count: 5 }))
        .pipe(Effect.catchEager(() => Effect.void))
    }
  }).pipe(Effect.catchEager(() => Effect.void))

export const HandoffExtension = defineExtension({
  id: EXTENSION_ID,
  tools: [HandoffTool],
  actors: [behavior(cooldownBehavior)],
  // Resource shell carries the turnAfter slot until W10-5 lifts slots
  // off Resource and W10-4 turns turn.after into an actor message.
  resources: [
    resource(
      defineResource({
        scope: "process",
        layer: Layer.empty,
        runtime: {
          turnAfter: {
            failureMode: "isolate",
            handler: autoHandoffImpl,
          },
        },
      }),
    ),
  ],
})
