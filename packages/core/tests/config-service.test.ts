/**
 * ConfigService tests - permission persistence and first-run setup
 */

import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { PermissionRule } from "@gent/core/domain/permission"
import { ConfigService, UserConfig } from "@gent/core/runtime/config-service"

describe("ConfigService", () => {
  describe("Test implementation", () => {
    it.live("get returns empty config initially", () =>
      ConfigService.use((cfg) => cfg.get()).pipe(
        Effect.tap((result) => Effect.sync(() => expect(result.permissions).toBeUndefined())),
        Effect.provide(ConfigService.Test()),
      ),
    )

    it.live("get returns initial config when provided", () => {
      const initial = new UserConfig({
        permissions: [new PermissionRule({ tool: "Bash", action: "deny" })],
      })
      return ConfigService.use((cfg) => cfg.get()).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.permissions?.length).toBe(1)
            expect(result.permissions?.[0]?.tool).toBe("Bash")
          }),
        ),
        Effect.provide(ConfigService.Test(initial)),
      )
    })

    it.live("set updates config", () =>
      Effect.gen(function* () {
        const cfg = yield* ConfigService
        yield* cfg.set({ permissions: [new PermissionRule({ tool: "Read", action: "allow" })] })
        const result = yield* cfg.get()
        expect(result.permissions?.length).toBe(1)
        expect(result.permissions?.[0]?.tool).toBe("Read")
      }).pipe(Effect.provide(ConfigService.Test())),
    )
  })

  describe("Permission rules", () => {
    it.live("getPermissionRules returns empty array initially", () =>
      ConfigService.use((cfg) => cfg.getPermissionRules()).pipe(
        Effect.tap((result) => Effect.sync(() => expect(result).toEqual([]))),
        Effect.provide(ConfigService.Test()),
      ),
    )

    it.live("getPermissionRules returns rules from config", () => {
      const initial = new UserConfig({
        permissions: [
          new PermissionRule({ tool: "Bash", action: "deny" }),
          new PermissionRule({ tool: "Read", action: "allow" }),
        ],
      })
      return ConfigService.use((cfg) => cfg.getPermissionRules()).pipe(
        Effect.tap((result) => Effect.sync(() => expect(result.length).toBe(2))),
        Effect.provide(ConfigService.Test(initial)),
      )
    })

    it.live("addPermissionRule adds rule to config", () =>
      Effect.gen(function* () {
        const cfg = yield* ConfigService

        // Add rule
        yield* cfg.addPermissionRule(new PermissionRule({ tool: "Bash", action: "deny" }))

        // Verify
        const result = yield* cfg.getPermissionRules()
        expect(result.length).toBe(1)
        expect(result[0]?.tool).toBe("Bash")
        expect(result[0]?.action).toBe("deny")
      }).pipe(Effect.provide(ConfigService.Test())),
    )

    it.live("addPermissionRule accumulates rules", () =>
      Effect.gen(function* () {
        const cfg = yield* ConfigService

        yield* cfg.addPermissionRule(new PermissionRule({ tool: "Bash", action: "deny" }))
        yield* cfg.addPermissionRule(new PermissionRule({ tool: "Read", action: "allow" }))
        yield* cfg.addPermissionRule(
          new PermissionRule({ tool: "Write", pattern: "/etc", action: "deny" }),
        )

        const result = yield* cfg.getPermissionRules()
        expect(result.length).toBe(3)
      }).pipe(Effect.provide(ConfigService.Test())),
    )

    it.live("removePermissionRule removes matching rule", () => {
      const initial = new UserConfig({
        permissions: [
          new PermissionRule({ tool: "Bash", action: "deny" }),
          new PermissionRule({ tool: "Read", action: "allow" }),
        ],
      })
      return Effect.gen(function* () {
        const cfg = yield* ConfigService

        // Remove Bash rule
        yield* cfg.removePermissionRule("Bash", undefined)

        const result = yield* cfg.getPermissionRules()
        expect(result.length).toBe(1)
        expect(result[0]?.tool).toBe("Read")
      }).pipe(Effect.provide(ConfigService.Test(initial)))
    })

    it.live("removePermissionRule matches on pattern", () => {
      const initial = new UserConfig({
        permissions: [
          new PermissionRule({ tool: "Bash", pattern: "rm", action: "deny" }),
          new PermissionRule({ tool: "Bash", action: "allow" }),
        ],
      })
      return Effect.gen(function* () {
        const cfg = yield* ConfigService

        // Remove only the pattern-specific rule
        yield* cfg.removePermissionRule("Bash", "rm")

        const result = yield* cfg.getPermissionRules()
        expect(result.length).toBe(1)
        expect(result[0]?.pattern).toBeUndefined()
      }).pipe(Effect.provide(ConfigService.Test(initial)))
    })

    it.live("removePermissionRule is idempotent for missing rule", () =>
      ConfigService.use((cfg) => cfg.removePermissionRule("NonExistent", undefined)).pipe(
        Effect.provide(ConfigService.Test()),
      ),
    )
  })
})
