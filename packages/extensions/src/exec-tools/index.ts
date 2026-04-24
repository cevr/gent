import { Layer, Schema } from "effect"
import { Event as MEvent, Machine, State as MState } from "effect-machine"
import { defineExtension, resource } from "@gent/core/extensions/api"
import { defineBuiltinResource, type BuiltinResourceMachine } from "../../internal/builtin.js"
import { BashTool } from "./bash.js"
import { EXEC_TOOLS_EXTENSION_ID, ExecToolsProtocol } from "./protocol.js"

const NotificationState = MState({
  Idle: {
    notificationSeq: Schema.Number,
    notificationContent: Schema.optional(Schema.String),
  },
})

const NotificationEvent = MEvent({
  BackgroundCompleted: {
    content: Schema.String,
  },
})

const notificationMachine = Machine.make({
  state: NotificationState,
  event: NotificationEvent,
  initial: NotificationState.Idle({ notificationSeq: 0 }),
}).on(NotificationState.Idle, NotificationEvent.BackgroundCompleted, ({ state, event }) =>
  NotificationState.Idle({
    notificationSeq: state.notificationSeq + 1,
    notificationContent: event.content,
  }),
)

const afterTransition = (
  before: typeof NotificationState.Type,
  after: typeof NotificationState.Type,
): ReadonlyArray<{ readonly _tag: "QueueFollowUp"; readonly content: string }> =>
  after.notificationSeq !== before.notificationSeq && after.notificationContent !== undefined
    ? [{ _tag: "QueueFollowUp", content: after.notificationContent }]
    : []

const notificationResource: BuiltinResourceMachine<
  typeof NotificationState.Type,
  typeof NotificationEvent.Type
> = {
  machine: notificationMachine,
  mapCommand: (message) =>
    ExecToolsProtocol.BackgroundCompleted.is(message)
      ? NotificationEvent.BackgroundCompleted({ content: message.content })
      : undefined,
  afterTransition,
  protocols: ExecToolsProtocol,
}

export const ExecToolsExtension = defineExtension({
  id: EXEC_TOOLS_EXTENSION_ID,
  capabilities: [BashTool],
  resources: [
    resource(
      defineBuiltinResource({
        scope: "process",
        layer: Layer.empty,
        machine: notificationResource,
      }),
    ),
  ],
})
