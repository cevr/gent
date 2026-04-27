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
  AgentName,
  ExternalDriverRef,
  ModelDriverRef,
  resolveAgentDriver,
} from "@gent/core/domain/agent"
import { ConfigService, UserConfig } from "../../src/runtime/config-service"

const cowork = AgentDefinition.make({ name: AgentName.make("cowork") })
const hardcoded = AgentDefinition.make({
  name: AgentName.make("hardcoded"),
  driver: ExternalDriverRef.make({ id: "acp-claude-code" }),
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
            driverOverrides: {
              [AgentName.make("cowork")]: ExternalDriverRef.make({ id: "acp-claude-code" }),
            },
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
            driverOverrides: {
              [AgentName.make("hardcoded")]: ModelDriverRef.make({ id: "anthropic" }),
            },
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
      yield* cfg.setDriverOverride(
        AgentName.make("cowork"),
        ExternalDriverRef.make({ id: "acp-claude-code" }),
      )
      const before = (yield* cfg.get()).driverOverrides
      expect(resolveAgentDriver(cowork, before).source).toBe("config")
      yield* cfg.clearDriverOverride(AgentName.make("cowork"))
      const after = (yield* cfg.get()).driverOverrides
      expect(resolveAgentDriver(cowork, after).source).toBe("default")
    }).pipe(Effect.provide(ConfigService.Test())),
  )
})
