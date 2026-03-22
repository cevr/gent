import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import { defineExtension, type LoadedExtension } from "../../../domain/extension.js"
import { validateExtensions } from "../loader.js"

const makeLoaded = (
  id: string,
  kind: "builtin" | "user" | "project",
  toolNames: string[] = [],
  agentNames: string[] = [],
): LoadedExtension => ({
  manifest: { id },
  kind,
  sourcePath: `/test/${id}`,
  setup: {
    tools: toolNames.map((name) => ({
      name,
      action: "read" as const,
      description: `test tool ${name}`,
      params: {} as never,
      execute: () => Effect.succeed(undefined),
    })),
    agents:
      agentNames.length > 0
        ? agentNames.map(
            (name) =>
              ({
                name,
                kind: "subagent",
              }) as never,
          )
        : undefined,
  },
})

describe("validateExtensions", () => {
  test("passes with no extensions", async () => {
    await Effect.runPromise(validateExtensions([]))
  })

  test("passes with unique extensions in same scope", async () => {
    const exts = [makeLoaded("a", "builtin", ["tool-a"]), makeLoaded("b", "builtin", ["tool-b"])]
    await Effect.runPromise(validateExtensions(exts))
  })

  test("passes with same tool name in different scopes", async () => {
    const exts = [
      makeLoaded("builtin-fs", "builtin", ["read"]),
      makeLoaded("custom-fs", "project", ["read"]),
    ]
    await Effect.runPromise(validateExtensions(exts))
  })

  test("fails on duplicate manifest id within same scope", async () => {
    const exts = [makeLoaded("dupe", "user"), makeLoaded("dupe", "user")]
    const result = await Effect.runPromise(validateExtensions(exts).pipe(Effect.result))
    expect(result._tag).toBe("Failure")
  })

  test("allows same manifest id in different scopes", async () => {
    const exts = [makeLoaded("same-id", "builtin"), makeLoaded("same-id", "project")]
    await Effect.runPromise(validateExtensions(exts))
  })

  test("fails on same-name tool from two extensions in same scope", async () => {
    const exts = [
      makeLoaded("ext-a", "builtin", ["conflicting-tool"]),
      makeLoaded("ext-b", "builtin", ["conflicting-tool"]),
    ]
    const result = await Effect.runPromise(validateExtensions(exts).pipe(Effect.result))
    expect(result._tag).toBe("Failure")
  })

  test("allows same-name tool from same extension", async () => {
    const ext = makeLoaded("ext-a", "builtin", ["tool-a"])
    await Effect.runPromise(validateExtensions([ext]))
  })
})

describe("isGentExtension shape check", () => {
  test("defineExtension produces valid shape", () => {
    const ext = defineExtension({
      manifest: { id: "test-ext" },
      setup: () => Effect.succeed({ tools: [] }),
    })
    expect(ext.manifest.id).toBe("test-ext")
    expect(typeof ext.setup).toBe("function")
  })
})
