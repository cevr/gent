import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import {
  collectExportFacts,
  findPackageSurfaceFindings,
  findUnconsumedExports,
  type ExportFacts,
  type PackageJson,
} from "../src/export-consumers"

const CORE_FILE = "packages/core/src/runtime/retry.ts"
const SDK_FILE = "packages/sdk/src/log-paths.ts"
const SDK_CONSUMER = "packages/sdk/src/logger.ts"
const API_FILE = "packages/core/src/extensions/api.ts"
const API_CONSUMER = "packages/extensions/src/notes/index.ts"
const EXTENSION_FILE = "packages/extensions/src/fs-tools/edit.ts"

interface SourceEntry {
  readonly file: string
  readonly text: string
}

const factsFor = (entries: ReadonlyArray<SourceEntry>): ReadonlyMap<string, ExportFacts> => {
  const byFile = new Map<string, ExportFacts>()
  for (const { file, text } of entries) byFile.set(file, collectExportFacts(file, text))
  return byFile
}

const declaredNames = (file: string, text: string): ReadonlyArray<string> =>
  collectExportFacts(file, text).declarations.map((declaration) => declaration.name)

const findingsFor = (entries: ReadonlyArray<SourceEntry>) =>
  findUnconsumedExports(factsFor(entries))

const apiSource = `export { defineExtension } from "../domain/extension.js"
export {
  tool,
  type ToolCapability,
} from "../domain/capability/tool.js"
export { CapabilityError, CapabilityNotFoundError } from "../domain/capability.js"
`

const consumedThroughApi = (file: string, text: string): ReadonlySet<string> =>
  Option.getOrElse(
    Option.fromNullishOr(collectExportFacts(file, text).imported.get("@gent/core/extensions/api")),
    () => new Set<string>(),
  )

describe("module surface declarations", () => {
  test("reads declared exports from a scanned core file", () => {
    const source = `export const retrySchedule = 1
const notExported = 2
export interface RetryPolicy {}
`
    expect(
      collectExportFacts(CORE_FILE, source).declarations.map(({ name, line }) => ({ name, line })),
    ).toEqual([
      { name: "retrySchedule", line: 1 },
      { name: "RetryPolicy", line: 3 },
    ])
  })

  test("reads declared exports from a scanned sdk file", () => {
    const source = `export const buildLogPaths = 1
export type LogPaths = { readonly dir: string }
`
    expect(declaredNames(SDK_FILE, source)).toEqual(["buildLogPaths", "LogPaths"])
  })

  test("a file in an unscanned package declares nothing", () => {
    expect(declaredNames("apps/tui/src/app.tsx", `export const AppHelper = 1\n`)).toEqual([])
  })

  test("core's exempt entry points declare nothing as a module", () => {
    const source = `export const tool = 1\n`
    expect(declaredNames(API_FILE, source)).toEqual([])
    expect(declaredNames("packages/core/src/extensions/branch-tools.ts", source)).toEqual([])
    expect(declaredNames("packages/core/src/protocol.ts", source)).toEqual([])
    expect(declaredNames("packages/core/src/test-utils/fixtures.ts", source)).toEqual([])
  })
})

describe("strict module surfaces (core, sdk)", () => {
  test("a planted sdk export no other file names is reported with its line", () => {
    const planted = `export const buildLogPaths = 1

export const plantedDeadSdkExport = "nothing imports this"
`
    const consumer = `import { buildLogPaths } from "./log-paths.js"\n`
    const findings = findingsFor([
      { file: SDK_FILE, text: planted },
      { file: SDK_CONSUMER, text: consumer },
    ])

    expect(findings).toHaveLength(1)
    expect(findings[0]?.file).toBe(SDK_FILE)
    expect(findings[0]?.line).toBe(3)
    expect(findings[0]?.enforced).toBe(true)
    expect(findings[0]?.message).toContain("`plantedDeadSdkExport`")
  })

  test("an sdk export another sdk file imports is live", () => {
    expect(
      findingsFor([
        { file: SDK_FILE, text: `export const ensureLogDir = 1\n` },
        { file: SDK_CONSUMER, text: `import { ensureLogDir } from "./log-paths.js"\n` },
      ]),
    ).toEqual([])
  })

  test("a name an unscanned package reaches for is live", () => {
    expect(
      findingsFor([
        { file: SDK_FILE, text: `export const sharedName = 1\n` },
        { file: "apps/tui/src/app.tsx", text: `import { sharedName } from "@gent/sdk"\n` },
      ]),
    ).toEqual([])
  })

  test("a name only a test file reaches for is live", () => {
    expect(
      findingsFor([
        { file: CORE_FILE, text: `export const retrySchedule = 1\n` },
        {
          file: "packages/core/tests/runtime/retry.test.ts",
          text: `import { retrySchedule } from "../../src/runtime/retry"\n`,
        },
      ]),
    ).toEqual([])
  })

  test("a name only its own module reads is still reported", () => {
    // Core and the SDK are held to the strict reading: drop the `export`.
    const findings = findingsFor([
      {
        file: CORE_FILE,
        text: `export const retrySchedule = 1\nconst twice = retrySchedule * 2\n`,
      },
    ])
    expect(findings.map((finding) => finding.line)).toEqual([1])
    expect(findings[0]?.message).toContain("drop the `export` keyword")
  })

  test("a name two scanned files both declare needs a third file to be live", () => {
    const findings = findingsFor([
      { file: CORE_FILE, text: `export const sameName = 1\n` },
      { file: SDK_FILE, text: `export const sameName = 2\n` },
    ])
    expect(findings.map((finding) => finding.file).sort()).toEqual([CORE_FILE, SDK_FILE])
  })
})

