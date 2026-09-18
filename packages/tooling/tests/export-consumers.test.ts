import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import {
  collectExportFacts,
  findPackageSurfaceFindings,
  findUnconsumedExports,
  type ExportFacts,
  type PackageJson,
} from "../src/guards"

const CORE_FILE = "packages/core/src/runtime/provider.ts"
const SDK_FILE = "packages/sdk/src/log-paths.ts"
const SDK_CONSUMER = "packages/sdk/src/logger.ts"
const API_FILE = "packages/core/src/extensions/api.ts"
const API_CONSUMER = "packages/extensions/src/notes/index.ts"
const BRANCH_TOOLS_FILE = "packages/core/src/extensions/branch-tools.ts"
const BRANCH_TOOLS_CONSUMER = "packages/extensions/src/cell/cell-tool-host.ts"
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
    // Reference extensions stand alone; no surface row covers `examples/`.
    expect(
      declaredNames("examples/extensions/session-notes.ts", `export const ExampleHelper = 1\n`),
    ).toEqual([])
  })

  test("a bare export block is a surface, so its names are declared", () => {
    // 26 names hid in one such block in packages/sdk/src/client.ts because
    // only `export const|type|...` was read.
    const source = `type Local = { readonly a: number }
export type { Local }
`
    expect(declaredNames(SDK_FILE, source)).toEqual(["Local"])
  })

  test("a bare block names a file already declares are not counted twice", () => {
    const source = `export const buildLogPaths = 1
export { buildLogPaths }
`
    expect(declaredNames(SDK_FILE, source)).toEqual(["buildLogPaths"])
  })

  test("a bare block re-exporting an imported name declares nothing", () => {
    // The name belongs to the file that declared it. Counting the pass-through
    // here would make this file a declaring site and hide the real consumer.
    const source = `import { WakeExtension } from "./wake/index.js"
export { WakeExtension }
`
    expect(declaredNames("packages/extensions/src/index.ts", source)).toEqual([])
  })

  test("a from block on a module surface declares the name it exposes", () => {
    // The re-export puts a second consumable name at this module path. A dead
    // one is dead here even though the declaring file keeps its own alive.
    const source = `export { ToolRunner } from "../runtime/agent/tool-runner.js"\n`
    expect(declaredNames(SDK_FILE, source)).toEqual(["ToolRunner"])
  })

  test("a from block declares every shape it carries across lines", () => {
    const source = `export {
  Alpha,
  type Beta,
  Gamma as Delta,
} from "./shapes.js"
`
    expect(declaredNames(SDK_FILE, source)).toEqual(["Alpha", "Beta", "Delta"])
  })

  test("a from re-export of a name the file also declares is not counted twice", () => {
    const source = `export const shared = 1
export { shared } from "./elsewhere.js"
`
    expect(declaredNames(SDK_FILE, source)).toEqual(["shared"])
  })

  test("a from re-export nothing imports is reported", () => {
    const findings = findingsFor([
      {
        file: SDK_FILE,
        text: `import { Orphan } from "./elsewhere.js"
export { Orphan } from "./elsewhere.js"
void Orphan
`,
      },
      { file: SDK_CONSUMER, text: `const unrelated = 1\nvoid unrelated\n` },
    ])
    expect(findings.map((finding) => finding.message)).toEqual([
      expect.stringContaining("`Orphan` is exported but"),
    ])
  })

  test("a from re-export a sibling imports is not reported", () => {
    const findings = findingsFor([
      { file: SDK_FILE, text: `export { Kept } from "./elsewhere.js"\n` },
      { file: SDK_CONSUMER, text: `import { Kept } from "./log-paths.js"\nvoid Kept\n` },
    ])
    expect(findings).toEqual([])
  })

  test("a name only a bare block exposes, that nothing imports, is reported", () => {
    const findings = findingsFor([
      { file: SDK_FILE, text: `const orphan = 1\nconst used = 2\nexport { orphan, used }\n` },
      { file: SDK_CONSUMER, text: `import { used } from "./log-paths.js"\nvoid used\n` },
    ])
    expect(findings.map((finding) => finding.message)).toEqual([
      expect.stringContaining("`orphan` is exported but"),
    ])
  })

  test("core's exempt entry points declare nothing as a module", () => {
    const source = `export const tool = 1\n`
    expect(declaredNames(API_FILE, source)).toEqual([])
    expect(declaredNames("packages/core/src/protocol.ts", source)).toEqual([])
  })

  test("test-utils declares its own names: the directory is a surface, not an exemption", () => {
    expect(
      declaredNames("packages/core/src/test-utils/language-model.ts", `export const tool = 1\n`),
    ) //
      .toEqual(["tool"])
  })

  test("a branch-tool name an extension imports through the specifier is live", () => {
    // The row exists to ask this question at all: before it, no surface
    // scanned this entry point and every name here looked consumed.
    expect(
      findingsFor([
        {
          file: BRANCH_TOOLS_FILE,
          text: `export { ToolRunner } from "../runtime/agent/tool-runner.js"\n`,
        },
        {
          file: BRANCH_TOOLS_CONSUMER,
          text: `import { ToolRunner } from "@gent/core/extensions/branch-tools"`,
        },
      ]),
    ).toEqual([])
  })

  test("a branch-tool name only core reaches by relative path is reported", () => {
    const findings = findingsFor([
      {
        file: BRANCH_TOOLS_FILE,
        text: `export { projectModelContext } from "../runtime/model-context.js"\n`,
      },
      {
        file: "packages/core/src/runtime/turn.ts",
        text: `import { projectModelContext } from "../model-context.js"`,
      },
    ])
    expect(findings.map((finding) => finding.line)).toEqual([1])
    expect(findings[0]?.enforced).toBe(true)
    expect(findings[0]?.message).toContain("@gent/core/extensions/branch-tools")
  })

  test("the branch-tool entry point declares its re-exported names, not its module exports", () => {
    // A second scanned entry point: `export { X } from "..."` is the shape it
    // exposes, so a module-style `export const` on it declares nothing.
    expect(declaredNames(BRANCH_TOOLS_FILE, `export const tool = 1\n`)).toEqual([])
    expect(
      declaredNames(
        BRANCH_TOOLS_FILE,
        `export { ToolRunner, type BranchToolWork } from "../x.js"\n`,
      ),
    ).toEqual(["ToolRunner", "BranchToolWork"])
  })
})

