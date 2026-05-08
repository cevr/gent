import { defineExtension, SessionId } from "@gent/core/extensions/api"
import { localHelper } from "./support/local-helper"

export const extension = defineExtension({
  id: "fixture/valid-extension-boundary",
  setup: () => ({
    resources: [],
    tools: [],
    requests: [],
    agents: [],
    prompt: {},
  }),
})

export const values = [SessionId, localHelper]
