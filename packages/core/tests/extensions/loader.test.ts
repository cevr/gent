import { describe, it, test, expect } from "effect-bun-test"
import { Effect } from "effect"
import { type LoadedExtension, type ProviderContribution } from "@gent/core/domain/extension"
import { extension } from "@gent/core/extensions/api"
import {
  validateExtensions,
  isClientFile,
  discoverExtensions,
} from "@gent/core/runtime/extensions/loader"
import type { PromptSection } from "@gent/core/domain/prompt"
import { BunServices } from "@effect/platform-bun"
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import nodePath from "node:path"

const makeLoaded = (
  id: string,
  kind: "builtin" | "user" | "project",
  opts: {
    toolNames?: string[]
    agentNames?: string[]
    providers?: ReadonlyArray<ProviderContribution>
    promptSections?: ReadonlyArray<PromptSection>
  } = {},
): LoadedExtension => ({
  manifest: { id },
  kind,
  sourcePath: `/test/${id}`,
  setup: {
    tools: (opts.toolNames ?? []).map((name) => ({
      name,
      action: "read" as const,
      description: `test tool ${name}`,
      params: {} as never,
      execute: () => Effect.void,
    })),
    agents:
      (opts.agentNames ?? []).length > 0
        ? (opts.agentNames ?? []).map(
            (name) =>
              ({
                name,
              }) as never,
          )
        : undefined,
    providers: opts.providers,
    promptSections: opts.promptSections,
  },
})

