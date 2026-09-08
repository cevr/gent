import { Effect } from "effect"
import { defineExtension, ExtensionHost, SessionId } from "@gent/core/extensions/api"
import { GentPlatform } from "@gent/core-internal/runtime/gent-platform.js"
import { localHelper } from "./support/local-helper"

export const extension = defineExtension({
  id: "fixture/valid-extension-boundary",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("tool")
  }),
})

export const values = [SessionId, GentPlatform, localHelper]
