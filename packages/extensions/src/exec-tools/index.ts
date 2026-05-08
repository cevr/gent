/**
 * @gent/exec-tools — shell-execution capability surface.
 *
 * Background shell work is owned by a process-scoped supervisor resource. The
 * bash tool submits keyed jobs and returns immediately; the resource owns the
 * child process scope and completion follow-up.
 */

import { Effect, Layer } from "effect"
import { defineExtension, defineResource, ExtensionId } from "@gent/core/extensions/api"
import { BackgroundBashSupervisorLive, BashTool } from "./bash.js"
import { BackgroundBashStorage } from "./bash-storage.js"

const EXEC_TOOLS_EXTENSION_ID = ExtensionId.make("@gent/exec-tools")

const BackgroundBashLayer = BackgroundBashSupervisorLive.pipe(
  Layer.provideMerge(BackgroundBashStorage.Live),
)

export const ExecToolsExtension = defineExtension({
  id: EXEC_TOOLS_EXTENSION_ID,
  tools: [BashTool],
  resources: [
    defineResource({
      scope: "process",
      layer: BackgroundBashLayer,
      start: Effect.gen(function* () {
        const storage = yield* BackgroundBashStorage
        yield* storage.reconcileInterrupted()
      }),
    }),
  ],
})
