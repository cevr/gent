/**
 * Driver override routing — integration test that ConfigService.driverOverrides
 * actually flows into `resolveAgentDriver` at the agent loop's resolution
 * boundary.
 *
 * Drives `ConfigService.Test(...)` with overrides, calls
 * `resolveAgentDriver` directly with the merged config, asserts source +
 * driver. Catches breakage between `ConfigService` and the resolver
 * without spinning up the full agent loop.
 */
import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import {
  AgentDefinition,
  ExternalDriverRef,
  ModelDriverRef,
  resolveAgentDriver,
} from "@gent/core/domain/agent"
import { ConfigService, UserConfig } from "@gent/core/runtime/config-service"

// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- AgentName is branded; tests build raw definitions.
const cowork = new AgentDefinition({ name: "cowork" as never })
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
const hardcoded = new AgentDefinition({
  name: "hardcoded" as never,
  driver: new ExternalDriverRef({ id: "acp-claude-code" }),
})

describe("driver override routing through ConfigService", () => {
  it.live("agent without hardcoded driver picks up config override (source: config)", () =>
    Effect.gen(function* () {
      const cfg = yield* ConfigService
      const { driverOverrides } = yield* cfg.get()
      const result = resolveAgentDriver(cowork, driverOverrides)
      expect(result.source).toBe("config")
      expect(result.driver?._tag).toBe("external")
      expect((result.driver as ExternalDriverRef).id).toBe("acp-claude-code")
    }).pipe(
      Effect.provide(
        ConfigService.Test(
          new UserConfig({
            driverOverrides: { cowork: new ExternalDriverRef({ id: "acp-claude-code" }) },
          }),
        ),
      ),
    ),
  )

  it.live("hardcoded agent.driver wins over config override (source: agent)", () =>
    Effect.gen(function* () {
      const cfg = yield* ConfigService
      const { driverOverrides } = yield* cfg.get()
      const result = resolveAgentDriver(hardcoded, driverOverrides)
      expect(result.source).toBe("agent")
      expect((result.driver as ExternalDriverRef).id).toBe("acp-claude-code")
    }).pipe(
      Effect.provide(
        ConfigService.Test(
          new UserConfig({
            driverOverrides: { hardcoded: new ModelDriverRef({ id: "anthropic" }) },
          }),
        ),
      ),
    ),
  )

  it.live("no override returns source: default", () =>
    Effect.gen(function* () {
      const cfg = yield* ConfigService
      const { driverOverrides } = yield* cfg.get()
      const result = resolveAgentDriver(cowork, driverOverrides)
      expect(result.source).toBe("default")
      expect(result.driver).toBeUndefined()
    }).pipe(Effect.provide(ConfigService.Test())),
  )

  it.live("clearing the override falls back to default on the next read", () =>
    Effect.gen(function* () {
      const cfg = yield* ConfigService
      yield* cfg.setDriverOverride("cowork", new ExternalDriverRef({ id: "acp-claude-code" }))
      const before = (yield* cfg.get()).driverOverrides
      expect(resolveAgentDriver(cowork, before).source).toBe("config")
      yield* cfg.clearDriverOverride("cowork")
      const after = (yield* cfg.get()).driverOverrides
      expect(resolveAgentDriver(cowork, after).source).toBe("default")
    }).pipe(Effect.provide(ConfigService.Test())),
  )
})
