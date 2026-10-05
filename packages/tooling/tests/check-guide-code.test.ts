import { BunServices } from "@effect/platform-bun"
import { Config, Effect, FileSystem, Path } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { test } from "bun:test"
import { describe, expect, it } from "effect-bun-test"
import { fileSet } from "../src/check-guardrails"
import {
  compileContext,
  guideBlockFile,
  guideCodeBlocks,
  guideCodeContextOf,
  guideDiagnosticLine,
  requireContextModules,
  steeringFilesAmong,
} from "../src/check-guide-code"

const contextTest = it.scopedLive.layer(BunServices.layer)

const extension = {
  name: "extension",
  tsconfig: "tsconfig.json",
  modules: "examples/node_modules",
}

describe("a compile context's dependencies", () => {
  contextTest("a context whose node_modules is missing fails the check by name", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const repoRoot = yield* fs.makeTempDirectoryScoped({ prefix: "gent-guide-root-" })
      const error = yield* Effect.flip(requireContextModules(repoRoot, extension))
      expect(error._tag).toBe("GuideCodeError")
      expect(error.message).toContain("examples/node_modules")
      expect(error.message).toContain("bun install")
    }),
  )

  contextTest("a context with installed node_modules passes the dependency check", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const repoRoot = yield* fs.makeTempDirectoryScoped({ prefix: "gent-guide-root-" })
      yield* fs.makeDirectory(path.join(repoRoot, "examples", "node_modules"), { recursive: true })
      yield* requireContextModules(repoRoot, extension)
    }),
  )
})

describe("the repo's compiler options", () => {
  contextTest("guide modules keep syntax policies and explicit test scope at Markdown lines", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const repoRoot = path.resolve(yield* path.fromFileUrl(new URL("../../..", import.meta.url)))
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "gent-guide-syntax-" })
      const blocks = guideCodeBlocks(
        "docs/extensions.md",
        [
          "# Guide",
          "",
          "```ts",
          "export const load = async () => 1",
          "export const stamp = Date.now()",
          "```",
          "```ts",
          'import { Effect } from "effect"',
          'export const result = Effect.succeed("ready")',
          "```",
          "```ts",
          'export { testAgent } from "@gent/core/test-utils"',
          "```",
          "```ts lint=test",
          'export { testAgent } from "@gent/core/test-utils"',
          "```",
        ].join("\n"),
      )
      const names = blocks.map((block, index) => guideBlockFile(index, block))
      yield* Effect.forEach(blocks, (block, index) =>
        fs
          .makeDirectory(path.dirname(path.join(directory, names[index]!)), { recursive: true })
          .pipe(
            Effect.andThen(fs.writeFileString(path.join(directory, names[index]!), block.code)),
          ),
      )
      const failures = (yield* compileContext(repoRoot, directory, extension, names)).map((line) =>
        guideDiagnosticLine(line, blocks),
      )
      expect(failures).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^docs\/extensions\.md:4:\d+.*effect\(noAsyncFunction\)/),
          expect.stringMatching(/^docs\/extensions\.md:5:\d+.*effect\(noGlobals\)/),
          expect.stringMatching(/^docs\/extensions\.md:12:\d+.*gent\(core-entry-boundary\)/),
        ]),
      )
      expect(failures.filter((line) => line.includes(": lint "))).toHaveLength(3)
    }).pipe(Effect.timeout("25 seconds")),
  )

  contextTest("a test block lints as a test module: it may run on the platform layer", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const repoRoot = path.resolve(yield* path.fromFileUrl(new URL("../../..", import.meta.url)))
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "gent-guide-test-scope-" })
      const platformTest = [
        'import { BunServices } from "@effect/platform-bun"',
        'import { Effect } from "effect"',
        'import { it } from "effect-bun-test"',
        'it.scopedLive.layer(BunServices.layer)("runs on the platform", () => Effect.void)',
        "```",
      ]
      const blocks = guideCodeBlocks(
        "docs/extensions.md",
        ["```ts", ...platformTest, "```ts lint=test", ...platformTest].join("\n"),
      )
      const names = blocks.map((block, index) => guideBlockFile(index, block))
      yield* Effect.forEach(blocks, (block, index) =>
        fs
          .makeDirectory(path.dirname(path.join(directory, names[index]!)), { recursive: true })
          .pipe(
            Effect.andThen(fs.writeFileString(path.join(directory, names[index]!), block.code)),
          ),
      )
      const failures = (yield* compileContext(repoRoot, directory, extension, names)).map((line) =>
        guideDiagnosticLine(line, blocks),
      )
      // Only the extension block provides a platform layer outside an entry.
      expect(failures.filter((line) => line.includes(": lint "))).toEqual([
        expect.stringMatching(/^docs\/extensions\.md:5:\d+.*effect\(noPlatformLayerOutsideEntry\)/),
      ])
    }).pipe(Effect.timeout("25 seconds")),
  )

  contextTest("TUI guide code keeps JSX dependencies and terminal-width policy", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const repoRoot = path.resolve(yield* path.fromFileUrl(new URL("../../..", import.meta.url)))
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "gent-guide-tui-" })
      const file = "apps/tui/AGENTS.md"
      const blocks = guideCodeBlocks(
        file,
        [
          "```tsx",
          "export const view = <box><text>Ready</text></box>",
          "```",
          "```ts",
          "export const format = (text: string) => text.padEnd(20)",
          "```",
        ].join("\n"),
      )
      const names = blocks.map((block, index) => guideBlockFile(index, block))
      yield* Effect.forEach(blocks, (block, index) =>
        fs
          .makeDirectory(path.dirname(path.join(directory, names[index]!)), { recursive: true })
          .pipe(
            Effect.andThen(fs.writeFileString(path.join(directory, names[index]!), block.code)),
          ),
      )
      const failures = (yield* compileContext(
        repoRoot,
        directory,
        guideCodeContextOf(file),
        names,
      )).map((line) => guideDiagnosticLine(line, blocks))
      expect(failures.filter((line) => line.includes(": lint "))).toEqual([
        expect.stringMatching(/^apps\/tui\/AGENTS.md:5:\d+.*gent\(no-code-unit-padding\)/),
      ])
      expect(failures.some((line) => line.includes("tsc exited"))).toBe(false)
    }).pipe(Effect.timeout("25 seconds")),
  )

  // The block compiles the way an extension author's file does: the root
  // tsconfig with its Effect diagnostics, the examples package's modules.
  contextTest("a native Error subclass fails the compile with extendsNativeError", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const repoRoot = path.resolve(yield* path.fromFileUrl(new URL("../../..", import.meta.url)))
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "gent-native-error-" })
      yield* fs.writeFileString(
        path.join(directory, "b1.ts"),
        "export class Boom extends Error {}\n",
      )
      const failure = yield* compileContext(repoRoot, directory, extension, ["b1.ts"])
      expect(failure.some((line) => line.includes("extendsNativeError"))).toBe(true)
    }).pipe(Effect.timeout("25 seconds")),
  )
})

