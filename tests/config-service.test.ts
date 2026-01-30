/**
 * ConfigService tests - permission persistence and first-run setup
 */

import { describe, it, expect } from "bun:test"
import { Effect } from "effect"
import { PermissionRule } from "@gent/core"
import { ConfigService, UserConfig } from "@gent/runtime"

describe("ConfigService", () => {
  describe("Test implementation", () => {
    it("get returns empty config initially", async () => {
      const layer = ConfigService.Test()
      const result = await Effect.runPromise(
        ConfigService.pipe(
          Effect.flatMap((cfg) => cfg.get()),
          Effect.provide(layer),
        ),
      )
      expect(result.permissions).toBeUndefined()
    })

    it("get returns initial config when provided", async () => {
      const initial = new UserConfig({
        permissions: [new PermissionRule({ tool: "Bash", action: "deny" })],
      })
      const layer = ConfigService.Test(initial)
      const result = await Effect.runPromise(
        ConfigService.pipe(
          Effect.flatMap((cfg) => cfg.get()),
          Effect.provide(layer),
        ),
      )
      expect(result.permissions?.length).toBe(1)
      expect(result.permissions?.[0]?.tool).toBe("Bash")
    })

    it("set updates config", async () => {
      const layer = ConfigService.Test()
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const cfg = yield* ConfigService
          yield* cfg.set({ permissions: [new PermissionRule({ tool: "Read", action: "allow" })] })
          return yield* cfg.get()
        }).pipe(Effect.provide(layer)),
      )
      expect(result.permissions?.length).toBe(1)
      expect(result.permissions?.[0]?.tool).toBe("Read")
    })
  })

  describe("Permission rules", () => {
    it("getPermissionRules returns empty array initially", async () => {
      const layer = ConfigService.Test()
      const result = await Effect.runPromise(
        ConfigService.pipe(
          Effect.flatMap((cfg) => cfg.getPermissionRules()),
          Effect.provide(layer),
        ),
      )
      expect(result).toEqual([])
    })

    it("getPermissionRules returns rules from config", async () => {
      const initial = new UserConfig({
        permissions: [
          new PermissionRule({ tool: "Bash", action: "deny" }),
          new PermissionRule({ tool: "Read", action: "allow" }),
        ],
      })
      const layer = ConfigService.Test(initial)
      const result = await Effect.runPromise(
        ConfigService.pipe(
          Effect.flatMap((cfg) => cfg.getPermissionRules()),
          Effect.provide(layer),
        ),
      )
      expect(result.length).toBe(2)
    })

    it("addPermissionRule adds rule to config", async () => {
      const layer = ConfigService.Test()
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const cfg = yield* ConfigService

          // Add rule
          yield* cfg.addPermissionRule(new PermissionRule({ tool: "Bash", action: "deny" }))

          // Verify
          return yield* cfg.getPermissionRules()
        }).pipe(Effect.provide(layer)),
      )
      expect(result.length).toBe(1)
      expect(result[0]?.tool).toBe("Bash")
      expect(result[0]?.action).toBe("deny")
    })

    it("addPermissionRule accumulates rules", async () => {
      const layer = ConfigService.Test()
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const cfg = yield* ConfigService

          yield* cfg.addPermissionRule(new PermissionRule({ tool: "Bash", action: "deny" }))
          yield* cfg.addPermissionRule(new PermissionRule({ tool: "Read", action: "allow" }))
          yield* cfg.addPermissionRule(
            new PermissionRule({ tool: "Write", pattern: "/etc", action: "deny" }),
          )

          return yield* cfg.getPermissionRules()
        }).pipe(Effect.provide(layer)),
      )
      expect(result.length).toBe(3)
    })

    it("removePermissionRule removes matching rule", async () => {
      const initial = new UserConfig({
        permissions: [
          new PermissionRule({ tool: "Bash", action: "deny" }),
          new PermissionRule({ tool: "Read", action: "allow" }),
        ],
      })
      const layer = ConfigService.Test(initial)
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const cfg = yield* ConfigService

          // Remove Bash rule
          yield* cfg.removePermissionRule("Bash", undefined)

          return yield* cfg.getPermissionRules()
        }).pipe(Effect.provide(layer)),
      )
      expect(result.length).toBe(1)
      expect(result[0]?.tool).toBe("Read")
    })

    it("removePermissionRule matches on pattern", async () => {
      const initial = new UserConfig({
        permissions: [
          new PermissionRule({ tool: "Bash", pattern: "rm", action: "deny" }),
          new PermissionRule({ tool: "Bash", action: "allow" }),
        ],
      })
      const layer = ConfigService.Test(initial)
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const cfg = yield* ConfigService

          // Remove only the pattern-specific rule
          yield* cfg.removePermissionRule("Bash", "rm")

          return yield* cfg.getPermissionRules()
        }).pipe(Effect.provide(layer)),
      )
      expect(result.length).toBe(1)
      expect(result[0]?.pattern).toBeUndefined()
    })

    it("removePermissionRule is idempotent for missing rule", async () => {
      const layer = ConfigService.Test()
      // Should not throw
      await Effect.runPromise(
        ConfigService.pipe(
          Effect.flatMap((cfg) => cfg.removePermissionRule("NonExistent", undefined)),
          Effect.provide(layer),
        ),
      )
    })
  })
})
