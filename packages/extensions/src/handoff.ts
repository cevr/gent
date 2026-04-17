import { Effect, Layer, Schema } from "effect"
import { Event as MEvent, Machine, State as MState } from "effect-machine"
import {
  defineExtension,
  defineResource,
  interceptorContribution,
  defineInterceptor,
  toolContribution,
  type ExtensionHostContext,
  type Message,
  type ResourceMachine,
  type TurnAfterInput,
} from "@gent/core/extensions/api"
import { HandoffTool } from "./handoff-tool.js"
import { HANDOFF_EXTENSION_ID, HandoffProtocol } from "./handoff-protocol.js"
import { AutoProtocol } from "./auto-protocol.js"

const EXTENSION_ID = HANDOFF_EXTENSION_ID

// ── Workflow: cooldown counter ──
//
// State: a single integer. Suppressed by `Suppress(count)`, decremented on
// every `TurnCompleted`. Replaces the pre-C8b actor that conflated this
// state with a UI snapshot (the snapshot was only used for self-reads).
// Self-reads now go through `GetCooldown` reply — typed and explicit.

const CooldownState = MState({
  Active: { cooldown: Schema.Number },
})

const CooldownEvent = MEvent({
  TurnCompleted: {},
  Suppress: { count: Schema.Number },
  GetCooldown: MEvent.reply({}, Schema.Number),
})

const cooldownMachine = Machine.make({
  state: CooldownState,
  event: CooldownEvent,
  initial: CooldownState.Active({ cooldown: 0 }),
})
  .on(CooldownState.Active, CooldownEvent.TurnCompleted, ({ state }) =>
    state.cooldown > 0 ? CooldownState.Active({ cooldown: state.cooldown - 1 }) : state,
  )
  .on(CooldownState.Active, CooldownEvent.Suppress, ({ event }) =>
    CooldownState.Active({ cooldown: event.count }),
  )
  .on(CooldownState.Active, CooldownEvent.GetCooldown, ({ state }) =>
    Machine.reply(state, state.cooldown),
  )

const cooldownWorkflow: ResourceMachine<typeof CooldownState.Type, typeof CooldownEvent.Type> = {
  machine: cooldownMachine,
  mapEvent: (event) => (event._tag === "TurnCompleted" ? CooldownEvent.TurnCompleted : undefined),
  mapCommand: (message) =>
    HandoffProtocol.Suppress.is(message)
      ? CooldownEvent.Suppress({ count: message.count })
      : undefined,
  mapRequest: (message) =>
    HandoffProtocol.GetCooldown.is(message) ? CooldownEvent.GetCooldown : undefined,
  protocols: HandoffProtocol,
}

// ── Interceptor: turn.after — auto-handoff at context-fill threshold ──

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

const autoHandoffImpl = (
  input: TurnAfterInput,
  next: (input: TurnAfterInput) => Effect.Effect<void>,
  ctx: ExtensionHostContext,
) =>
  Effect.gen(function* () {
    yield* next(input)

    if (input.interrupted) return

    // Auto owns its own handoff flow — skip generic threshold handoff when active
    const autoActive = yield* ctx.extension
      .ask(AutoProtocol.IsActive())
      .pipe(Effect.catchEager(() => Effect.succeed(false)))
    if (autoActive) return

    // Self-read of cooldown via typed protocol — replaces the C8a-era
    // `getUiSnapshot` self-read. Workflows do NOT carry UI snapshots; cross-
    // and self-reads of workflow state go through typed reply messages.
    const cooldown = yield* ctx.extension
      .ask(HandoffProtocol.GetCooldown())
      .pipe(Effect.catchEager(() => Effect.succeed(0)))
    if (cooldown > 0) return // Cooldown active — workflow handles decrement via TurnCompleted

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
      yield* ctx.extension
        .send(HandoffProtocol.Suppress({ count: 5 }))
        .pipe(Effect.catchEager(() => Effect.void))
    }
  }).pipe(Effect.catchEager(() => Effect.void))

export const HandoffExtension = defineExtension({
  id: EXTENSION_ID,
  contributions: () => [
    toolContribution(HandoffTool),
    interceptorContribution(defineInterceptor("turn.after", autoHandoffImpl)),
    // Cooldown machine — process-scope, no service, supervised by WorkflowRuntime.
    defineResource<unknown, "process">({
      scope: "process",
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      layer: Layer.empty as Layer.Layer<unknown>,
      machine: cooldownWorkflow,
    }),
  ],
})
