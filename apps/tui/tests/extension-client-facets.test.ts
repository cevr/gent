import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Schema } from "effect"
import {
  defineExtension,
  defineStatefulExtension,
  ServiceKey,
  TaggedEnumClass,
  type Behavior,
} from "@gent/core/extensions/api"
import { defineClientExtension, widgetContribution } from "../src/extensions/client-facets.js"

const SharedMsg = TaggedEnumClass("SharedMsg", {
  Ping: {},
})
type SharedMsg = Schema.Schema.Type<typeof SharedMsg>
const SharedKey = ServiceKey<SharedMsg>("shared")
const sharedBehavior: Behavior<SharedMsg, null, never> = {
  initialState: null,
  serviceKey: SharedKey,
  receive: () => Effect.succeed(null),
}

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

  test("lowers client-bearing stateful helper artifacts", () => {
    const shared = defineStatefulExtension({
      id: "@test/stateful-shared",
      actor: sharedBehavior,
      client: {
        setup: Effect.succeed([]),
      },
    })

    const module = defineClientExtension(shared)

    expect(module.id).toBe("@test/stateful-shared")
    expect(module.setup).toBe(shared.client.setup)
  })
})