describe("schema-aware module surface (extensions)", () => {
  test("a schema the tool beside it reads is live", () => {
    const source = `export const EditParams = Schema.Struct({ path: Schema.String })
export class EditError extends Schema.TaggedError<EditError>()("EditError", {}) {}
export const edit = tool({ params: EditParams, run: () => new EditError({}) })
`
    expect(
      findingsFor([
        { file: EXTENSION_FILE, text: source },
        {
          file: "packages/extensions/src/index.ts",
          text: `import { edit } from "./fs-tools/edit"`,
        },
      ]),
    ).toEqual([])
  })

  test("a service its own module yields is live", () => {
    const source = `export interface WakeAlarmsService { readonly schedule: () => void }
export class WakeAlarms extends Context.Service<WakeAlarms, WakeAlarmsService>()(
  "@gent/extensions/src/wake/WakeAlarms",
) {}
const use = Effect.gen(function* () {
  const alarms = yield* WakeAlarms
  return alarms
})
`
    expect(findingsFor([{ file: "packages/extensions/src/wake/index.ts", text: source }])).toEqual(
      [],
    )
  })

  test("a class only its own declaration, _tag string, and doc comment name is reported", () => {
    const source = `/** HandoffError is raised when the handoff fails. */
export class HandoffError extends Schema.TaggedError<HandoffError>()(
  "HandoffError",
  { message: Schema.String },
) {}
export const handoff = tool({ run: () => "HandoffError happened" })
`
    const findings = findingsFor([
      { file: "packages/extensions/src/handoff-tool.ts", text: source },
      {
        file: "packages/extensions/src/index.ts",
        text: `import { handoff } from "./handoff-tool"`,
      },
    ])
    expect(findings.map((finding) => finding.line)).toEqual([2])
    expect(findings[0]?.enforced).toBe(true)
    expect(findings[0]?.message).toContain("`HandoffError`")
    expect(findings[0]?.message).toContain("delete it")
  })

  test("a const and type pair nothing else reads is reported on both lines", () => {
    const source = `export const SessionUpdate = Schema.Union([Schema.String])
export type SessionUpdate = typeof SessionUpdate.Type
`
    const findings = findingsFor([
      { file: "packages/extensions/src/acp-agents/schema.ts", text: source },
    ])
    expect(findings.map((finding) => finding.line)).toEqual([1, 2])
  })

  test("a name an extension test reaches for is live", () => {
    expect(
      findingsFor([
        { file: EXTENSION_FILE, text: `export const findMatch = 1\n` },
        {
          file: "packages/extensions/tests/fs-tools/edit.test.ts",
          text: `import { findMatch } from "../../src/fs-tools/edit"\n`,
        },
      ]),
    ).toEqual([])
  })
})