describe("the steering files the check reads", () => {
  contextTest("a listed file gone from disk is skipped, and a symlink is read once", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const repoRoot = yield* fs.makeTempDirectoryScoped({ prefix: "gent-guide-root-" })
      yield* fs.writeFileString(path.join(repoRoot, "AGENTS.md"), "# Agents\n")
      yield* fs.symlink("AGENTS.md", path.join(repoRoot, "CLAUDE.md"))
      // `docs/gone.md` is still in the index but was trashed from the worktree.
      const listed = ["AGENTS.md", "CLAUDE.md", "docs/gone.md"]
      expect(yield* steeringFilesAmong(repoRoot, listed)).toEqual(["AGENTS.md"])
    }),
  )

  contextTest("a repo reached through a symlinked root still reads its files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "gent-guide-root-" })
      yield* fs.makeDirectory(path.join(parent, "repo"))
      yield* fs.writeFileString(path.join(parent, "repo", "AGENTS.md"), "# Agents\n")
      // macOS temp roots live under `/var`, a link to `/private/var`.
      yield* fs.symlink("repo", path.join(parent, "linked"))
      const repoRoot = path.join(parent, "linked")
      expect(yield* steeringFilesAmong(repoRoot, ["AGENTS.md"])).toEqual(["AGENTS.md"])
    }),
  )

  contextTest("the check reads the staged steering files, not an untracked one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const repoRoot = yield* fs.makeTempDirectoryScoped({ prefix: "gent-guide-root-" })
      // Git's whole environment: no hook's `GIT_INDEX_FILE`, no user config.
      const env = { PATH: yield* Config.String("PATH"), HOME: repoRoot }
      const git = (args: ReadonlyArray<string>) =>
        spawner.exitCode(
          ChildProcess.make("git", args, {
            cwd: repoRoot,
            env,
            extendEnv: false,
            forceKillAfter: "2 seconds",
          }),
        )
      yield* fs.writeFileString(path.join(repoRoot, "AGENTS.md"), "# Agents\n")
      yield* fs.makeDirectory(path.join(repoRoot, "docs"))
      yield* fs.writeFileString(path.join(repoRoot, "docs", "draft.md"), "# Draft\n")
      expect(yield* git(["init", "-q"])).toBe(ChildProcessSpawner.ExitCode(0))
      expect(yield* git(["add", "AGENTS.md"])).toBe(ChildProcessSpawner.ExitCode(0))
      const listed = yield* fileSet(repoRoot, env).files
      expect(yield* steeringFilesAmong(repoRoot, listed)).toEqual(["AGENTS.md"])
    }),
  )
})

