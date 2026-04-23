import { Layer, Schema } from "effect"
import { Event as MEvent, Machine, State as MState } from "effect-machine"
import {
  defineExtension,
  defineResource,
  resource,
  type ResourceMachine,
} from "@gent/core/extensions/api"
// oxlint-disable-next-line gent/no-extension-internal-imports -- runtime-only effect union is intentionally withheld from the public authoring api
import type { RuntimeExtensionEffect } from "@gent/core/domain/extension"
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
): ReadonlyArray<RuntimeExtensionEffect> =>
  after.notificationSeq !== before.notificationSeq && after.notificationContent !== undefined
    ? [{ _tag: "QueueFollowUp", content: after.notificationContent }]
    : []

const notificationResource: ResourceMachine<
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
      defineResource({
        scope: "process",
        layer: Layer.empty,
        machine: notificationResource,
      }),
    ),
  ],
})
