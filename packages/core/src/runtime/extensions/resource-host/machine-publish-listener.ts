import { Context } from "effect"
import type { Effect } from "effect"

export type MachinePublishListener = (transitioned: ReadonlyArray<string>) => Effect.Effect<void>

export const CurrentMachinePublishListener = Context.Reference<MachinePublishListener | undefined>(
  "@gent/core/src/runtime/extensions/resource-host/machine-publish-listener/CurrentMachinePublishListener",
  { defaultValue: () => undefined },
)