describe("validateExtensions", () => {
  it.live("passes with no extensions", () => validateExtensions([]))

  it.live("passes with unique extensions in same scope", () => {
    const exts = [
      makeLoaded("a", "builtin", { toolNames: ["tool-a"] }),
      makeLoaded("b", "builtin", { toolNames: ["tool-b"] }),
    ]
    return validateExtensions(exts)
  })

  it.live("passes with same tool name in different scopes", () => {
    const exts = [
      makeLoaded("builtin-fs", "builtin", { toolNames: ["read"] }),
      makeLoaded("custom-fs", "project", { toolNames: ["read"] }),
    ]
    return validateExtensions(exts)
  })

  it.live("fails on duplicate manifest id within same scope", () => {
    const exts = [makeLoaded("dupe", "user"), makeLoaded("dupe", "user")]
    return validateExtensions(exts).pipe(
      Effect.result,
      Effect.tap((result) => Effect.sync(() => expect(result._tag).toBe("Failure"))),
    )
  })

  it.live("allows same manifest id in different scopes", () => {
    const exts = [makeLoaded("same-id", "builtin"), makeLoaded("same-id", "project")]
    return validateExtensions(exts)
  })

  it.live("fails on same-name tool from two extensions in same scope", () => {
    const exts = [
      makeLoaded("ext-a", "builtin", { toolNames: ["conflicting-tool"] }),
      makeLoaded("ext-b", "builtin", { toolNames: ["conflicting-tool"] }),
    ]
    return validateExtensions(exts).pipe(
      Effect.result,
      Effect.tap((result) => Effect.sync(() => expect(result._tag).toBe("Failure"))),
    )
  })

  it.live("allows same-name tool from same extension", () => {
    const ext = makeLoaded("ext-a", "builtin", { toolNames: ["tool-a"] })
    return validateExtensions([ext])
  })

  it.live("fails on same-id provider from two extensions in same scope", () => {
    const exts = [
      makeLoaded("ext-a", "user", {
        providers: [{ id: "my-provider", name: "P1", resolveModel: () => null }],
      }),
      makeLoaded("ext-b", "user", {
        providers: [{ id: "my-provider", name: "P2", resolveModel: () => null }],
      }),
    ]
    return validateExtensions(exts).pipe(
      Effect.result,
      Effect.tap((result) => Effect.sync(() => expect(result._tag).toBe("Failure"))),
    )
  })

  it.live("allows same-id provider in different scopes", () => {
    const exts = [
      makeLoaded("ext-a", "builtin", {
        providers: [{ id: "my-provider", name: "P1", resolveModel: () => null }],
      }),
      makeLoaded("ext-b", "project", {
        providers: [{ id: "my-provider", name: "P2", resolveModel: () => null }],
      }),
    ]
    return validateExtensions(exts)
  })

  it.live("fails on same-id prompt section from two extensions in same scope", () => {
    const exts = [
      makeLoaded("ext-a", "project", {
        promptSections: [{ id: "rules", content: "Rule A", priority: 50 }],
      }),
      makeLoaded("ext-b", "project", {
        promptSections: [{ id: "rules", content: "Rule B", priority: 50 }],
      }),
    ]
    return validateExtensions(exts).pipe(
      Effect.result,
      Effect.tap((result) => Effect.sync(() => expect(result._tag).toBe("Failure"))),
    )
  })

  it.live("allows same-id prompt section in different scopes (higher scope wins)", () => {
    const exts = [
      makeLoaded("ext-a", "builtin", {
        promptSections: [{ id: "rules", content: "Builtin rules", priority: 50 }],
      }),
      makeLoaded("ext-b", "user", {
        promptSections: [{ id: "rules", content: "User rules", priority: 50 }],
      }),
    ]
    return validateExtensions(exts)
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
  test("extension() produces valid shape", () => {
    const ext = extension("test-ext", ({ ext }) => ext)
    expect(ext.manifest.id).toBe("test-ext")
    expect(typeof ext.setup).toBe("function")
  })
})

describe("discoverExtensions per-file isolation", () => {
  const makeTempDir = async () => {
    const base = await mkdtemp(nodePath.join(tmpdir(), "gent-test-"))
    const userDir = nodePath.join(base, "user")
    const projectDir = nodePath.join(base, "project")
    await mkdir(userDir, { recursive: true })
    await mkdir(projectDir, { recursive: true })
    return { base, userDir, projectDir }
  }

  // loadExtensionFile checks shape via isGentExtension (manifest.id + setup is function).
  // No need for a real Effect return — discovery only loads and shape-checks.
  const validExtensionCode = `
    export default {
      manifest: { id: "EXTID" },
      setup: () => ({ _tag: "Success", value: { tools: [] } }),
    }
  `

  const brokenExtensionCode = `throw new Error("broken extension")`

  it.live(
    "broken file does not suppress sibling extensions",
    () =>
      Effect.gen(function* () {
        const dirs = yield* Effect.promise(makeTempDir)

        // Write one valid, one broken
        yield* Effect.promise(() =>
          writeFile(
            nodePath.join(dirs.userDir, "good.js"),
            validExtensionCode.replace("EXTID", "good-ext"),
          ),
        )
        yield* Effect.promise(() =>
          writeFile(nodePath.join(dirs.userDir, "broken.js"), brokenExtensionCode),
        )

        const result = yield* discoverExtensions({
          userDir: dirs.userDir,
          projectDir: dirs.projectDir,
        })

        expect(result.loaded.length).toBe(1)
        expect(result.loaded[0]!.extension.manifest.id).toBe("good-ext")
        expect(result.skipped.length).toBe(1)
        expect(result.skipped[0]!.path).toContain("broken.js")

        yield* Effect.promise(() => rm(dirs.base, { recursive: true }))
      }).pipe(Effect.provide(BunServices.layer)),
    { timeout: 10000 },
  )

  it.live(
    "multiple valid files all load successfully",
    () =>
      Effect.gen(function* () {
        const dirs = yield* Effect.promise(makeTempDir)

        yield* Effect.promise(() =>
          writeFile(
            nodePath.join(dirs.userDir, "alpha.js"),
            validExtensionCode.replace("EXTID", "alpha"),
          ),
        )
        yield* Effect.promise(() =>
          writeFile(
            nodePath.join(dirs.projectDir, "beta.js"),
            validExtensionCode.replace("EXTID", "beta"),
          ),
        )

        const result = yield* discoverExtensions({
          userDir: dirs.userDir,
          projectDir: dirs.projectDir,
        })

        expect(result.loaded.length).toBe(2)
        expect(result.skipped.length).toBe(0)
        const ids = result.loaded.map((d) => d.extension.manifest.id).sort()
        expect(ids).toEqual(["alpha", "beta"])
        // Check kinds assigned correctly
        expect(result.loaded.find((d) => d.extension.manifest.id === "alpha")!.kind).toBe("user")
        expect(result.loaded.find((d) => d.extension.manifest.id === "beta")!.kind).toBe("project")

        yield* Effect.promise(() => rm(dirs.base, { recursive: true }))
      }).pipe(Effect.provide(BunServices.layer)),
    { timeout: 10000 },
  )

  it.live(
    "file with no GentExtension export is skipped",
    () =>
      Effect.gen(function* () {
        const dirs = yield* Effect.promise(makeTempDir)

        yield* Effect.promise(() =>
          writeFile(nodePath.join(dirs.userDir, "no-ext.js"), `export const foo = 42`),
        )
        yield* Effect.promise(() =>
          writeFile(
            nodePath.join(dirs.userDir, "valid.js"),
            validExtensionCode.replace("EXTID", "valid"),
          ),
        )

        const result = yield* discoverExtensions({
          userDir: dirs.userDir,
          projectDir: dirs.projectDir,
        })

        expect(result.loaded.length).toBe(1)
        expect(result.loaded[0]!.extension.manifest.id).toBe("valid")
        expect(result.skipped.length).toBe(1)
        expect(result.skipped[0]!.error).toContain("No GentExtension found")

        yield* Effect.promise(() => rm(dirs.base, { recursive: true }))
      }).pipe(Effect.provide(BunServices.layer)),
    { timeout: 10000 },
  )
})
