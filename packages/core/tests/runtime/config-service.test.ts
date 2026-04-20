/**
 * ConfigService tests - permission persistence and first-run setup
 */

import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { PermissionRule } from "@gent/core/domain/permission"
import { ExternalDriverRef, ModelDriverRef } from "@gent/core/domain/agent"
import { ConfigService, UserConfig } from "@gent/core/runtime/config-service"

describe("ConfigService", () => {
  describe("Test implementation", () => {
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

  describe("disabledExtensions", () => {
    it.live("get returns initial disabledExtensions when provided", () => {
      const initial = new UserConfig({
        disabledExtensions: ["@gent/task-tools", "@gent/auto"],
      })
      return ConfigService.use((cfg) => cfg.get()).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.disabledExtensions?.length).toBe(2)
            expect(result.disabledExtensions).toContain("@gent/task-tools")
            expect(result.disabledExtensions).toContain("@gent/auto")
          }),
        ),
        Effect.provide(ConfigService.Test(initial)),
      )
    })

    it.live("set updates disabledExtensions", () =>
      Effect.gen(function* () {
        const cfg = yield* ConfigService
        yield* cfg.set({ disabledExtensions: ["@gent/memory"] })
        const result = yield* cfg.get()
        expect(result.disabledExtensions?.length).toBe(1)
        expect(result.disabledExtensions?.[0]).toBe("@gent/memory")
      }).pipe(Effect.provide(ConfigService.Test())),
    )

    it.live("set preserves disabledExtensions when updating permissions", () =>
      Effect.gen(function* () {
        const cfg = yield* ConfigService
        yield* cfg.set({ disabledExtensions: ["@gent/task-tools"] })
        yield* cfg.set({
          permissions: [new PermissionRule({ tool: "Bash", action: "deny" })],
        })
        const result = yield* cfg.get()
        expect(result.disabledExtensions?.length).toBe(1)
        expect(result.disabledExtensions?.[0]).toBe("@gent/task-tools")
        expect(result.permissions?.length).toBe(1)
      }).pipe(Effect.provide(ConfigService.Test())),
    )
  })

  describe("driverOverrides", () => {
    it.live("setDriverOverride writes a single agent override", () =>
      Effect.gen(function* () {
        const cfg = yield* ConfigService
        const driver = new ExternalDriverRef({ id: "acp-claude-code" })
        yield* cfg.setDriverOverride("cowork", driver)
        const result = yield* cfg.get()
        const cowork = result.driverOverrides?.["cowork"]
        if (cowork === undefined) throw new Error("expected cowork override")
        expect(cowork._tag).toBe("external")
        expect((cowork as ExternalDriverRef).id).toBe("acp-claude-code")
      }).pipe(Effect.provide(ConfigService.Test())),
    )

    it.live("setDriverOverride replaces an existing override for the same agent", () =>
      Effect.gen(function* () {
        const cfg = yield* ConfigService
        yield* cfg.setDriverOverride("cowork", new ExternalDriverRef({ id: "acp-claude-code" }))
        yield* cfg.setDriverOverride("cowork", new ModelDriverRef({ id: "anthropic" }))
        const result = yield* cfg.get()
        expect(result.driverOverrides?.["cowork"]?._tag).toBe("model")
      }).pipe(Effect.provide(ConfigService.Test())),
    )

    it.live("setDriverOverride preserves other agents' overrides", () =>
      Effect.gen(function* () {
        const cfg = yield* ConfigService
        yield* cfg.setDriverOverride("cowork", new ExternalDriverRef({ id: "acp-claude-code" }))
        yield* cfg.setDriverOverride("deepwork", new ExternalDriverRef({ id: "acp-opencode" }))
        const result = yield* cfg.get()
        expect(Object.keys(result.driverOverrides ?? {})).toHaveLength(2)
      }).pipe(Effect.provide(ConfigService.Test())),
    )

    it.live("clearDriverOverride removes one entry without touching others", () =>
      Effect.gen(function* () {
        const cfg = yield* ConfigService
        yield* cfg.setDriverOverride("cowork", new ExternalDriverRef({ id: "acp-claude-code" }))
        yield* cfg.setDriverOverride("deepwork", new ExternalDriverRef({ id: "acp-opencode" }))
        yield* cfg.clearDriverOverride("cowork")
        const result = yield* cfg.get()
        expect(result.driverOverrides?.["cowork"]).toBeUndefined()
        expect(result.driverOverrides?.["deepwork"]).toBeDefined()
      }).pipe(Effect.provide(ConfigService.Test())),
    )

    it.live("clearDriverOverride drops the entire record when last entry is removed", () =>
      Effect.gen(function* () {
        const cfg = yield* ConfigService
        yield* cfg.setDriverOverride("cowork", new ExternalDriverRef({ id: "acp-claude-code" }))
        yield* cfg.clearDriverOverride("cowork")
        const result = yield* cfg.get()
        expect(result.driverOverrides).toBeUndefined()
      }).pipe(Effect.provide(ConfigService.Test())),
    )

    it.live("clearDriverOverride is a no-op for an unknown agent", () =>
      Effect.gen(function* () {
        const cfg = yield* ConfigService
        yield* cfg.clearDriverOverride("does-not-exist")
        const result = yield* cfg.get()
        expect(result.driverOverrides).toBeUndefined()
      }).pipe(Effect.provide(ConfigService.Test())),
    )

    it.live("addPermissionRule preserves driverOverrides (regression: codex HIGH)", () =>
      Effect.gen(function* () {
        const cfg = yield* ConfigService
        yield* cfg.setDriverOverride("cowork", new ExternalDriverRef({ id: "acp-claude-code" }))
        yield* cfg.addPermissionRule(new PermissionRule({ tool: "Bash", action: "deny" }))
        const result = yield* cfg.get()
        expect(result.driverOverrides?.["cowork"]).toBeDefined()
      }).pipe(Effect.provide(ConfigService.Test())),
    )

    it.live("removePermissionRule preserves driverOverrides (regression: codex HIGH)", () =>
      Effect.gen(function* () {
        const cfg = yield* ConfigService
        yield* cfg.setDriverOverride("cowork", new ExternalDriverRef({ id: "acp-claude-code" }))
        yield* cfg.addPermissionRule(new PermissionRule({ tool: "Bash", action: "deny" }))
        yield* cfg.removePermissionRule("Bash", undefined)
        const result = yield* cfg.get()
        expect(result.driverOverrides?.["cowork"]).toBeDefined()
      }).pipe(Effect.provide(ConfigService.Test())),
    )
  })
})
