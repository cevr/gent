import { Context, Effect, Layer, Ref, Schema } from "effect"
import {
  CapabilityError,
  defineExtension,
  defineResource,
  ExtensionContext,
  type Message,
  type TurnAfterInput,
  messagePartsTextLines,
  ExtensionId,
  request,
} from "@gent/core/extensions/api"
import { HandoffTool } from "./handoff-tool.js"
import { AutoRead } from "./auto/controller.js"

const EXTENSION_ID = ExtensionId.make("@gent/handoff")

const HandoffCommand = request({
  id: "handoff-command",
  extensionId: EXTENSION_ID,
  description: "Distill context into new session",
  slash: {
    trigger: "handoff",
    name: "Handoff",
    description: "Distill context into new session",
  },
  input: Schema.String,
  output: Schema.Void,
  execute: (_input: string) =>
    Effect.gen(function* () {
      const ctx = yield* ExtensionContext
      yield* ctx.Session.queueFollowUp({
        sourceId: "handoff-command",
        content:
          "Please create a handoff by distilling the current context into a concise summary. Use the handoff tool with the distilled context. Include: current task status, key decisions made, relevant file paths, open questions, and any state that needs to carry over to the new session.",
      })
    }).pipe(
      Effect.mapError(
        (cause) =>
          new CapabilityError({
            extensionId: EXTENSION_ID,
            capabilityId: "handoff-command",
            reason: cause.message,
          }),
      ),
    ),
})

// ── Cooldown service ──
//
// State: a single integer. Suppressed by `suppress(count)`, decremented on
// every `turnCompleted()`. The slot handler below advances the service on
// every post-turn tick.
// A process-scoped Ref is the entire product semantics here.

interface HandoffCooldownService {
  readonly turnCompleted: () => Effect.Effect<void>
  readonly suppress: (count: number) => Effect.Effect<void>
  readonly get: () => Effect.Effect<number>
}

export class HandoffCooldown extends Context.Service<HandoffCooldown, HandoffCooldownService>()(
  "@gent/extensions/src/handoff/HandoffCooldown",
) {
  static Live: Layer.Layer<HandoffCooldown> = Layer.effect(
    HandoffCooldown,
    Effect.gen(function* () {
      const cooldown = yield* Ref.make(0)
      return {
        turnCompleted: () => Ref.update(cooldown, (n) => (n > 0 ? n - 1 : 0)),
        suppress: (count) => Ref.set(cooldown, Math.max(0, count)),
        get: () => Ref.get(cooldown),
      } satisfies HandoffCooldownService
    }),
  )
}

// ── turn.after reaction — auto-handoff at context-fill threshold ──

const summarizeRecentMessages = (messages: ReadonlyArray<Message>) => {
  const recentText = messages
    .slice(-20)
    .map((m) => {
      const text = messagePartsTextLines(m.parts).join("\n")
      return text !== "" ? `${m.role}: ${text}` : ""
    })
    .filter((line) => line.length > 0)
    .join("\n\n")
  return recentText.length > 0 ? recentText.slice(0, 4000) : "Session context"
}

const autoHandoffImpl = (input: TurnAfterInput) =>
  Effect.gen(function* () {
    if (input.interrupted) return

    const cooldownOption = yield* Effect.serviceOption(HandoffCooldown)
    if (cooldownOption._tag === "None") return
    const cooldown = cooldownOption.value

    // turnAfter is the natural place to drive the cooldown clock.
    yield* cooldown.turnCompleted().pipe(Effect.catchEager(() => Effect.void))

    // Auto owns its own handoff flow — skip generic threshold handoff when active
    const auto = yield* Effect.serviceOption(AutoRead)
    const autoActive =
      auto._tag === "Some"
        ? yield* auto.value.isActive().pipe(Effect.catchEager(() => Effect.succeed(false)))
        : false
    if (autoActive) return

    const cooldownCount = yield* cooldown.get().pipe(Effect.catchEager(() => Effect.succeed(0)))
    if (cooldownCount > 0) return

    const ctx = yield* ExtensionContext
    const session = ctx.Session
    const contextPercent = yield* session.estimateContextPercent()
    const handoffThreshold = 85
    if (contextPercent < handoffThreshold) return

    yield* Effect.logInfo("auto-handoff.threshold").pipe(
      Effect.annotateLogs({
        contextPercent,
        threshold: handoffThreshold,
      }),
    )

    const allMessages = yield* session.listMessages()
    const decision = yield* ctx.Interaction.approve({
      text: summarizeRecentMessages(allMessages),
      metadata: {
        type: "handoff",
        reason: `Context at ${contextPercent}% (threshold: ${handoffThreshold}%)`,
      },
    }).pipe(Effect.catchEager(() => Effect.succeed({ approved: false })))

    if (!decision.approved) {
      yield* cooldown.suppress(5).pipe(Effect.catchEager(() => Effect.void))
    }
  }).pipe(Effect.catchEager(() => Effect.void))

export const HandoffExtension = defineExtension({
  id: EXTENSION_ID,
  requests: [HandoffCommand],
  tools: [HandoffTool],
  resources: [
    defineResource({ tag: HandoffCooldown, scope: "process", layer: HandoffCooldown.Live }),
  ],
  reactions: {
    turnAfter: {
      failureMode: "isolate",
      handler: autoHandoffImpl,
    },
  },
})