describe("the TUI app surface", () => {
  const TUI_FILE = "apps/tui/src/utils.ts"
  const TUI_CONSUMER = "apps/tui/src/app.tsx"

  test("a TUI export another TUI file imports is live", () => {
    expect(
      findingsFor([
        { file: TUI_FILE, text: `export const formatTokens = 1\n` },
        { file: TUI_CONSUMER, text: `import { formatTokens } from "../utils"\n` },
      ]),
    ).toEqual([])
  })

  test("a TUI export nothing reaches is reported and fails the guard", () => {
    const findings = findingsFor([
      { file: TUI_FILE, text: `export const formatTokens = 1\nexport const orphan = 2\n` },
      { file: TUI_CONSUMER, text: `import { formatTokens } from "../utils"\n` },
    ])
    expect(findings.map((finding) => finding.line)).toEqual([2])
    expect(findings[0]?.enforced).toBe(true)
    expect(findings[0]?.message).toContain("`orphan`")
  })

  test("the declaring file reading its own name does not keep it alive", () => {
    // `ownFileCounts: false`: a TUI module that only talks to itself has no
    // reason to export the name at all.
    expect(
      findingsFor([
        { file: TUI_FILE, text: `export const orphan = 1\nconst near = orphan + 1\nvoid near\n` },
      ]).map((finding) => finding.line),
    ).toEqual([1])
  })

  test("a TUI test file keeps a name alive", () => {
    expect(
      findingsFor([
        { file: TUI_FILE, text: `export const orphan = 1\n` },
        {
          file: "apps/tui/tests/utils.test.ts",
          text: `import { orphan } from "../src/utils"\nvoid orphan\n`,
        },
      ]),
    ).toEqual([])
  })
})

