/**
 * Driver routing RPCs — `driver.list` / `driver.set` / `driver.clear`
 * acceptance tests.
 *
 * Drives the full transport boundary (Gent.test → RpcServer → handler →
 * ConfigService + DriverRegistry) so the tests catch wiring bugs the
 * unit tests on `ConfigService.setDriverOverride` don't cover.
 */
import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { textStep } from "@gent/core/debug/provider"
import { Provider } from "@gent/core/providers/provider"
import { AgentName, ExternalDriverRef, ModelDriverRef } from "@gent/core/domain/agent"
import { DriverListResult } from "@gent/core/server/transport-contract"
import { Gent } from "@gent/sdk"
import { createE2ELayer } from "@gent/core/test-utils/e2e-layer"
import { e2ePreset } from "../extensions/helpers/test-preset"

describe("DriverRpcs", () => {
  it.live("driver.list returns registered drivers and current overrides", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* Provider.Sequence([textStep("ok")])
        const { client } = yield* Gent.test(createE2ELayer({ ...e2ePreset, providerLayer }))
        const before = yield* client.driver.list()
        expect(before).toBeInstanceOf(DriverListResult)
        expect(before.drivers[0]?._tag).toBeDefined()
        // Built-in agents extension contributes the "anthropic" model driver
        // (and friends); the registered list should be non-empty even when no
        // overrides are set.
        expect(before.drivers.length).toBeGreaterThan(0)
        expect(before.overrides).toEqual({})
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("driver.set persists an override; driver.list reflects it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* Provider.Sequence([textStep("ok")])
        const { client } = yield* Gent.test(createE2ELayer({ ...e2ePreset, providerLayer }))
        const drivers = (yield* client.driver.list()).drivers
        const someModel = drivers.find((d) => d._tag === "model")
        if (someModel === undefined) throw new Error("no model driver registered in test layer")
        yield* client.driver.set({
          agentName: AgentName.make("cowork"),
          driver: ModelDriverRef.make({ id: someModel.id }),
        })
        const after = yield* client.driver.list()
        expect(after.overrides[AgentName.make("cowork")]?._tag).toBe("model")
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("driver.set rejects unknown driver id with NotFoundError", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* Provider.Sequence([textStep("ok")])
        const { client } = yield* Gent.test(createE2ELayer({ ...e2ePreset, providerLayer }))
        const result = yield* client.driver
          .set({
            agentName: AgentName.make("cowork"),
            driver: ExternalDriverRef.make({ id: "definitely-not-registered" }),
          })
          .pipe(Effect.flip)
        expect(result._tag).toBe("NotFoundError")
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("driver.clear removes an existing override", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* Provider.Sequence([textStep("ok")])
        const { client } = yield* Gent.test(createE2ELayer({ ...e2ePreset, providerLayer }))
        const drivers = (yield* client.driver.list()).drivers
        const someModel = drivers.find((d) => d._tag === "model")
        if (someModel === undefined) throw new Error("no model driver registered in test layer")
        yield* client.driver.set({
          agentName: AgentName.make("cowork"),
          driver: ModelDriverRef.make({ id: someModel.id }),
        })
        yield* client.driver.clear({ agentName: AgentName.make("cowork") })
        const after = yield* client.driver.list()
        expect(after.overrides).toEqual({})
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("driver.clear is a no-op for an unknown agent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* Provider.Sequence([textStep("ok")])
        const { client } = yield* Gent.test(createE2ELayer({ ...e2ePreset, providerLayer }))
        yield* client.driver.clear({ agentName: AgentName.make("does-not-exist") })
        const after = yield* client.driver.list()
        expect(after.overrides).toEqual({})
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )
})