describe("steering prose code blocks", () => {
  const guide = [
    "# Guide",
    "```ts",
    "const a = 1",
    "const b = 2",
    "```",
    "```json",
    '{ "x": 1 }',
    "```",
    "```typescript",
    "const c = 3",
    "```",
  ].join("\n")

  test("each ts and typescript block is read with the file line of its first code line", () => {
    expect(guideCodeBlocks("docs/extensions.md", guide)).toEqual([
      {
        file: "docs/extensions.md",
        line: 3,
        code: "const a = 1\nconst b = 2",
        extension: "ts",
        testCode: false,
      },
      {
        file: "docs/extensions.md",
        line: 10,
        code: "const c = 3",
        extension: "ts",
        testCode: false,
      },
    ])
  })

  test("a tsx block is written as a tsx module and compiles in the context of its file", () => {
    const blocks = guideCodeBlocks("apps/tui/AGENTS.md", ["```tsx", "<box />", "```"].join("\n"))
    expect(blocks).toEqual([
      { file: "apps/tui/AGENTS.md", line: 2, code: "<box />", extension: "tsx", testCode: false },
    ])
    expect(blocks.map((block, index) => guideBlockFile(index, block))).toEqual([
      "apps/tui/src/b1.tsx",
    ])
    expect(guideCodeContextOf("apps/tui/AGENTS.md").tsconfig).toBe("apps/tui/tsconfig.json")
    expect(guideCodeContextOf("AGENTS.md").modules).toBe("examples/node_modules")
  })

  test("a ts block is read in every fence shape the guards read as a fence", () => {
    const fences = [
      ["- a list item", "  ```ts", "  const a = 1", "    const b = 2", "  ```"],
      ["~~~ts", "const c = 3", "~~~"],
      ["````ts", "```", "const d = 4", "````"],
      ["```text title", "prose", "```", "```ts", "const e = 5", "```"],
    ]
    expect(
      fences.map((lines) =>
        guideCodeBlocks("docs/x.md", lines.join("\n")).map(({ line, code }) => ({ line, code })),
      ),
    ).toEqual([
      [{ line: 3, code: "const a = 1\n  const b = 2" }],
      [{ line: 2, code: "const c = 3" }],
      [{ line: 2, code: "```\nconst d = 4" }],
      [{ line: 5, code: "const e = 5" }],
    ])
  })

  test("a ts fence quoted inside a fence of another language is not a block", () => {
    expect(guideCodeBlocks("docs/x.md", ["```text", "```ts", "```"].join("\n"))).toEqual([])
  })

  test("a block marked illustrative with a reason is skipped; a mark without one is not", () => {
    const marked = ["<!-- illustrative: elides the layer -->", "```ts", "x ...", "```"]
    const bare = ["<!-- illustrative: -->", "```ts", "const y = 1", "```"]
    expect(guideCodeBlocks("docs/x.md", marked.join("\n"))).toEqual([])
    expect(guideCodeBlocks("docs/x.md", bare.join("\n")).map((block) => block.code)).toEqual([
      "const y = 1",
    ])
  })

  test("a diagnostic is reported at its line in the file that holds the block", () => {
    const blocks = [
      ...guideCodeBlocks("docs/extensions.md", guide),
      ...guideCodeBlocks("apps/tui/AGENTS.md", ["", "```tsx", "<box />", "```"].join("\n")),
    ]
    expect(guideDiagnosticLine("b1.ts(2,7): error TS1: x", blocks)).toBe(
      "docs/extensions.md:4:7: error TS1: x",
    )
    expect(
      guideDiagnosticLine("/tmp/gent-guide-code-x/extension/b2.ts(1,1): suggestion TS2: y", blocks),
    ).toBe("docs/extensions.md:10:1: suggestion TS2: y")
    // A test block's module is a test module by name.
    expect(guideDiagnosticLine("examples/tests/b2.test.ts(3,4): lint x", blocks)).toBe(
      "docs/extensions.md:12:4: lint x",
    )
    expect(guideDiagnosticLine("tui/b3.tsx(1,2): error TS3: z", blocks)).toBe(
      "apps/tui/AGENTS.md:3:2: error TS3: z",
    )
    expect(guideDiagnosticLine("error TS2688: no bun types", blocks)).toBe(
      "error TS2688: no bun types",
    )
  })
})
