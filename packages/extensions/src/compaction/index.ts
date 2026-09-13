import { Effect } from "effect"
import {
  defineExtension,
  defineResource,
  ExtensionHost,
  ExtensionId,
} from "@gent/core/extensions/api"
import { ModelContextCompactor } from "@gent/core/extensions/branch-tools"
import { ModelContextCompactorLive } from "./model-compaction.js"

export const COMPACTION_EXTENSION_ID = ExtensionId.make("@gent/compaction")

/** Summarises older history when the model window overflows or the model asks. */
export const ModelContextCompactorResource = defineResource({
  id: "@gent/compaction/model-context-compactor",
  scope: "process",
  tag: ModelContextCompactor,
  layer: ModelContextCompactorLive,
})

export const CompactionExtension = defineExtension({
  id: COMPACTION_EXTENSION_ID,
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("resource", ModelContextCompactorResource)
  }),
})
