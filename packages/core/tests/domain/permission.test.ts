/**
 * Permission service tests
 */

import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { Permission, PermissionRule } from "@gent/core/domain/permission"

describe("Permission", () => {
  describe("check", () => {
    it.live("returns 'allowed' when no rules match and default is allow", () =>
      Permission.use((p) => p.check("TestTool", {})).pipe(
        Effect.tap((result) => Effect.sync(() => expect(result).toBe("allowed"))),
        Effect.provide(Permission.Live([], "allow")),
      ),
    )

    it.live("returns 'denied' when no rules match and default is deny", () =>
      Permission.use((p) => p.check("TestTool", {})).pipe(
        Effect.tap((result) => Effect.sync(() => expect(result).toBe("denied"))),
        Effect.provide(Permission.Live([], "deny")),
      ),
    )

    it.live("returns 'allowed' when tool matches allow rule", () => {
      const rules = [new PermissionRule({ tool: "ReadFile", action: "allow" })]
      const layer = Permission.Live(rules, "deny")
      return Permission.use((p) => p.check("ReadFile", { path: "/tmp/test" })).pipe(
        Effect.tap((result) => Effect.sync(() => expect(result).toBe("allowed"))),
        Effect.provide(layer),
      )
    })

    it.live("returns 'denied' when tool matches deny rule", () => {
      const rules = [new PermissionRule({ tool: "Bash", action: "deny" })]
      const layer = Permission.Live(rules, "allow")
      return Permission.use((p) => p.check("Bash", { command: "rm -rf /" })).pipe(
        Effect.tap((result) => Effect.sync(() => expect(result).toBe("denied"))),
        Effect.provide(layer),
      )
    })

    it.live("matches wildcard tool rule", () => {
      const rules = [new PermissionRule({ tool: "*", action: "deny" })]
      const layer = Permission.Live(rules, "allow")
      return Permission.use((p) => p.check("AnyTool", {})).pipe(
        Effect.tap((result) => Effect.sync(() => expect(result).toBe("denied"))),
        Effect.provide(layer),
      )
    })

    it.live("matches pattern against args", () => {
      const rules = [new PermissionRule({ tool: "Bash", pattern: "rm.*-rf", action: "deny" })]
      const layer = Permission.Live(rules, "allow")
      return Effect.gen(function* () {
        // Should match pattern
        const result1 = yield* Permission.use((p) => p.check("Bash", { command: "rm -rf /tmp" }))
        expect(result1).toBe("denied")

        // Should not match pattern
        const result2 = yield* Permission.use((p) => p.check("Bash", { command: "ls -la" }))
        expect(result2).toBe("allowed")
      }).pipe(Effect.provide(layer))
    })

    it.live("uses first matching rule", () => {
      const rules = [
        new PermissionRule({ tool: "Bash", pattern: "git", action: "allow" }),
        new PermissionRule({ tool: "Bash", action: "deny" }),
      ]
      const layer = Permission.Live(rules, "allow")
      return Effect.gen(function* () {
        // First rule matches
        const result1 = yield* Permission.use((p) => p.check("Bash", { command: "git status" }))
        expect(result1).toBe("allowed")

        // Second rule matches
        const result2 = yield* Permission.use((p) => p.check("Bash", { command: "rm -rf /" }))
        expect(result2).toBe("denied")
      }).pipe(Effect.provide(layer))
    })

    it.live("deny rule blocks matching bash pattern (builtin-style)", () => {
      const rules = [
        new PermissionRule({
          tool: "bash",
          pattern: "git\\s+(add\\s+[-.]|push\\s+--force|reset\\s+--hard|clean\\s+-f)",
          action: "deny",
        }),
      ]
      const layer = Permission.Live(rules, "allow")
      return Effect.gen(function* () {
        const denied = yield* Permission.use((p) =>
          p.check("bash", { command: "git push --force origin main" }),
        )
        expect(denied).toBe("denied")

        const allowed = yield* Permission.use((p) => p.check("bash", { command: "git status" }))
        expect(allowed).toBe("allowed")
      }).pipe(Effect.provide(layer))
    })

    it.live("explicit allow rule overrides default deny", () => {
      const rules = [new PermissionRule({ tool: "ReadFile", action: "allow" })]
      const layer = Permission.Live(rules, "deny")
      return Effect.gen(function* () {
        // Explicit allow overrides default deny
        const result = yield* Permission.use((p) => p.check("ReadFile", { path: "/tmp/x" }))
        expect(result).toBe("allowed")

        // Unknown tool still falls through to default deny
        const other = yield* Permission.use((p) => p.check("UnknownTool", {}))
        expect(other).toBe("denied")
      }).pipe(Effect.provide(layer))
    })
  })

  describe("addRule", () => {
    it.live("adds rule that affects subsequent checks", () => {
      const layer = Permission.Live([], "allow")
      return Effect.gen(function* () {
        const perm = yield* Permission

        // Initially allowed
        const before = yield* perm.check("Bash", {})
        expect(before).toBe("allowed")

        // Add deny rule
        yield* perm.addRule(new PermissionRule({ tool: "Bash", action: "deny" }))

        // Now denied
        const after = yield* perm.check("Bash", {})
        expect(after).toBe("denied")
      }).pipe(Effect.provide(layer))
    })
  })

  describe("removeRule", () => {
    it.live("removes rule by tool and pattern", () => {
      const rules = [new PermissionRule({ tool: "Bash", pattern: "rm", action: "deny" })]
      const layer = Permission.Live(rules, "allow")
      return Effect.gen(function* () {
        const perm = yield* Permission

        // Initially denied for rm
        const before = yield* perm.check("Bash", { command: "rm file" })
        expect(before).toBe("denied")

        // Remove rule
        yield* perm.removeRule("Bash", "rm")

        // Now allowed
        const after = yield* perm.check("Bash", { command: "rm file" })
        expect(after).toBe("allowed")
      }).pipe(Effect.provide(layer))
    })
  })

  describe("getRules", () => {
    it.live("returns all rules", () => {
      const rules = [
        new PermissionRule({ tool: "Read", action: "allow" }),
        new PermissionRule({ tool: "Bash", action: "deny" }),
      ]
      const layer = Permission.Live(rules, "allow")
      return Permission.use((p) => p.getRules()).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.length).toBe(2)
            expect(result[0]?.tool).toBe("Read")
            expect(result[1]?.tool).toBe("Bash")
          }),
        ),
        Effect.provide(layer),
      )
    })
  })
})
