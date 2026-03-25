/**
 * Permission service tests
 */

import { describe, it, expect } from "bun:test"
import { Effect } from "effect"
import { Permission, PermissionRule } from "@gent/core/domain/permission"

describe("Permission", () => {
  describe("check", () => {
    it("returns 'allowed' when no rules match and default is allow", async () => {
      const layer = Permission.Live([], "allow")
      const result = await Effect.runPromise(
        Permission.use((p) => p.check("TestTool", {})).pipe(Effect.provide(layer)),
      )
      expect(result).toBe("allowed")
    })

    it("returns 'ask' when no rules match and default is ask", async () => {
      const layer = Permission.Live([], "ask")
      const result = await Effect.runPromise(
        Permission.use((p) => p.check("TestTool", {})).pipe(Effect.provide(layer)),
      )
      expect(result).toBe("ask")
    })

    it("returns 'denied' when no rules match and default is deny", async () => {
      const layer = Permission.Live([], "deny")
      const result = await Effect.runPromise(
        Permission.use((p) => p.check("TestTool", {})).pipe(Effect.provide(layer)),
      )
      expect(result).toBe("denied")
    })

    it("returns 'allowed' when tool matches allow rule", async () => {
      const rules = [new PermissionRule({ tool: "ReadFile", action: "allow" })]
      const layer = Permission.Live(rules, "deny")
      const result = await Effect.runPromise(
        Permission.use((p) => p.check("ReadFile", { path: "/tmp/test" })).pipe(
          Effect.provide(layer),
        ),
      )
      expect(result).toBe("allowed")
    })

    it("returns 'denied' when tool matches deny rule", async () => {
      const rules = [new PermissionRule({ tool: "Bash", action: "deny" })]
      const layer = Permission.Live(rules, "allow")
      const result = await Effect.runPromise(
        Permission.use((p) => p.check("Bash", { command: "rm -rf /" })).pipe(Effect.provide(layer)),
      )
      expect(result).toBe("denied")
    })

    it("returns 'ask' when tool matches ask rule", async () => {
      const rules = [new PermissionRule({ tool: "Write", action: "ask" })]
      const layer = Permission.Live(rules, "allow")
      const result = await Effect.runPromise(
        Permission.use((p) => p.check("Write", { path: "/etc/passwd" })).pipe(
          Effect.provide(layer),
        ),
      )
      expect(result).toBe("ask")
    })

    it("matches wildcard tool rule", async () => {
      const rules = [new PermissionRule({ tool: "*", action: "deny" })]
      const layer = Permission.Live(rules, "allow")
      const result = await Effect.runPromise(
        Permission.use((p) => p.check("AnyTool", {})).pipe(Effect.provide(layer)),
      )
      expect(result).toBe("denied")
    })

    it("matches pattern against args", async () => {
      const rules = [new PermissionRule({ tool: "Bash", pattern: "rm.*-rf", action: "deny" })]
      const layer = Permission.Live(rules, "allow")

      // Should match pattern
      const result1 = await Effect.runPromise(
        Permission.use((p) => p.check("Bash", { command: "rm -rf /tmp" })).pipe(
          Effect.provide(layer),
        ),
      )
      expect(result1).toBe("denied")

      // Should not match pattern
      const result2 = await Effect.runPromise(
        Permission.use((p) => p.check("Bash", { command: "ls -la" })).pipe(Effect.provide(layer)),
      )
      expect(result2).toBe("allowed")
    })

    it("uses first matching rule", async () => {
      const rules = [
        new PermissionRule({ tool: "Bash", pattern: "git", action: "allow" }),
        new PermissionRule({ tool: "Bash", action: "deny" }),
      ]
      const layer = Permission.Live(rules, "allow")

      // First rule matches
      const result1 = await Effect.runPromise(
        Permission.use((p) => p.check("Bash", { command: "git status" })).pipe(
          Effect.provide(layer),
        ),
      )
      expect(result1).toBe("allowed")

      // Second rule matches
      const result2 = await Effect.runPromise(
        Permission.use((p) => p.check("Bash", { command: "rm -rf /" })).pipe(Effect.provide(layer)),
      )
      expect(result2).toBe("denied")
    })
  })

  describe("addRule", () => {
    it("adds rule that affects subsequent checks", async () => {
      const layer = Permission.Live([], "allow")
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const perm = yield* Permission

          // Initially allowed
          const before = yield* perm.check("Bash", {})
          expect(before).toBe("allowed")

          // Add deny rule
          yield* perm.addRule(new PermissionRule({ tool: "Bash", action: "deny" }))

          // Now denied
          const after = yield* perm.check("Bash", {})
          return after
        }).pipe(Effect.provide(layer)),
      )
      expect(result).toBe("denied")
    })
  })

  describe("removeRule", () => {
    it("removes rule by tool and pattern", async () => {
      const rules = [new PermissionRule({ tool: "Bash", pattern: "rm", action: "deny" })]
      const layer = Permission.Live(rules, "allow")

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const perm = yield* Permission

          // Initially denied for rm
          const before = yield* perm.check("Bash", { command: "rm file" })
          expect(before).toBe("denied")

          // Remove rule
          yield* perm.removeRule("Bash", "rm")

          // Now allowed
          const after = yield* perm.check("Bash", { command: "rm file" })
          return after
        }).pipe(Effect.provide(layer)),
      )
      expect(result).toBe("allowed")
    })
  })

  describe("getRules", () => {
    it("returns all rules", async () => {
      const rules = [
        new PermissionRule({ tool: "Read", action: "allow" }),
        new PermissionRule({ tool: "Bash", action: "deny" }),
      ]
      const layer = Permission.Live(rules, "allow")

      const result = await Effect.runPromise(
        Permission.use((p) => p.getRules()).pipe(Effect.provide(layer)),
      )
      expect(result.length).toBe(2)
      expect(result[0]?.tool).toBe("Read")
      expect(result[1]?.tool).toBe("Bash")
    })
  })
})