describe("the server app surface", () => {
  const SERVER_FILE = "apps/server/src/main.ts"

  test("the launcher exporting nothing is clean", () => {
    expect(findingsFor([{ file: SERVER_FILE, text: `const program = 1\nvoid program\n` }])).toEqual(
      [],
    )
  })

  test("a server export nothing reaches is reported", () => {
    const findings = findingsFor([
      { file: SERVER_FILE, text: `const program = 1\nexport const orphan = program\n` },
    ])
    expect(findings.map((finding) => finding.line)).toEqual([2])
    expect(findings[0]?.message).toContain("`orphan`")
  })

  test("a server test file keeps a name alive", () => {
    expect(
      findingsFor([
        { file: SERVER_FILE, text: `export const orphan = 1\n` },
        {
          file: "apps/server/tests/main.test.ts",
          text: `import { orphan } from "../src/main"\nvoid orphan\n`,
        },
      ]),
    ).toEqual([])
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

describe("extensions module surface", () => {
  test("a schema only the tool beside it reads is reported", () => {
    // `ownFileCounts: false`: the tool is the package's surface, so the param
    // and error types it is built from stay file-local.
    const source = `export const EditParams = Schema.Struct({ path: Schema.String })
export class EditError extends Schema.TaggedError<EditError>()("EditError", {}) {}
export const edit = tool({ params: EditParams, run: () => new EditError({}) })
`
    const findings = findingsFor([
      { file: EXTENSION_FILE, text: source },
      {
        file: "packages/extensions/src/index.ts",
        text: `import { edit } from "./fs-tools/edit"`,
      },
    ])
    expect(findings.map((finding) => finding.line)).toEqual([1, 2])
    expect(findings[0]?.message).toContain("`EditParams`")
    expect(findings[1]?.message).toContain("`EditError`")
  })

  test("a service only its own module yields is reported", () => {
    const source = `export interface WakeAlarmsService { readonly schedule: () => void }
export class WakeAlarms extends Context.Service<WakeAlarms, WakeAlarmsService>()(
  "@gent/extensions/src/wake/WakeAlarms",
) {}
const use = Effect.gen(function* () {
  const alarms = yield* WakeAlarms
  return alarms
})
`
    const findings = findingsFor([{ file: "packages/extensions/src/wake/index.ts", text: source }])
    expect(findings.map((finding) => finding.line)).toEqual([1, 2])
    expect(findings.every((finding) => finding.enforced)).toBe(true)
  })

  test("a service another extension module yields keeps its export", () => {
    expect(
      findingsFor([
        {
          file: "packages/extensions/src/wake/index.ts",
          text: `export class WakeAlarms extends Context.Service<WakeAlarms, never>()(
  "@gent/extensions/src/wake/WakeAlarms",
) {}
`,
        },
        {
          file: "packages/extensions/src/wake/wake-store.ts",
          text: `import { WakeAlarms } from "./index"\nvoid WakeAlarms\n`,
        },
      ]),
    ).toEqual([])
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
          file: "packages/extensions/tests/fs-tools.test.ts",
          text: `import { findMatch } from "../../src/fs-tools/edit"\n`,
        },
      ]),
    ).toEqual([])
  })
})

