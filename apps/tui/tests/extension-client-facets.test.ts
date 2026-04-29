import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { defineExtension } from "@gent/core/extensions/api"
import { defineClientExtension, widgetContribution } from "../src/extensions/client-facets.js"

describe("defineClientExtension", () => {
  test("lowers a shared server/client extension artifact into a TUI module", () => {
    const shared = defineExtension({
      id: "@test/shared",
      client: {
        setup: Effect.succeed([
          widgetContribution({
            id: "shared-widget",
            slot: "below-input",
            component: () => undefined as never,
          }),
        ]),
      },
    })

    const module = defineClientExtension(shared)

    expect(module.id).toBe("@test/shared")
    expect(module.setup).toBe(shared.client.setup)
  })
})
