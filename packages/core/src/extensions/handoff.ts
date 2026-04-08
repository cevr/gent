import { Effect, Schema } from "effect"
import { Event as MEvent, Machine, State as MState } from "effect-machine"
import type { ExtensionActorDefinition, TurnAfterInput } from "../domain/extension.js"
import type { ExtensionHostContext } from "../domain/extension-host-context.js"
import type { Message } from "../domain/message.js"
import { HandoffTool } from "./handoff-tool.js"
import { DEFAULTS } from "../domain/defaults.js"
import { extension } from "./api.js"
import { HANDOFF_EXTENSION_ID, HandoffProtocol } from "./handoff-protocol.js"
import { AutoProtocol } from "./auto-protocol.js"

// Cooldown state — per session, managed by actor lifecycle
interface CooldownState {
  readonly cooldown: number
}

const CooldownIntent = Schema.TaggedStruct("Suppress", { count: Schema.Number })
type CooldownIntent = typeof CooldownIntent.Type

const EXTENSION_ID = HANDOFF_EXTENSION_ID

const CooldownMachineState = MState({
  Active: {
    cooldown: Schema.Number,
  },
})

const CooldownMachineEvent = MEvent({
  TurnCompleted: {},
  Suppress: {
    count: Schema.Number,
  },
})

const cooldownMachine = Machine.make({
  state: CooldownMachineState,
  event: CooldownMachineEvent,
  initial: CooldownMachineState.Active({ cooldown: 0 }),
})
  .on(CooldownMachineState.Active, CooldownMachineEvent.TurnCompleted, ({ state }) =>
    state.cooldown > 0 ? CooldownMachineState.Active({ cooldown: state.cooldown - 1 }) : state,
  )
  .on(CooldownMachineState.Active, CooldownMachineEvent.Suppress, ({ event }) =>
    CooldownMachineState.Active({ cooldown: event.count }),
  )

const cooldownActor: ExtensionActorDefinition<
  typeof CooldownMachineState.Type,
  typeof CooldownMachineEvent.Type
> = {
  machine: cooldownMachine,
  mapEvent: (event) =>
    event._tag === "TurnCompleted" ? CooldownMachineEvent.TurnCompleted : undefined,
  mapCommand: (message) =>
    Schema.is(CooldownIntent)(message) && message._tag === "Suppress"
      ? CooldownMachineEvent.Suppress({ count: message.count })
      : undefined,
  snapshot: {
    schema: Schema.Struct({ cooldown: Schema.Number }),
    project: (state) => ({ cooldown: state.cooldown }),
  },
  protocols: HandoffProtocol,
}

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

// Auto-handoff interceptor — triggers when context fills past threshold
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

    // Read cooldown from own actor snapshot — self-reads are safe (local type)
    const handoffSnap = yield* ctx.extension
      .getUiSnapshot<CooldownState>(EXTENSION_ID)
      .pipe(Effect.catchEager(() => Effect.void))
    const cooldown = handoffSnap?.cooldown ?? 0
    if (cooldown > 0) return // Cooldown active — actor handles decrement via TurnCompleted

    const contextPercent = yield* ctx.session.estimateContextPercent()
    if (contextPercent < DEFAULTS.handoffThresholdPercent) return

    yield* Effect.logInfo("auto-handoff.threshold").pipe(
      Effect.annotateLogs({
        contextPercent,
        threshold: DEFAULTS.handoffThresholdPercent,
      }),
    )

    const allMessages = yield* ctx.session.listMessages()
    const decision = yield* ctx.interaction
      .approve({
        text: summarizeRecentMessages(allMessages),
        metadata: {
          type: "handoff",
          reason: `Context at ${contextPercent}% (threshold: ${DEFAULTS.handoffThresholdPercent}%)`,
        },
      })
      .pipe(Effect.catchEager(() => Effect.succeed({ approved: false })))

    if (!decision.approved) {
      yield* ctx.extension
        .send(HandoffProtocol.Suppress({ count: 5 }))
        .pipe(Effect.catchEager(() => Effect.void))
    }
  }).pipe(Effect.catchEager(() => Effect.void))

export const HandoffExtension = extension(EXTENSION_ID, ({ ext }) =>
  ext.tools(HandoffTool).on("turn.after", autoHandoffImpl).actor(cooldownActor),
)
