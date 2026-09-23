import { defineExtension, ExtensionHost } from "@gent/core/extensions/api"
import { Effect } from "effect"

export const extension = defineExtension({
  id: "fixture/reference-extension",
  setup: Effect.gen(function* () {
    yield* ExtensionHost
  }),
})