describe("public extension API entry point", () => {
  test("reads names from single-line and multi-line export blocks", () => {
    expect(declaredNames(API_FILE, apiSource)).toEqual([
      "defineExtension",
      "tool",
      "ToolCapability",
      "CapabilityError",
      "CapabilityNotFoundError",
    ])
  })

  test("a name nothing outside core reaches for is reported with its line", () => {
    const findings = findingsFor([
      { file: API_FILE, text: apiSource },
      {
        file: API_CONSUMER,
        text: `import { defineExtension, tool, type ToolCapability, CapabilityError } from "@gent/core/extensions/api"`,
      },
    ])
    expect(findings).toHaveLength(1)
    expect(findings[0]?.file).toBe(API_FILE)
    expect(findings[0]?.line).toBe(6)
    expect(findings[0]?.enforced).toBe(true)
    expect(findings[0]?.message).toContain('"CapabilityNotFoundError"')
  })

  test("only an import through the public path counts", () => {
    // The same symbol reached over a relative path is not consumption of the
    // public API -- nothing gets it from `extensions/api`, which is the only
    // question this surface asks.
    expect(
      consumedThroughApi(
        API_CONSUMER,
        `import { tool } from "../../../core/src/domain/capability/tool"`,
      ),
    ).not.toContain("tool")
    expect(
      consumedThroughApi(API_CONSUMER, `import { tool } from "@gent/core/extensions/api"`),
    ).toContain("tool")
  })

  test("a bare mention outside an import does not keep a public name alive", () => {
    const findings = findingsFor([
      { file: API_FILE, text: `export { tool } from "../domain/capability/tool.js"\n` },
      { file: API_CONSUMER, text: `const tool = 1\n` },
    ])
    expect(findings.map((finding) => finding.line)).toEqual([1])
  })

  test("an alias credits the original name, not the local one", () => {
    // `X as Y` still requires the public API to export `X`.
    const names = consumedThroughApi(
      API_CONSUMER,
      `import { messagePartText as renderText } from "@gent/core/extensions/api"`,
    )
    expect(names).toContain("messagePartText")
    expect(names).not.toContain("renderText")
  })

  test("a multi-line import block is read as one statement", () => {
    const names = consumedThroughApi(
      API_CONSUMER,
      `import {
  tool,
  type ToolCapability,
} from "@gent/core/extensions/api"`,
    )
    expect([...names].sort()).toEqual(["ToolCapability", "tool"])
  })

  test("a namespace import credits every member it reads", () => {
    const names = consumedThroughApi(
      API_CONSUMER,
      `import * as Api from "@gent/core/extensions/api"
const x: Api.ToolCapability = Api.tool({})`,
    )
    expect([...names].sort()).toEqual(["ToolCapability", "tool"])
  })

  test("a @ts-expect-error reference asserts absence, so it never counts", () => {
    // The surface-lock suites reach for removed names precisely to prove they
    // are gone. Crediting those would pin removed surface in place forever.
    const names = consumedThroughApi(
      API_CONSUMER,
      `import * as Api from "@gent/core/extensions/api"
    // @ts-expect-error — action factory was removed
    type Bad = typeof Api.action`,
    )
    expect(names).not.toContain("action")
  })

  test("core's own source never counts as a consumer", () => {
    const findings = findingsFor([
      { file: API_FILE, text: `export { tool } from "../domain/capability/tool.js"\n` },
      {
        file: "packages/core/src/domain/capability.ts",
        text: `import { tool } from "@gent/core/extensions/api"`,
      },
      {
        file: "packages/core-internal/src/capability.ts",
        text: `import { tool } from "@gent/core/extensions/api"`,
      },
    ])
    expect(findings.map((finding) => finding.line)).toEqual([1])
  })

  test("a test outside core is a real consumer of the public API", () => {
    expect(
      findingsFor([
        { file: API_FILE, text: `export { tool } from "../domain/capability/tool.js"\n` },
        {
          file: "packages/extensions/tests/api-surface.test.ts",
          text: `import { tool } from "@gent/core/extensions/api"`,
        },
      ]),
    ).toEqual([])
  })
})

const packageSurface = (
  entries: ReadonlyArray<readonly [string, PackageJson]>,
  paths: Readonly<Record<string, ReadonlyArray<string>>>,
) => findPackageSurfaceFindings(new Map(entries), { compilerOptions: { paths } })

