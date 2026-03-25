import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import { defineExtension, type LoadedExtension } from "@gent/core/domain/extension"
import { validateExtensions, isClientFile } from "@gent/core/runtime/extensions/loader"

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
      execute: () => Effect.void,
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

describe("isClientFile", () => {
  test("matches *.client.tsx", () => {
    expect(isClientFile("my-tool.client.tsx")).toBe(true)
  })

  test("matches *.client.ts", () => {
    expect(isClientFile("my-tool.client.ts")).toBe(true)
  })

  test("matches *.client.js", () => {
    expect(isClientFile("my-tool.client.js")).toBe(true)
  })

  test("matches *.client.mjs", () => {
    expect(isClientFile("my-tool.client.mjs")).toBe(true)
  })

  test("matches client.tsx in subdirectory", () => {
    expect(isClientFile("client.tsx")).toBe(true)
  })

  test("matches client.ts in subdirectory", () => {
    expect(isClientFile("client.ts")).toBe(true)
  })

  test("matches client.jsx", () => {
    expect(isClientFile("client.jsx")).toBe(true)
  })

  test("does not match regular extension files", () => {
    expect(isClientFile("index.ts")).toBe(false)
    expect(isClientFile("my-tool.ts")).toBe(false)
    expect(isClientFile("extension.js")).toBe(false)
  })

  test("does not match partial name matches", () => {
    expect(isClientFile("my-client.ts")).toBe(false)
    expect(isClientFile("client-utils.ts")).toBe(false)
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