describe("core test-utils surface", () => {
  const TEST_UTILS_FILE = "packages/core/src/test-utils/language-model.ts"

  test("a helper a core test imports is live", () => {
    expect(
      findingsFor([
        { file: TEST_UTILS_FILE, text: `export const LanguageModelLayers = {}\n` },
        {
          file: "packages/core/tests/runtime/session-runtime.test.ts",
          text: `import { LanguageModelLayers } from "../../src/test-utils/language-model"\n`,
        },
      ]),
    ).toEqual([])
  })

  test("a type its own file reads off the declaration is live", () => {
    const source = `interface SignalControls { readonly emitNext: number }
export const signal = () => {
  const controls: SignalControls = { emitNext: 1 }
  return controls
}
`
    expect(
      findingsFor([
        { file: TEST_UTILS_FILE, text: source },
        {
          file: "packages/core/tests/runtime/session-runtime.test.ts",
          text: `import { signal } from "../../src/test-utils/language-model"\n`,
        },
      ]),
    ).toEqual([])
  })

  test("a constant nothing names, not even its own file, is reported and enforced", () => {
    const findings = findingsFor([
      { file: TEST_UTILS_FILE, text: `export const DebugSlowLanguageModelDelayMs = 250\n` },
    ])
    expect(findings.map((finding) => finding.line)).toEqual([1])
    expect(findings[0]?.enforced).toBe(true)
    expect(findings[0]?.message).toContain("`DebugSlowLanguageModelDelayMs`")
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

  test("an SDK index name only the SDK's own tests import is reported", () => {
    const findings = findingsFor([
      {
        file: "packages/sdk/src/index.ts",
        text: `export { GentObservability } from "./logger.js"\n`,
      },
      {
        file: "packages/sdk/tests/logger.test.ts",
        text: `import { GentObservability } from "@gent/sdk"`,
      },
    ])
    expect(findings.map((finding) => finding.enforced)).toEqual([true])
    expect(findings[0]?.message).toContain('"GentObservability"')
    expect(findings[0]?.message).toContain("@gent/sdk")
  })

  test("a TUI import through @gent/sdk consumes an SDK index name", () => {
    expect(
      findingsFor([
        { file: "packages/sdk/src/index.ts", text: `export { LOG_DIR } from "./log-paths.js"\n` },
        { file: "apps/tui/src/main.tsx", text: `import { LOG_DIR } from "@gent/sdk"` },
      ]),
    ).toEqual([])
  })

  test("an extensions client name only the extensions package imports is reported", () => {
    const findings = findingsFor([
      {
        file: "packages/extensions/src/client.ts",
        text: `export { WakeRpc, WakeEntry } from "./wake/protocol.js"\n`,
      },
      {
        file: "packages/extensions/tests/wake.test.ts",
        text: `import { WakeEntry } from "@gent/extensions/client"`,
      },
      {
        file: "apps/tui/src/extensions/wake.client.tsx",
        text: `import { WakeRpc } from "@gent/extensions/client.js"`,
      },
    ])
    expect(findings.map((finding) => finding.enforced)).toEqual([true])
    expect(findings[0]?.message).toContain('"WakeEntry"')
    expect(findings[0]?.message).toContain("@gent/extensions/client")
  })

  test("a re-export alias is consumed under the alias, not the source name", () => {
    const source = `export { type WakePending as WakePendingType } from "./wake/protocol.js"\n`
    expect(declaredNames("packages/extensions/src/client.ts", source)).toEqual(["WakePendingType"])
    expect(
      findingsFor([
        { file: "packages/extensions/src/client.ts", text: source },
        {
          file: "apps/tui/tests/components/wake-tray.test.tsx",
          text: `import type { WakePendingType } from "@gent/extensions/client"`,
        },
      ]),
    ).toEqual([])
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

describe("chained entry points", () => {
  const PROTOCOL_FILE = "packages/core/src/protocol.ts"
  const SDK_INDEX = "packages/sdk/src/index.ts"

  test("an sdk re-export keeps a protocol name alive", () => {
    // `@gent/sdk` both declares `emptyQueueSnapshot` and gets it from
    // `@gent/core/protocol`. Skipping every file that declares the name would
    // call the whole chained surface dead.
    const findings = findingsFor([
      {
        file: PROTOCOL_FILE,
        text: `export { QueueSnapshot, emptyQueueSnapshot } from "./domain/queue.js"\n`,
      },
      {
        file: SDK_INDEX,
        text: `export { QueueSnapshot, emptyQueueSnapshot } from "@gent/core/protocol"\n`,
      },
    ])
    expect(findings.filter((finding) => finding.file === PROTOCOL_FILE)).toEqual([])
  })

  test("a protocol name no chained entry point re-exports is still reported", () => {
    const findings = findingsFor([
      {
        file: PROTOCOL_FILE,
        text: `export { QueueSnapshot, DriverInfo } from "./domain/queue.js"\n`,
      },
      { file: SDK_INDEX, text: `export { QueueSnapshot } from "@gent/core/protocol"\n` },
    ])
    const reported = findings.filter((finding) => finding.file === PROTOCOL_FILE)
    expect(reported).toHaveLength(1)
    expect(reported[0]?.message).toContain('"DriverInfo"')
  })
})

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

describe("a namesake does not vouch for an export", () => {
  const TUI_FILE = "apps/tui/src/extensions/loader-boundary.ts"
  const TUI_CONSUMER = "apps/tui/src/extensions/host.tsx"

  /** `use` keeps the probe file's own surface alive so only the name under test is measured. */
  const usedElsewhere = {
    file: TUI_CONSUMER,
    text: "import { use } from './loader-boundary'\nuse()\n",
  }
  const coreDeclaration = {
    file: CORE_FILE,
    text: "export const isClientFile = (entry: string) => entry.length > 0\n",
  }

  test("a file that binds the same name locally is not a consumer", () => {
    const findings = findingsFor([
      coreDeclaration,
      {
        file: TUI_FILE,
        text: "const isClientFile = (entry: string) => entry.length > 0\nexport const use = () => isClientFile('a')\n",
      },
      usedElsewhere,
    ])
    expect(findings.map((finding) => finding.message)).toEqual([
      expect.stringContaining("`isClientFile` is exported but no file outside"),
    ])
  })

  test("a file that imports the name is a consumer even with a namesake beside it", () => {
    const findings = findingsFor([
      coreDeclaration,
      {
        file: TUI_FILE,
        text: "import { isClientFile } from '@gent/core/protocol'\nexport const use = () => isClientFile('a')\n",
      },
      usedElsewhere,
    ])
    expect(findings).toEqual([])
  })

  test("an aliased import from the declaring module is a read, with a namesake beside it", () => {
    const stem = CORE_FILE.slice(CORE_FILE.lastIndexOf("/") + 1).replace(/\.ts$/, "")
    const findings = findingsFor([
      coreDeclaration,
      {
        file: TUI_FILE,
        text: `import { isClientFile as coreIsClientFile } from '../${stem}.js'\nconst isClientFile = () => true\nexport const use = () => coreIsClientFile('a') && isClientFile()\n`,
      },
      usedElsewhere,
    ])
    expect(findings).toEqual([])
  })

  test("a namespace import from the declaring module is a read, with a namesake beside it", () => {
    const stem = CORE_FILE.slice(CORE_FILE.lastIndexOf("/") + 1).replace(/\.ts$/, "")
    const findings = findingsFor([
      coreDeclaration,
      {
        file: TUI_FILE,
        text: `import * as Core from '../${stem}.js'\nconst isClientFile = () => true\nexport const use = () => Core.isClientFile('a') && isClientFile()\n`,
      },
      usedElsewhere,
    ])
    expect(findings).toEqual([])
  })

  test("a plain mention with no local binding still vouches", () => {
    const findings = findingsFor([
      coreDeclaration,
      { file: TUI_FILE, text: "export const use = () => isClientFile('a')\n" },
      usedElsewhere,
    ])
    expect(findings).toEqual([])
  })

  test("a local binding in a comment does not discount the mention", () => {
    const findings = findingsFor([
      coreDeclaration,
      {
        file: TUI_FILE,
        text: "// const isClientFile = () => true\nexport const use = () => isClientFile('a')\n",
      },
      usedElsewhere,
    ])
    expect(findings).toEqual([])
  })
})