describe("package entry points", () => {
  test("allows explicit extension and protocol exports", () => {
    expect(
      packageSurface(
        [
          [
            "packages/core/package.json",
            {
              exports: {
                "./extensions/api": "./src/extensions/api.ts",
                "./extensions/api.js": "./src/extensions/api.ts",
                "./protocol": "./src/protocol.ts",
                "./protocol.js": "./src/protocol.ts",
              },
            },
          ],
          [
            "packages/core-internal/package.json",
            { private: true, exports: { "./*.js": "./src/*.ts", "./*": "./src/*.ts" } },
          ],
        ],
        {
          "@gent/core/extensions/api": ["./packages/core/src/extensions/api.ts"],
          "@gent/core/extensions/api.js": ["./packages/core/src/extensions/api.ts"],
          "@gent/core/protocol": ["./packages/core/src/protocol.ts"],
          "@gent/core/protocol.js": ["./packages/core/src/protocol.ts"],
          "@gent/core-internal/*.js": ["./packages/core/src/*.ts"],
          "@gent/core-internal/*": ["./packages/core/src/*"],
        },
      ),
    ).toEqual([])
  })

  test("flags public internal core exports and tsconfig aliases", () => {
    expect(
      packageSurface(
        [
          [
            "packages/core/package.json",
            {
              exports: {
                "./extensions/api": "./src/extensions/api.ts",
                "./domain/ids": "./src/domain/ids.ts",
              },
            },
          ],
        ],
        { "@gent/core/domain/ids": ["./packages/core/src/domain/ids.ts"] },
      ).map((finding) => finding.path),
    ).toEqual([
      'packages/core/package.json exports["./domain/ids"]',
      'tsconfig.json compilerOptions.paths["@gent/core/domain/ids"]',
    ])
  })

  test("rejects protocol wildcards and unknown core paths", () => {
    expect(
      packageSurface(
        [["packages/core/package.json", { exports: { "./protocol/*": "./src/*.ts" } }]],
        {
          "@gent/core/protocol/*": ["./packages/core/src/*"],
          "@gent/core/unknown": ["./packages/core/src/domain/ids.ts"],
        },
      ).map((finding) => finding.path),
    ).toEqual([
      'packages/core/package.json exports["./protocol/*"]',
      'tsconfig.json compilerOptions.paths["@gent/core/protocol/*"]',
      'tsconfig.json compilerOptions.paths["@gent/core/unknown"]',
    ])
  })

  test("keeps the workspace internal package private and narrow", () => {
    expect(
      packageSurface(
        [
          [
            "packages/core-internal/package.json",
            { private: false, exports: { "./debug/*": "./src/debug/*.ts" } },
          ],
        ],
        {},
      ),
    ).toEqual([
      {
        path: "packages/core-internal/package.json private",
        message: "@gent/core-internal must stay private; it is not a published contract",
      },
      {
        path: 'packages/core-internal/package.json exports["./debug/*"]',
        message: "@gent/core-internal may only expose its supported entry points: ./*.js, ./*",
      },
      {
        path: 'packages/core-internal/package.json exports["./*.js"]',
        message: '@gent/core-internal must map "./*.js" to "./src/*.ts"',
      },
      {
        path: 'packages/core-internal/package.json exports["./*"]',
        message: '@gent/core-internal must map "./*" to "./src/*.ts"',
      },
    ])
  })

  test("allows only root composition and client contracts for extensions", () => {
    expect(
      packageSurface(
        [
          [
            "packages/extensions/package.json",
            {
              private: true,
              exports: {
                ".": "./src/index.ts",
                "./index.js": "./src/index.ts",
                "./client": "./src/client.ts",
                "./client.js": "./src/client.ts",
              },
            },
          ],
        ],
        {
          "@gent/extensions": ["./packages/extensions/src/index.ts"],
          "@gent/extensions/index.js": ["./packages/extensions/src/index.ts"],
          "@gent/extensions/client": ["./packages/extensions/src/client.ts"],
          "@gent/extensions/client.js": ["./packages/extensions/src/client.ts"],
        },
      ),
    ).toEqual([])
  })

  test("flags extension implementation subpaths", () => {
    expect(
      packageSurface(
        [
          [
            "packages/extensions/package.json",
            {
              private: false,
              exports: { ".": "./src/index.ts", "./todo-storage": "./src/todo-storage.ts" },
            },
          ],
        ],
        { "@gent/extensions/todo-storage": ["./packages/extensions/src/todo-storage.ts"] },
      ),
    ).toEqual([
      {
        path: "packages/extensions/package.json private",
        message: "@gent/extensions must stay private; it is not a published contract",
      },
      {
        path: 'packages/extensions/package.json exports["./todo-storage"]',
        message:
          "@gent/extensions may only expose its supported entry points: ., ./index.js, ./client, ./client.js",
      },
      {
        path: 'tsconfig.json compilerOptions.paths["@gent/extensions/todo-storage"]',
        message:
          "Do not give TypeScript a public-looking @gent/extensions path for an internal module",
      },
    ])
  })

  test("allows only the root client contract export for the sdk", () => {
    expect(
      packageSurface([["packages/sdk/package.json", { exports: { ".": "./src/index.ts" } }]], {
        "@gent/sdk": ["./packages/sdk/src/index.ts"],
      }),
    ).toEqual([])
  })

  test("flags internal sdk subpath exports", () => {
    expect(
      packageSurface(
        [
          [
            "packages/sdk/package.json",
            { exports: { ".": "./src/index.ts", "./rpcs": "./src/rpcs.ts" } },
          ],
        ],
        {},
      ),
    ).toEqual([
      {
        path: 'packages/sdk/package.json exports["./rpcs"]',
        message: "@gent/sdk may only expose its supported entry points: .",
      },
    ])
  })
})
