import { describe, expect, it, test } from "effect-bun-test"
import { DateTime, Effect, FileSystem, Option, Path, Predicate, Schedule, Schema } from "effect"
import { AgentEvent, BranchId, SessionId } from "@gent/core/protocol"
import { InteractionRequestId } from "@gent/core/extensions/branch-tools"
import {
  type AnyExtensionClientModule,
  autocompleteContribution,
  type AutocompleteContribution,
  type AutocompleteItem,
  clientCommandContribution,
  clientContributions,
  type ClientContributions,
  type ClientRuntime,
  ClientContext,
  type ClientShellTransport,
  type ClientTransport,
  type ExtensionClientModule,
  interactionRendererContribution,
  type MessageRenderer,
  messageRendererContribution,
  type MessageRowProps,
  NoActiveSessionError,
  type NoticeRow,
  noticeRowContribution,
  rendererContribution,
  statusLabelContribution,
  type WidgetComponent,
  widgetContribution,
} from "../../src/extensions/client-facets"
import {
  loadTuiExtensions as _loadTuiExtensions,
  type LoadedTuiExtension,
  type ResolvedTuiExtensions,
  resolveCommands,
  resolveTuiExtensions,
  runAutocompleteContributions,
} from "../../src/extensions/loader-boundary"
import type { ToolRenderer, ToolRendererProps } from "../../src/tool-renderers"
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs" // eslint-disable-line effect/noNodeBuiltinImport -- synchronous filesystem fixture setup is a test boundary.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path" // eslint-disable-line effect/noNodeBuiltinImport -- synchronous path fixture setup is a test boundary.
import { BunServices } from "@effect/platform-bun"
import { BuiltinExtensions } from "@gent/extensions"
import { collectTestContributions } from "@gent/core/test-utils"
import {
  makeClientExtensionRuntime,
  makeClientTestTransport,
  makePaneSlot,
  runClientExtensionSetup,
} from "../extension-test-harness-boundary"
import { defineRequests, ExtensionId, ref, request } from "@gent/core/extensions/api"
import { inRuntime } from "../helpers-boundary"
import { SessionUiState, slashAutocompleteItems, transitionSessionUi } from "../../src/session"
import { builtinClientModules } from "../../src/extensions/builtins"
import type { Command } from "../../src/commands"
import {
  emptyFrecencyStore,
  frecencyLookup,
  type FrecencyStoreValue,
  readFrecencyStore,
  recordPick,
} from "../../src/autocomplete"
import { makeClientRuntime } from "../../src/extensions/host"
import { createMockClient, createMockRuntime } from "../render-harness-boundary"
import * as EffectEntry from "effect"
import * as ProtocolEntry from "@gent/core/protocol"
import * as ClientExtensionEntry from "@gent/tui/extensions"
import * as ExtensionsClientEntry from "@gent/extensions/client"
import * as AuthoringEntry from "@gent/core/extensions/api"
import * as BranchToolsEntry from "@gent/core/extensions/branch-tools"
import * as SolidEntry from "solid-js"
import * as SolidStoreEntry from "solid-js/store"
import * as OpenTuiSolidEntry from "@opentui/solid"

// ── extensions resolve ──────────────────────────────────────────────────────

/** The commands a load resolves to, before the session and the server add theirs. */
const commandsOf = (resolved: ResolvedTuiExtensions) =>
  resolveCommands(resolved.commandSources).commands

const make = (
  id: string,
  scope: "builtin" | "user" | "project",
  contributions: ClientContributions,
): LoadedTuiExtension => ({ id, scope, filePath: `/test/${id}`, contributions })

const renderer =
  (label: string): ToolRenderer =>
  (_props: ToolRendererProps) =>
    label

const widget =
  (label: string): WidgetComponent =>
  () =>
    label
const row =
  (label: string): MessageRenderer =>
  (_props: MessageRowProps) =>
    label
const absent = Option.getOrUndefined(Option.none())
const rowProps: MessageRowProps = { content: "", images: [], interjection: false, details: {} }
const toolProps: ToolRendererProps = {
  toolCall: {
    id: "test-tool-call",
    toolName: "bash",
    status: "completed",
    input: {},
    summary: "",
    output: "",
  },
  expanded: false,
}
const interactionProps = {
  event: AgentEvent.cases.InteractionPresented.make({
    sessionId: SessionId.make("session-test"),
    branchId: BranchId.make("branch-test"),
    requestId: InteractionRequestId.make("request-test"),
    text: "test",
    metadata: absent,
  }),
  resolve: () => {},
}
describe("resolveTuiExtensions", () => {
  test("client contribution constructors enforce slot-specific component contracts", () => {
    const good = widgetContribution({
      id: "typed-widget",
      slot: "below-input",
      component: widget("typed"),
    })

    widgetContribution({
      id: "bad-widget",
      slot: "below-input",
      // @ts-expect-error — widgets receive no props
      component: (_props: { readonly open: boolean }) => "bad",
    })
    expect(good.widgets?.[0]?.id).toBe("typed-widget")
  })

  test("higher scope wins for visible renderer surfaces", () => {
    const resolved = resolveTuiExtensions([
      make("builtin-tools", "builtin", rendererContribution(["bash"], renderer("builtin"))),
      make("user-tools", "user", rendererContribution(["bash"], renderer("user"))),
      make("project-tools", "project", rendererContribution(["bash"], renderer("project"))),
    ])

    const bashRenderer = Option.fromNullishOr(resolved.renderers.get("bash"))
    expect(Option.isSome(bashRenderer)).toBe(true)
    if (Option.isNone(bashRenderer)) return
    expect(bashRenderer.value(toolProps)).toBe("project")
  })

  // Same-scope order is code-unit order, as on the server, so both ends pick
  // the same winner: "@test/Z" sorts before "@test/a" whatever the locale.
  test("a same-scope collision is won by the id first in code-unit order", () => {
    const resolved = resolveTuiExtensions([
      make("@test/a", "user", rendererContribution(["bash"], renderer("lower"))),
      make("@test/Z", "user", rendererContribution(["bash"], renderer("upper"))),
    ])
    const bashRenderer = Option.fromNullishOr(resolved.renderers.get("bash"))
    expect(Option.isSome(bashRenderer)).toBe(true)
    if (Option.isNone(bashRenderer)) return
    expect(bashRenderer.value(toolProps)).toBe("upper")
    expect(resolved.failures.map((failure) => failure.id)).toEqual(["@test/a"])
  })

  test("widgets stay user-ordered by priority after scope resolution", () => {
    const resolved = resolveTuiExtensions([
      make(
        "builtin-low",
        "builtin",
        widgetContribution({
          id: "status",
          slot: "below-messages",
          priority: 30,
          component: widget("builtin"),
        }),
      ),
      make(
        "project-override",
        "project",
        clientContributions(
          widgetContribution({
            id: "status",
            slot: "above-input",
            priority: 10,
            component: widget("project"),
          }),
          widgetContribution({
            id: "secondary",
            slot: "below-messages",
            priority: 20,
            component: widget("secondary"),
          }),
        ),
      ),
    ])

    expect(resolved.widgets.map((entry) => entry.id)).toEqual(["status", "secondary"])
    expect(resolved.widgets[0]?.slot).toBe("above-input")
  })

  test("higher-scope commands keep the visible slash and keybind affordances", () => {
    const resolved = resolveTuiExtensions([
      make(
        "builtin-command",
        "builtin",
        clientCommandContribution({
          id: "cmd-old",
          title: "Old",
          slash: "deploy",
          keybind: "ctrl+k",
          onSelect: () => {},
        }),
      ),
      make(
        "project-command",
        "project",
        clientCommandContribution({
          id: "cmd-new",
          title: "New",
          slash: "deploy",
          keybind: "ctrl+k",
          onSelect: () => {},
        }),
      ),
    ])

    const { commands } = resolveCommands(resolved.commandSources)
    const oldCommand = commands.find((command) => command.id === "cmd-old")
    const newCommand = commands.find((command) => command.id === "cmd-new")

    expect(newCommand?.slash).toBe("deploy")
    expect(newCommand?.keybind).toBe("ctrl+k")
    expect(oldCommand?.slash).toBeUndefined()
    expect(oldCommand?.keybind).toBeUndefined()
  })

  test("interaction renderers resolve by metadata type with scope precedence", () => {
    const resolved = resolveTuiExtensions([
      make(
        "builtin-prompt",
        "builtin",
        interactionRendererContribution(widget("prompt"), "prompt"),
      ),
      make("builtin-ask", "builtin", interactionRendererContribution(widget("ask"), "ask-user")),
      make(
        "project-ask",
        "project",
        interactionRendererContribution(widget("project-ask"), "ask-user"),
      ),
    ])

    const defaultRenderer = Option.fromNullishOr(resolved.interactionRenderers.get("prompt"))
    const askRenderer = Option.fromNullishOr(resolved.interactionRenderers.get("ask-user"))
    expect(Option.isSome(defaultRenderer)).toBe(true)
    expect(Option.isSome(askRenderer)).toBe(true)
    if (Option.isNone(defaultRenderer) || Option.isNone(askRenderer)) return
    expect(defaultRenderer.value(interactionProps)).toBe("prompt")
    expect(askRenderer.value(interactionProps)).toBe("project-ask")
  })

  test("message renderers key by exact custom type; a higher scope replaces, a same-scope claim is dropped", () => {
    const resolved = resolveTuiExtensions([
      make("a-goal", "builtin", messageRendererContribution("goal-context", row("builtin"))),
      make("b-goal", "builtin", messageRendererContribution("goal-context", row("rival"))),
      make("user-goal", "user", messageRendererContribution("goal-context", row("user"))),
      make("user-wake", "user", messageRendererContribution("wake", row("wake"))),
    ])

    const goal = Option.fromNullishOr(resolved.messageRenderers.get("goal-context"))
    expect(Option.map(goal, (entry) => entry.component(rowProps))).toEqual(Option.some("user"))
    expect(resolved.messageRenderers.has("Goal-Context")).toBe(false)
    expect([...resolved.messageRenderers.keys()]).toEqual(["goal-context", "wake"])
    expect(resolved.failures).toEqual([
      {
        id: "b-goal",
        reason:
          'message renderer "goal-context" is already claimed by "/test/a-goal" in scope "builtin"',
      },
    ])
  })

  test("status labels remain collected and priority sorted", () => {
    const resolved = resolveTuiExtensions([
      make(
        "builtin-label",
        "builtin",
        statusLabelContribution({
          priority: 30,
          produce: () => [{ text: "30", color: "info" }],
        }),
      ),
      make(
        "project-labels",
        "project",
        clientContributions(
          statusLabelContribution({
            priority: 20,
            produce: () => [{ text: "20", color: "success" }],
          }),
          statusLabelContribution({
            priority: 10,
            produce: () => [{ text: "10", color: "warning" }],
          }),
        ),
      ),
    ])

    expect(resolved.statusLabels.map((label) => label.priority)).toEqual([10, 20, 30])
  })

  // A user extension reaches the notice bucket as a shipped one does, and
  // replaces a shipped notice by claiming its id.
  test("notice rows key by id; a higher scope replaces, a same-scope claim is dropped", () => {
    const session = { sessionId: SessionId.make("s"), branchId: BranchId.make("b") }
    const rowsSaying = (text: string) => (): Option.Option<ReadonlyArray<NoticeRow>> =>
      Option.some([{ key: "1", createdAt: 0, glyph: "◌", color: "warning", text }])
    const notice = (text: string) =>
      noticeRowContribution({ id: "cache.misses", rows: rowsSaying(text) })
    const resolved = resolveTuiExtensions([
      make("a-cache", "builtin", notice("builtin")),
      make("b-cache", "builtin", notice("rival")),
      make("user-cache", "user", notice("user")),
      make("user-other", "user", noticeRowContribution({ id: "other", rows: rowsSaying("other") })),
    ])

    const firstText = (rows: Option.Option<ReadonlyArray<NoticeRow>>) =>
      Option.getOrElse(rows, () => [])[0]?.text
    expect(
      resolved.noticeRows.map((source) => [source.id, firstText(source.rows(session))]),
    ).toEqual([
      ["cache.misses", "user"],
      ["other", "other"],
    ])
    expect(resolved.failures).toEqual([
      {
        id: "b-cache",
        reason:
          'notice row "cache.misses" is already claimed by "/test/a-cache" in scope "builtin"',
      },
    ])
  })

  test("autocomplete contributions stay scope ordered and additive", () => {
    const resolved = resolveTuiExtensions([
      make(
        "builtin-autocomplete",
        "builtin",
        autocompleteContribution({ prefix: "$", title: "Skills", items: () => [] }),
      ),
      make(
        "user-autocomplete",
        "user",
        autocompleteContribution({ prefix: "/", title: "Commands", items: () => [] }),
      ),
      make(
        "project-autocomplete",
        "project",
        autocompleteContribution({ prefix: "@", title: "Files", items: () => [] }),
      ),
    ])

    expect(resolved.autocompleteItems.map((entry) => entry.prefix)).toEqual(["$", "/", "@"])
  })

  test("a same-scope command collision keeps the first command and records the second", () => {
    const resolved = resolveTuiExtensions([
      make("a", "builtin", clientCommandContribution({ id: "x", title: "A", onSelect: () => {} })),
      make(
        "b",
        "builtin",
        clientCommandContribution({ id: "y", title: "B", slash: "same", onSelect: () => {} }),
      ),
      make(
        "c",
        "builtin",
        clientCommandContribution({ id: "x", title: "C", slash: "other", onSelect: () => {} }),
      ),
      make(
        "d",
        "builtin",
        clientCommandContribution({ id: "z", title: "D", slash: "same", onSelect: () => {} }),
      ),
    ])
    const { commands, failures } = resolveCommands(resolved.commandSources)
    expect(commands.map((command) => command.title)).toEqual(["A", "B"])
    expect(failures.map((failure) => failure.id)).toEqual(["c", "d"])
  })

  test("a command that loses its slash leaves the keybind with its earlier owner", () => {
    const resolved = resolveTuiExtensions([
      make(
        "core",
        "builtin",
        clientCommandContribution({
          id: "new",
          title: "New",
          keybind: "ctrl+n",
          onSelect: () => {},
        }),
      ),
      make(
        "a",
        "user",
        clientCommandContribution({
          id: "a-taken",
          title: "A",
          slash: "taken",
          onSelect: () => {},
        }),
      ),
      make(
        "b",
        "user",
        clientCommandContribution({
          id: "b-both",
          title: "B",
          keybind: "ctrl+n",
          slash: "taken",
          onSelect: () => {},
        }),
      ),
    ])
    const { commands, failures } = resolveCommands(resolved.commandSources)
    const byTitle = new Map(commands.map((command) => [command.title, command]))
    expect(byTitle.get("New")?.keybind).toBe("ctrl+n")
    expect(byTitle.get("A")?.slash).toBe("taken")
    expect(byTitle.has("B")).toBe(false)
    expect(failures.map((failure) => failure.id)).toEqual(["b"])
  })
})

// ── extension effect setup ──────────────────────────────────────────────────

/**
 * Lock: `loadTuiExtensions` runs Effect-typed `setup` values through the
 * provided `runtime: ManagedRuntime`. Only the Effect setup shape is accepted.
 */

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Json))
/** Each specifier a client extension imports, with the module the TUI runs for it. */
const clientEntries = {
  effect: EffectEntry,
  "@gent/core/extensions/api": AuthoringEntry,
  "@gent/core/extensions/branch-tools": BranchToolsEntry,
  "@gent/core/protocol": ProtocolEntry,
  "@gent/tui/extensions": ClientExtensionEntry,
  "@gent/extensions/client": ExtensionsClientEntry,
  "solid-js": SolidEntry,
  "solid-js/store": SolidStoreEntry,
  "@opentui/solid": OpenTuiSolidEntry,
}
/** Where a probe extension leaves the modules it imported, for the test to compare. */
const PROBE_GLOBAL = "__gentClientEntriesProbe"
// gent/no-dynamic-imports: allow the test imports a server-style file as the server loader does
const importFile = (file: string) => Effect.tryPromise(() => import(file))
const runtime = makeClientExtensionRuntime()
describe("loadTuiExtensions Effect setup", () => {
  it.scopedLive("does not import project code until the user grants trust", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "gent-client-trust-",
      })
      const userDir = path.join(root, "home/.gent/extensions")
      const projectDir = path.join(root, "project/.gent/extensions")
      yield* fs.makeDirectory(userDir, { recursive: true })
      yield* fs.makeDirectory(projectDir, { recursive: true })
      const canonicalRoot = yield* fs.realPath(path.join(root, "project"))
      const marker = path.join(root, "import-ran")
      yield* fs.writeFileString(
        path.join(projectDir, "entry.client.ts"),
        `
import { writeFileSync } from "node:fs";
import { Effect } from "effect";
writeFileSync(${encode(marker)}, "ran");
export default { id: "trusted-client", setup: Effect.succeed([]) };
`,
      )
      const grant = encode({ trustedProjects: [canonicalRoot] })
      yield* fs.writeFileString(path.join(projectDir, "../config.json"), grant)
      yield* loadTuiExtensions({ userDir, projectDir, runtime })
      expect(yield* fs.exists(marker)).toBe(false)
      yield* fs.writeFileString(path.join(userDir, "../config.json"), grant)
      yield* loadTuiExtensions({ userDir, projectDir, runtime })
      expect(yield* fs.readFileString(marker)).toBe("ran")
    }).pipe(Effect.provide(BunServices.layer)),
  )

  it.scopedLive("launched from home, a trusted home imports its client files once, as user", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({
          prefix: "gent-client-home-launch-",
        }),
      )
      const userDir = path.join(home, ".gent/extensions")
      yield* fs.makeDirectory(userDir, { recursive: true })
      const imports = path.join(home, "imports")
      yield* fs.writeFileString(
        path.join(userDir, "entry.client.ts"),
        `
import { appendFileSync } from "node:fs";
import { Effect } from "effect";
appendFileSync(${encode(imports)}, "x");
export default { id: "home-client", setup: Effect.succeed({}) };
`,
      )
      yield* fs.writeFileString(
        path.join(userDir, "../config.json"),
        encode({ trustedProjects: [home] }),
      )
      const result = yield* loadTuiExtensions({ userDir, projectDir: userDir, runtime })
      expect(result.failures).toEqual([])
      expect(yield* fs.readFileString(imports)).toBe("x")
    }).pipe(Effect.provide(BunServices.layer)),
  )

  it.scopedLive("a contribution key outside the known buckets fails the extension by name", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "gent-client-unknown-key-",
      })
      const userDir = path.join(root, "home/.gent/extensions")
      const projectDir = path.join(root, "project/.gent/extensions")
      yield* fs.makeDirectory(userDir, { recursive: true })
      // A user extension written against the old vocabulary.
      yield* fs.writeFileString(
        path.join(userDir, "stale.client.ts"),
        `
import { Effect } from "effect";
export default {
  id: "@user/stale-labels",
  setup: Effect.succeed({ borderLabels: [{ position: "top-left", produce: () => [] }] }),
};
`,
      )
      const result = yield* loadTuiExtensions({ userDir, projectDir, runtime })
      expect(result.failures).toEqual([
        { id: "@user/stale-labels", reason: 'unknown contribution "borderLabels"' },
      ])
    }).pipe(Effect.provide(BunServices.layer)),
  )

  // The compiled binary has no node_modules. A client extension outside the
  // repository resolves its imports, and compiles its JSX, only because the
  // loader binds them to the modules the TUI runs. A relative module the
  // client file imports gets the same names. A server file in the same
  // process gets only the shared names.
  it.scopedLive(
    "a JSX client extension outside the repository imports the public entries and Solid; a server file does not",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        // The system temp directory: no node_modules above it.
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "gent-client-entries-" })
        const userDir = path.join(root, "home/.gent/extensions")
        const projectDir = path.join(root, "project/.gent/extensions")
        yield* fs.makeDirectory(path.join(userDir, "_lib"), { recursive: true })
        // A package the user installed beside the extension; the Solid
        // transform skips node_modules, the client build still renames it.
        const packageDir = path.join(userDir, "node_modules", "probe-lib")
        yield* fs.makeDirectory(packageDir, { recursive: true })
        yield* fs.writeFileString(
          path.join(packageDir, "package.json"),
          encode({ name: "probe-lib", type: "module", main: "index.js" }),
        )
        yield* fs.writeFileString(
          path.join(packageDir, "index.js"),
          `export { createSignal as packageCreateSignal } from "solid-js"\n`,
        )
        yield* fs.writeFileString(
          path.join(userDir, "_lib", "ids.ts"),
          `export { SessionId as helperSessionId } from "@gent/core/protocol"\n`,
        )
        yield* fs.writeFileString(
          path.join(userDir, "_lib", "label.tsx"),
          `
import { createSignal } from "solid-js"

export const Label = (props: { readonly text: string }) => {
  const [text] = createSignal(props.text)
  return <text>{text()}</text>
}
`,
        )
        yield* fs.writeFileString(
          path.join(userDir, "entries.client.tsx"),
          `
import * as effect from "effect"
import * as api from "@gent/core/extensions/api"
import * as branchTools from "@gent/core/extensions/branch-tools"
import * as protocol from "@gent/core/protocol"
import * as tui from "@gent/tui/extensions"
import * as shipped from "@gent/extensions/client"
import * as solid from "solid-js"
import * as solidStore from "solid-js/store"
import * as openTuiSolid from "@opentui/solid"
import { helperSessionId } from "./_lib/ids"
import { packageCreateSignal } from "probe-lib"
import { Label } from "./_lib/label"

const bound = {
  effect,
  "@gent/core/extensions/api": api,
  "@gent/core/extensions/branch-tools": branchTools,
  "@gent/core/protocol": protocol,
  "@gent/tui/extensions": tui,
  "@gent/extensions/client": shipped,
  "solid-js": solid,
  "solid-js/store": solidStore,
  "@opentui/solid": openTuiSolid,
}

const Probe = () => <Label text="entries probe" />

export default tui.defineClientExtension("@user/client-entries", {
  setup: effect.Effect.sync(() => {
    Reflect.set(globalThis, ${encode(PROBE_GLOBAL)}, { bound, helperSessionId, packageCreateSignal })
    return tui.clientContributions(
      tui.widgetContribution({ id: "entries-probe", slot: "below-input", component: Probe }),
      tui.clientCommandContribution({ id: "entries-probe", title: "Entries probe", onSelect: () => {} }),
    )
  }),
})
`,
        )
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => Reflect.deleteProperty(globalThis, PROBE_GLOBAL)),
        )
        const result = yield* loadTuiExtensions({ userDir, projectDir, runtime })
        expect(result.failures).toEqual([])
        expect(result.widgets.map((entry) => entry.id)).toContain("entries-probe")
        expect(
          result.commandSources.flatMap((source) => source.commands.map((command) => command.id)),
        ).toContain("entries-probe")

        const probe: object = Reflect.get(globalThis, PROBE_GLOBAL)
        expect(Reflect.get(probe, "helperSessionId")).toBe(ProtocolEntry.SessionId)
        expect(Reflect.get(probe, "packageCreateSignal")).toBe(SolidEntry.createSignal)
        const bound: object = Reflect.get(probe, "bound")
        for (const [specifier, entryModule] of Object.entries(clientEntries)) {
          const imported: object = Reflect.get(bound, specifier)
          for (const [name, value] of Object.entries(entryModule)) {
            const same = Reflect.get(imported, name) === value
            expect({ specifier, name, same }).toEqual({
              specifier,
              name,
              same: true,
            })
          }
        }

        // A server extension file, imported in this process after the client load.
        const serverDir = path.join(root, "server")
        yield* fs.makeDirectory(serverDir, { recursive: true })
        const serverImport = (file: string, specifier: string) =>
          fs
            .writeFileString(
              path.join(serverDir, file),
              `import * as entry from "${specifier}"\nexport const keys = Object.keys(entry)\n`,
            )
            .pipe(
              Effect.andThen(importFile(path.join(serverDir, file))),
              Effect.map(() => "resolved"),
              Effect.catch((error) => Effect.succeed(String(error.cause))),
            )
        expect(yield* serverImport("api.ts", "@gent/core/extensions/api")).toBe("resolved")
        expect(yield* serverImport("effect.ts", "effect")).toBe("resolved")
        expect(yield* serverImport("protocol.ts", "@gent/core/protocol")).toContain(
          "Cannot find package '@gent/core'",
        )
        expect(yield* serverImport("tui.ts", "@gent/tui/extensions")).toContain(
          "Cannot find package '@gent/tui'",
        )
        expect(yield* serverImport("solid.ts", "solid-js")).toContain(
          "Cannot find package 'solid-js'",
        )
        expect(yield* serverImport("shipped.ts", "@gent/extensions/client")).toContain(
          "Cannot find package '@gent/extensions'",
        )
      }).pipe(Effect.timeout("20 seconds"), Effect.provide(BunServices.layer)),
  )

  // A shipped client extension is never more privileged than a user one: every
  // gent entry a shipped client file imports is one the loader binds for a
  // user file, and the probe above proves each binding.
  it.scopedLive(
    "every gent entry a shipped client extension imports is bound for a user file",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dir = path.resolve(import.meta.dir, "../../src/extensions")
        const files = (yield* fs.readDirectory(dir)).filter(
          (file) => /\.client\.tsx?$/.test(file) || /^builtins\.tsx?$/.test(file),
        )
        expect(files.length).toBeGreaterThan(5)
        const imported = new Set<string>()
        for (const file of files) {
          const text = yield* fs.readFileString(path.join(dir, file))
          for (const match of text.matchAll(/from\s+"(@gent\/[^"]+)"/g)) {
            Option.map(Option.fromNullishOr(match[1]), (specifier) => imported.add(specifier))
          }
        }
        expect(imported.has("@gent/extensions/client")).toBe(true)
        const unbound = [...imported].filter(
          (specifier) => !Object.hasOwn(clientEntries, specifier),
        )
        expect(unbound).toEqual([])
      }).pipe(Effect.provide(BunServices.layer)),
  )

  it.live("Effect setup is run through the runtime; FileSystem is provided", () =>
    Effect.gen(function* () {
      const fxSetup: Effect.Effect<ClientContributions, never, FileSystem.FileSystem | Path.Path> =
        Effect.gen(function* () {
          // Prove we can reach a FileSystem from the runtime.
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          // Touch both services so unused imports don't get optimized away.
          expect(Predicate.isFunction(fs.readFileString)).toBe(true)
          expect(Predicate.isFunction(path.join)).toBe(true)
          return autocompleteContribution({
            prefix: "!",
            title: "effect",
            items: () => [{ id: "y", label: "y" }],
          })
        })
      const ext: ExtensionClientModule = { id: "@test/effect", setup: fxSetup }
      const result = yield* loadTuiExtensions({
        builtins: [ext],
        userDir: "/tmp/u-c9-1-fx",
        projectDir: "/tmp/p-c9-1-fx",
        runtime,
      })
      expect(result.autocompleteItems.map((c) => c.prefix)).toContain("!")
    }),
  )
  it.live("isolates enabled setup failures and keeps healthy contributions", () =>
    Effect.gen(function* () {
      const good: ExtensionClientModule = {
        id: "@test/good",
        setup: Effect.succeed(
          autocompleteContribution({
            prefix: "!",
            title: "good",
            items: () => [{ id: "good", label: "good" }],
          }),
        ),
      }
      const broken: ExtensionClientModule = {
        id: "@test/broken",
        setup: Effect.die("setup failed"),
      }
      const result = yield* loadTuiExtensions({
        builtins: [good, broken],
        userDir: "/tmp/u-c9-1-fx-failure",
        projectDir: "/tmp/p-c9-1-fx-failure",
        runtime,
      })
      expect(result.autocompleteItems.map((c) => c.prefix)).toContain("!")
      expect(result.failures.map((failure) => failure.id)).toEqual(["@test/broken"])
    }),
  )
  it.live("a setup that never ends becomes a failure and the others still load", () =>
    Effect.gen(function* () {
      const good: ExtensionClientModule = {
        id: "@test/good-beside-hung",
        setup: Effect.succeed(
          autocompleteContribution({
            prefix: "!",
            title: "good",
            items: () => [{ id: "good", label: "good" }],
          }),
        ),
      }
      const hung: ExtensionClientModule = { id: "@test/hung", setup: Effect.never }
      const result = yield* loadTuiExtensions({
        builtins: [good, hung],
        userDir: "/tmp/u-hung-setup",
        projectDir: "/tmp/p-hung-setup",
        loadTimeout: "50 millis",
        runtime,
      })
      expect(result.autocompleteItems.map((c) => c.prefix)).toContain("!")
      expect(result.failures.map((failure) => failure.id)).toEqual(["@test/hung"])
      expect(result.failures[0]?.reason).toContain("setup timed out")
    }).pipe(Effect.timeout("5 seconds")),
  )
  // Regression lock — discovered (not pre-imported) modules with an
  // Effect-valued `setup` must pass `importExtension`'s shape validator.
  // Rejecting Effect values silently drops the entire discovered population.
  describe("discovered Effect-setup modules", () => {
    it.scopedLive("imports + runs an Effect-valued setup discovered from userDir", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "gent-client-discovery-" })
        const userDir = path.join(root, "user")
        const projectDir = path.join(root, "project")
        yield* fs.makeDirectory(userDir, { recursive: true })
        yield* fs.makeDirectory(projectDir, { recursive: true })
        // Effect-valued `setup` — exactly the accepted shape.
        yield* fs.writeFileString(
          path.join(userDir, "discovered.client.ts"),
          `
import { Effect } from "effect"
import { autocompleteContribution } from "@gent/tui/extensions"

export default {
  id: "@test/discovered-effect",
  setup: Effect.gen(function* () {
    return autocompleteContribution({
        prefix: "#",
        title: "discovered",
        items: () => [{ id: "z", label: "z" }],
      })
  }),
}
`.trim(),
        )
        const result = yield* loadTuiExtensions({ userDir, projectDir, runtime })
        expect(result.autocompleteItems.map((c) => c.prefix)).toContain("#")
      }).pipe(Effect.provide(BunServices.layer)),
    )
  })
})

// ── autocomplete effect items ───────────────────────────────────────────────

/**
 *  lock: autocomplete `items()` returning an Effect that yields
 * `ClientContext` flows through a `ManagedRuntime` providing the context
 * layer, mirroring how `autocomplete-popup-boundary.ts` dispatches
 * Effect-typed results to the resource.
 *
 * This proves the contribution-time adapter path:
 * Effect items() → runtime.runPromise → typed transport → decoded reply.
 * Success returns the items; a missing session yields a typed
 * `NoActiveSessionError` that the helper reports and turns into no rows.
 */

class AutocompleteTestError extends Schema.TaggedError<AutocompleteTestError>()(
  "AutocompleteTestError",
  { message: Schema.String },
) {}
const { ListThingsRpc } = defineRequests(ExtensionId.make("@test/autocomplete"), {
  ListThingsRpc: request({
    id: "list-things",
    input: Schema.Struct({}),
    output: Schema.Array(Schema.String),
    execute: () => Effect.succeed([]),
  }),
})
type FakeSession = Option.Option<{ sessionId: SessionId; branchId: BranchId }>
const makeFakeTransport = (
  opts: {
    readonly currentSession?: () => FakeSession
    readonly requestReply?: unknown
    readonly requestEffect?: () => Effect.Effect<unknown, Error>
  } = {},
): ClientShellTransport =>
  makeClientTestTransport({
    currentSession:
      opts.currentSession ??
      (() =>
        Option.some({
          sessionId: SessionId.make("sess-1"),
          branchId: BranchId.make("branch-1"),
        })),
    requestEffect: opts.requestEffect,
    requestReply: opts.requestReply ?? [],
  })
const makeTestRuntime = (transport: ClientShellTransport) =>
  makeClientExtensionRuntime({ transport })
/** The extension-side call: yield the transport, request against the active session. */
const listThings = Effect.gen(function* () {
  const { transport } = yield* ClientContext
  return yield* transport.request(ref(ListThingsRpc), {})
})
describe("autocomplete Effect items() through the client transport", () => {
  it.live("Effect items yielding ClientContext resolves via runtime.runPromise", () =>
    Effect.gen(function* () {
      const transport = makeFakeTransport()
      const runtime = makeTestRuntime(transport)
      const contribution: AutocompleteContribution = {
        prefix: "$",
        title: "Test",
        items: (filter: string) =>
          Effect.gen(function* () {
            const { transport: t } = yield* ClientContext
            // Touch the transport so the test proves the service resolved.
            expect(Option.isSome(t.currentSession())).toBe(true)
            return [
              { id: filter, label: `got:${filter}` },
            ] satisfies ReadonlyArray<AutocompleteItem>
          }),
      }
      const failures: Array<string> = []
      const result = yield* Effect.promise(() =>
        runAutocompleteContributions([contribution], "hello", runtime, (prefix, reason) => {
          failures.push(`${prefix}: ${reason}`)
        }),
      )
      expect(failures).toEqual([])
      expect(result).toEqual([{ id: "hello", label: "got:hello" }])
      yield* Effect.promise(() => runtime.dispose())
    }),
  )
  it.live("transport.request fails with NoActiveSessionError when no session active", () =>
    Effect.gen(function* () {
      const transport = makeFakeTransport({ currentSession: () => Option.none() })
      const runtime = makeTestRuntime(transport)
      const exit = yield* Effect.exit(inRuntime(runtime, listThings))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        // The cause should carry the typed NoActiveSessionError.
        const causeStr = String(exit.cause)
        expect(causeStr).toContain("NoActiveSessionError")
      }
      yield* Effect.promise(() => runtime.dispose())
    }),
  )
  it.live("a contribution whose transport call fails is reported and contributes no rows", () =>
    Effect.gen(function* () {
      // One broken contribution must not empty the popup for the rest, so the
      // helper names it to the caller's log and returns its rows as none.
      const transport = makeFakeTransport({ currentSession: () => Option.none() })
      const runtime = makeTestRuntime(transport)
      const contribution: AutocompleteContribution = {
        prefix: "$",
        title: "Test",
        items: (_filter: string) =>
          Effect.gen(function* () {
            const reply = yield* listThings
            return reply.map((label) => ({ id: label, label }))
          }),
      }
      const failures: Array<string> = []
      const result = yield* Effect.promise(() =>
        runAutocompleteContributions([contribution], "filter", runtime, (prefix, reason) => {
          failures.push(`${prefix}:${reason}`)
        }),
      )
      expect(result).toEqual([])
      expect(failures.length).toBe(1)
      expect(failures[0]).toContain("NoActiveSessionError")
      yield* Effect.promise(() => runtime.dispose())
    }),
  )
  it.live("transport.request dispatches extension.request through the transport runtime", () =>
    Effect.gen(function* () {
      const transport = makeFakeTransport({ requestReply: ["effect-v4", "react"] })
      const runtime = makeTestRuntime(transport)
      const result = yield* inRuntime(runtime, listThings)
      expect(result).toEqual(["effect-v4", "react"])
      yield* Effect.promise(() => runtime.dispose())
    }),
  )
  test("NoActiveSessionError is a Schema.TaggedError instance", () => {
    const err = new NoActiveSessionError()
    expect(err._tag).toBe("NoActiveSessionError")
  })
  it.live("transport.request seals transport failures to ClientTransportRequestError", () =>
    Effect.gen(function* () {
      const transport = makeFakeTransport({
        requestEffect: () => Effect.fail(new AutocompleteTestError({ message: "transport boom" })),
      })
      const runtime = makeTestRuntime(transport)
      const exit = yield* Effect.exit(inRuntime(runtime, listThings))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const causeStr = String(exit.cause)
        expect(causeStr).toContain("ClientTransportRequestError")
        expect(causeStr).toContain("transport boom")
      }
      yield* Effect.promise(() => runtime.dispose())
    }),
  )
  it.live("transport.request seals decode failures to ClientTransportReplyDecodeError", () =>
    Effect.gen(function* () {
      const transport = makeFakeTransport({ requestReply: { nope: true } })
      const runtime = makeTestRuntime(transport)
      const exit = yield* Effect.exit(inRuntime(runtime, listThings))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const causeStr = String(exit.cause)
        expect(causeStr).toContain("ClientTransportReplyDecodeError")
      }
      yield* Effect.promise(() => runtime.dispose())
    }),
  )
  it.live("the context's transport facet carries no shell authority", () =>
    Effect.gen(function* () {
      const transport = makeFakeTransport()
      const runtime = makeTestRuntime(transport)
      const resolved: ClientTransport = yield* inRuntime(
        runtime,
        ClientContext.use((context) => Effect.succeed(context.transport)),
      )
      expect(resolved.currentSession()).toEqual(
        Option.some({ sessionId: SessionId.make("sess-1"), branchId: BranchId.make("branch-1") }),
      )
      expect("run" in resolved).toBe(false)
      expect("cast" in resolved).toBe(false)
      yield* Effect.promise(() => runtime.dispose())
    }),
  )
})

// ── autocomplete contribution order ─────────────────────────────────────────

/**
 * Ranking at the seams that actually ship.
 *
 * The scorer has its own tests, but a scorer nobody calls ranks nothing. These
 * exercise the two contributions a reader's keystrokes really reach: the `/`
 * items the session registry builds, and the `$` items the skills extension
 * returns over the transport. Disconnecting either from the ranking has to
 * fail here, which is the whole reason these are separate from the unit tests
 * — those call the scorer directly and so cannot notice a caller that stopped
 * calling it.
 *
 * `@` files have their own tests in `builtins.test.ts`.
 */

/**
 * The registration order that produced the bug: `/fork` and `/auth` carry "ag"
 * in their titles and register before `/agents` carries it in its name.
 */
const commands: ReadonlyArray<Command> = [
  { id: "message.fork", title: "Fork from Message", slash: "fork", onSelect: () => {} },
  { id: "auth.manage", title: "Manage API Keys", slash: "auth", onSelect: () => {} },
  { id: "agents.view", title: "Agents", slash: "agents", aliases: ["tree"], onSelect: () => {} },
  { id: "session.model", title: "Set Model", slash: "model", onSelect: () => {} },
  { id: "session.think", title: "Set Reasoning", slash: "think", onSelect: () => {} },
]

const ids = (items: ReadonlyArray<{ readonly id: string }>): ReadonlyArray<string> =>
  items.map((item) => item.id)

describe("slash autocomplete contribution", () => {
  test("puts the command named by the filter first", () => {
    // Before ranking this answered `fork, auth, agents` in registration order,
    // so the preselected row — the one Tab completes and Enter runs — was the
    // wrong command.
    expect(ids(slashAutocompleteItems(commands, "ag"))[0]).toBe("agents")
  })

  test("drops commands that match only through their title", () => {
    const ranked = ids(slashAutocompleteItems(commands, "ag"))
    expect(ranked).not.toContain("fork")
    expect(ranked).not.toContain("auth")
  })

  test("still offers aliases", () => {
    expect(ids(slashAutocompleteItems(commands, "tre"))).toContain("tree")
  })

  test("ranks a partially typed name onto its command", () => {
    expect(ids(slashAutocompleteItems(commands, "mod"))[0]).toBe("model")
    expect(ids(slashAutocompleteItems(commands, "thi"))[0]).toBe("think")
  })

  test("offers every command when nothing is typed yet", () => {
    // One row per slash name plus the alias.
    expect(ids(slashAutocompleteItems(commands, ""))).toEqual([
      "fork",
      "auth",
      "agents",
      "tree",
      "model",
      "think",
    ])
  })

  test("offers nothing for a filter no command matches", () => {
    expect(slashAutocompleteItems(commands, "zzzz")).toEqual([])
  })
})

/** The shipped `$` contribution, found by id among the builtin modules. */
const skillsModule = (): Effect.Effect<AnyExtensionClientModule> =>
  Option.match(
    Option.fromNullishOr(builtinClientModules.find((module) => module.id === "@gent/skills-ui")),
    {
      onNone: () => Effect.die("@gent/skills-ui is not registered"),
      onSome: (module) => Effect.succeed(module),
    },
  )

/**
 * Runs the real skills contribution against a transport returning `names`.
 *
 * The transport needs an active session: the contribution asks it for one
 * before issuing the request, and without it the call fails as
 * `NoActiveSessionError` long before any ranking happens.
 */
const skillItemsFor = (
  names: ReadonlyArray<string>,
  filter: string,
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.gen(function* () {
    const runtime = makeClientExtensionRuntime({
      currentSession: () =>
        Option.some({ sessionId: SessionId.make("sess-1"), branchId: BranchId.make("branch-1") }),
      requestReply: names.map((name) => ({
        name,
        description: `The ${name} skill`,
        level: "global",
        content: "",
        filePath: `/tmp/${name}.md`,
      })),
    })
    const contributions = yield* runClientExtensionSetup(runtime, yield* skillsModule())
    const contribution = yield* Option.match(
      Option.fromNullishOr(contributions.autocomplete?.[0]),
      {
        onNone: () => Effect.die("skills extension contributed no autocomplete"),
        onSome: (entry) => Effect.succeed(entry satisfies AutocompleteContribution),
      },
    )
    const failures: Array<string> = []
    const items = yield* Effect.promise(() =>
      runAutocompleteContributions([contribution], filter, runtime, (prefix, reason) => {
        failures.push(`${prefix}: ${reason}`)
      }),
    )
    yield* Effect.promise(() => runtime.dispose())
    // A failing contribution answers with no rows, which would read as a
    // ranking result rather than the breakage it is.
    if (failures.length > 0) return yield* Effect.die(failures.join("; "))
    return ids(items)
  })

describe("skills autocomplete contribution", () => {
  it.live("puts the closest skill name first rather than the first listed", () =>
    Effect.gen(function* () {
      // Plain substring filtering answered in host order, so `$tes` led with
      // whichever skill happened to be listed first. `test` is the closest.
      const names = ["code-style", "stacked", "test", "tdd", "teach"]
      expect((yield* skillItemsFor(names, "tes"))[0]).toBe("test")
    }),
  )

  it.live("ranks a prefix above a mid-word match", () =>
    Effect.gen(function* () {
      const names = ["impeccable", "effect", "code-review"]
      expect((yield* skillItemsFor(names, "eff"))[0]).toBe("effect")
    }),
  )

  it.live("finds a skill by letters scattered through its name", () =>
    Effect.gen(function* () {
      const names = ["code-review", "counsel", "test"]
      expect(yield* skillItemsFor(names, "crv")).toContain("code-review")
    }),
  )

  it.live("offers nothing when no skill matches", () =>
    Effect.gen(function* () {
      expect(yield* skillItemsFor(["effect", "test"], "zzzz")).toEqual([])
    }),
  )

  it.live("offers every skill before anything is typed", () =>
    Effect.gen(function* () {
      expect(yield* skillItemsFor(["effect", "test"], "")).toEqual(["effect", "test"])
    }),
  )
})

// ── autocomplete frecency seam ──────────────────────────────────────────────

/**
 * Frecency at the seams that actually ship.
 *
 * The scoring has its own tests, but a score nobody records and nobody reads
 * changes no popup. A previous pass on this code shipped probes that proved
 * nothing for exactly that reason: they called the ranker directly, so a
 * caller that stopped calling it would not have failed a single one. These go
 * the other way round — they drive the real contributions and assert on the
 * order a reader would see, so disconnecting either half fails here.
 *
 * Two halves have to hold. The write half: selecting a row has to leave
 * something on disk. The read half: what is on disk has to change the order
 * the next popup returns.
 *
 * `@` files have their own tests in `builtins.test.ts`.
 */

const NOW = 1_800_000_000_000

/** `/think` and `/thread` tie on everything the matcher can see but length. */
const commandsSeam: ReadonlyArray<Command> = [
  { id: "session.think", title: "Set Reasoning", slash: "think", onSelect: () => {} },
  { id: "session.thread", title: "Thread over sessions", slash: "thread", onSelect: () => {} },
]

describe("slash autocomplete reads pick history", () => {
  test("answers /t with think for a reader who has picked nothing", () => {
    expect(ids(slashAutocompleteItems(commandsSeam, "t"))[0]).toBe("think")
  })

  test("answers /thr with thread once the reader has picked it", () => {
    // The seam: the contribution has to pass the history through to the
    // ranker. A build that drops the third argument still answers `think`.
    //
    // Three characters, not one: ranking ignores pick history below
    // FRECENCY_MIN_FILTER, so a one-character filter would pass this test for
    // the wrong reason — it would answer `think` whether or not the history
    // reached the ranker at all.
    const store = recordPick(emptyFrecencyStore(), "/", "thread", NOW)
    expect(ids(slashAutocompleteItems(commandsSeam, "thr", frecencyLookup(store, NOW)))[0]).toBe(
      "thread",
    )
  })

  test("keeps a picked command out of a filter it does not match", () => {
    const store = recordPick(emptyFrecencyStore(), "/", "thread", NOW)
    expect(ids(slashAutocompleteItems(commandsSeam, "think", frecencyLookup(store, NOW)))[0]).toBe(
      "think",
    )
  })
})

/** The shipped `$` contribution, found by id among the builtin modules. */

/**
 * Drives the real skills contribution against a temp home, returning both the
 * ranked ids and the contribution itself so a test can also select a row.
 */
const skillsHarness = (home: string, names: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const runtime = makeClientExtensionRuntime({
      // The extension writes its store under `home`, so the harness has to
      // point at this test's temp directory. Left at the harness default,
      // every run would share one file in /tmp and the assertion below would
      // pass on a previous run's pick.
      workspace: { cwd: home, home },
      currentSession: () =>
        Option.some({ sessionId: SessionId.make("sess-1"), branchId: BranchId.make("branch-1") }),
      requestReply: names.map((name) => ({
        name,
        description: `The ${name} skill`,
        level: "global",
        content: "",
        filePath: `/tmp/${name}.md`,
      })),
    })
    const contributions = yield* runClientExtensionSetup(runtime, yield* skillsModule())
    const contribution = yield* Option.match(
      Option.fromNullishOr(contributions.autocomplete?.[0]),
      {
        onNone: () => Effect.die("skills extension contributed no autocomplete"),
        onSome: (entry) => Effect.succeed(entry satisfies AutocompleteContribution),
      },
    )
    const rank = (filter: string) =>
      Effect.gen(function* () {
        const failures: Array<string> = []
        const items = yield* Effect.promise(() =>
          runAutocompleteContributions([contribution], filter, runtime, (prefix, reason) => {
            failures.push(`${prefix}: ${reason}`)
          }),
        )
        // A failing contribution answers with no rows, which would read as a
        // ranking result rather than the breakage it is.
        if (failures.length > 0) return yield* Effect.die(failures.join("; "))
        return ids(items)
      })
    return { contribution, rank, dispose: () => Effect.promise(() => runtime.dispose()) }
  })

const seamTest = it.scopedLive.layer(BunServices.layer)

describe("skills autocomplete records and reads pick history", () => {
  seamTest("answers $t with tdd before the reader picks anything", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()
      const harness = yield* skillsHarness(home, ["tdd", "test"])
      // The documented weakness: 12.760 against 12.680, decided by length.
      expect((yield* harness.rank("t"))[0]).toBe("tdd")
      yield* harness.dispose()
    }),
  )

  seamTest("writes a pick to the store when a row is selected", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()
      const harness = yield* skillsHarness(home, ["tdd", "test"])

      // The write half. A contribution with no onSelect leaves nothing here.
      const onSelect = Option.fromNullishOr(harness.contribution.onSelect)
      expect(Option.isSome(onSelect)).toBe(true)
      if (Option.isSome(onSelect)) onSelect.value("test", "t")

      // The write is forked off the keystroke path — that is the requirement —
      // so it lands shortly after the callback returns rather than during it.
      // Retry rather than sleep: the assertion is "the pick arrives", and a
      // fixed delay would either flake or slow the suite to cover the worst
      // case.
      const weightOf = (loaded: Option.Option<FrecencyStoreValue>): number =>
        frecencyLookup(
          Option.getOrElse(loaded, () => emptyFrecencyStore()),
          DateTime.toEpochMillis(DateTime.nowUnsafe()),
        )("$", "test")

      const recorded = yield* Effect.retry(
        Effect.flatMap(readFrecencyStore(home), (loaded) => {
          const weight = weightOf(loaded)
          if (weight > 0) return Effect.succeed(weight)
          return Effect.fail("not written yet")
        }),
        { times: 50, schedule: Schedule.spaced("10 millis") },
      )
      expect(recorded).toBeGreaterThan(0)
      yield* harness.dispose()
    }),
  )
})

// ── extension integration ───────────────────────────────────────────────────

/**
 * TUI extension integration contracts.
 *
 * Keep one end-to-end story per user-visible outcome:
 * discovery, override precedence, disabled gating, invalid-file tolerance,
 * overlay state, autocomplete visibility, and startup with an active session.
 */
const throwOnAccess = (label: string): never =>
  Effect.runSync(Effect.die(`unexpected transport call in pure load test: ${label}`))
const stubClient = new Proxy(createMockClient(), {
  get: (_target, prop) =>
    new Proxy(
      {},
      {
        get: (_target2, method) => () => throwOnAccess(`client.${String(prop)}.${String(method)}`),
      },
    ),
})
const stubRuntime = new Proxy(createMockRuntime(), {
  get: (_target, method) => () => throwOnAccess(`runtime.${String(method)}`),
})

const castTestShellEffect = <A, E>(effect: Effect.Effect<A, E, never>): void => {
  Effect.runFork(effect)
}

const testRuntime = makeClientRuntime(BunServices.layer, {
  transport: {
    client: stubClient,
    runtime: stubRuntime,
    currentSession: () => Option.none(),
    onExtensionStateChanged: () => () => {},
    onSessionEvent: () => () => {},
    modelCatalog: () => Option.none(),
  },
  workspace: { cwd: "/tmp/test-cwd", home: "/nonexistent/test-home" },
  shell: { cast: castTestShellEffect, pane: makePaneSlot() },
})
/** Run the loader on a client runtime, the stub one unless the test gives its own. */
const loadTuiExtensions = (
  opts: Parameters<typeof _loadTuiExtensions>[0] & { readonly runtime?: ClientRuntime },
): Effect.Effect<ResolvedTuiExtensions> =>
  inRuntime(opts.runtime ?? testRuntime, _loadTuiExtensions(opts))
const encodeTrustGrant = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ trustedProjects: Schema.Array(Schema.String) })),
)
// A scoped system temp directory: the loader binds `effect` and the public
// entries, so the files resolve them with no node_modules above.
const integrationFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const fixtureDir = yield* fs.makeTempDirectoryScoped({ prefix: "gent-client-integration-" })
  const fixtureUserDir = join(fixtureDir, "user")
  const fixtureProjectDir = join(fixtureDir, "project")
  yield* Effect.sync(() => {
    mkdirSync(fixtureUserDir, { recursive: true })
    mkdirSync(fixtureProjectDir, { recursive: true })
    writeFileSync(
      join(fixtureDir, "config.json"),
      encodeTrustGrant({ trustedProjects: [realpathSync(join(fixtureProjectDir, "../.."))] }),
    )
    mkdirSync(join(fixtureUserDir, "custom-read"), { recursive: true })
    writeFileSync(
      join(fixtureUserDir, "custom-read", "index.ts"),
      `export default { manifest: { id: "custom-read" }, setup: () => [] }`,
    )
    writeFileSync(
      join(fixtureUserDir, "custom-read", "client.ts"),
      `import { Effect } from "effect"
import {
  defineClientExtension,
  clientContributions,
  clientCommandContribution,
  rendererContribution,
  widgetContribution,
} from "@gent/tui/extensions"

export default defineClientExtension("@test/custom-read", {
  setup: Effect.succeed(clientContributions(
    rendererContribution(["my_custom_tool"], () => "custom-tool-renderer"),
    widgetContribution({ id: "test-widget", slot: "below-messages", priority: 50, component: () => "test-widget" }),
    clientCommandContribution({ id: "test-cmd", title: "Test Command", category: "test", onSelect: () => {} }),
  )),
})`,
    )
    writeFileSync(
      join(fixtureProjectDir, "override-bash.client.ts"),
      `import { Effect } from "effect"
import { defineClientExtension, rendererContribution } from "@gent/tui/extensions"

export default defineClientExtension("@test/override-bash", {
  setup: Effect.succeed(
    rendererContribution(["bash"], () => "project-bash-override"),
  ),
})`,
    )
    writeFileSync(
      join(fixtureUserDir, "alpha.client.ts"),
      "import { Effect } from 'effect'; import { defineClientExtension, clientCommandContribution } from '@gent/tui/extensions'; export default defineClientExtension('@test/alpha', { setup: Effect.succeed(clientCommandContribution({ id: 'alpha', title: 'Alpha', onSelect: () => {} })) })",
    )
    writeFileSync(
      join(fixtureUserDir, "zeta.client.ts"),
      "import { Effect } from 'effect'; import { defineClientExtension, clientCommandContribution } from '@gent/tui/extensions'; export default defineClientExtension('@test/zeta', { setup: Effect.succeed(clientCommandContribution({ id: 'zeta', title: 'Zeta', onSelect: () => {} })) })",
    )
    writeFileSync(
      join(fixtureUserDir, ".hidden.client.tsx"),
      "import { Effect } from 'effect'; import { defineClientExtension, clientCommandContribution } from '@gent/tui/extensions'; export default defineClientExtension('@test/hidden', { setup: Effect.succeed(clientCommandContribution({ id: 'hidden', title: 'Hidden', onSelect: () => {} })) })",
    )
    writeFileSync(
      join(fixtureUserDir, "_internal.client.tsx"),
      "import { Effect } from 'effect'; import { defineClientExtension, clientCommandContribution } from '@gent/tui/extensions'; export default defineClientExtension('@test/internal', { setup: Effect.succeed(clientCommandContribution({ id: 'internal', title: 'Internal', onSelect: () => {} })) })",
    )
    mkdirSync(join(fixtureUserDir, "__tests__"), { recursive: true })
    writeFileSync(
      join(fixtureUserDir, "__tests__", "test.client.tsx"),
      "import { Effect } from 'effect'; import { defineClientExtension, clientCommandContribution } from '../@gent/tui/extensions'; export default defineClientExtension('@test/spec-only', { setup: Effect.succeed(clientCommandContribution({ id: 'spec-only', title: 'Spec Only', onSelect: () => {} })) })",
    )
    writeFileSync(
      join(fixtureProjectDir, "prebuilt.client.mjs"),
      "import { Effect } from 'effect'; import { defineClientExtension, clientCommandContribution } from '@gent/tui/extensions'; export default defineClientExtension('@test/prebuilt', { setup: Effect.succeed(clientCommandContribution({ id: 'prebuilt', title: 'Prebuilt', onSelect: () => {} })) })",
    )
  })
  return { fixtureDir, fixtureUserDir, fixtureProjectDir }
}).pipe(Effect.provide(BunServices.layer))
describe("loadTuiExtensions", () => {
  it.scopedLive("loads builtin surfaces when no user or project extensions exist", () =>
    Effect.gen(function* () {
      const { fixtureDir } = yield* integrationFixture
      const emptyUser = join(fixtureDir, "empty-user")
      const emptyProject = join(fixtureDir, "empty-project")
      mkdirSync(emptyUser, { recursive: true })
      mkdirSync(emptyProject, { recursive: true })
      const resolved = yield* loadTuiExtensions({
        builtins: builtinClientModules,
        userDir: emptyUser,
        projectDir: emptyProject,
      })
      expect(resolved.renderers.has("read")).toBe(true)
      expect(resolved.renderers.has("bash")).toBe(true)
      expect(resolved.interactionRenderers.has("handoff")).toBe(true)
      expect(commandsOf(resolved).some((command) => command.id === "plan.create")).toBe(false)
      rmSync(emptyUser, { recursive: true, force: true })
      rmSync(emptyProject, { recursive: true, force: true })
    }),
  )
  it.scopedLive("disabling @gent/interaction-tools drops the handoff renderer with its tool", () =>
    Effect.gen(function* () {
      const { fixtureDir } = yield* integrationFixture
      const emptyUser = join(fixtureDir, "empty-user-handoff")
      const emptyProject = join(fixtureDir, "empty-project-handoff")
      mkdirSync(emptyUser, { recursive: true })
      mkdirSync(emptyProject, { recursive: true })
      const resolved = yield* loadTuiExtensions({
        builtins: builtinClientModules,
        userDir: emptyUser,
        projectDir: emptyProject,
        disabled: ["@gent/interaction-tools"],
      })
      expect(resolved.interactionRenderers.has("handoff")).toBe(false)
      expect(resolved.interactionRenderers.has("ask-user")).toBe(false)
      rmSync(emptyUser, { recursive: true, force: true })
      rmSync(emptyProject, { recursive: true, force: true })
    }),
  )
  it.scopedLive("user extensions can add visible renderer, widget, and command surfaces", () =>
    Effect.gen(function* () {
      const { fixtureDir, fixtureUserDir } = yield* integrationFixture
      const resolved = yield* loadTuiExtensions({
        builtins: builtinClientModules,
        userDir: fixtureUserDir,
        projectDir: join(fixtureDir, "no-project"),
      })
      expect(resolved.renderers.has("my_custom_tool")).toBe(true)
      expect(resolved.widgets.some((widget) => widget.id === "test-widget")).toBe(true)
      expect(commandsOf(resolved).some((command) => command.id === "test-cmd")).toBe(true)
    }),
  )
  it.scopedLive(
    "discovery ignores hidden and test-only files but still loads prebuilt modules deterministically",
    () =>
      Effect.gen(function* () {
        const { fixtureUserDir, fixtureProjectDir } = yield* integrationFixture
        const resolved = yield* loadTuiExtensions({
          builtins: [],
          userDir: fixtureUserDir,
          projectDir: fixtureProjectDir,
        })
        const commandIds = commandsOf(resolved).map((command) => command.id)
        expect(commandIds).toContain("prebuilt")
        expect(commandIds).not.toContain("hidden")
        expect(commandIds).not.toContain("internal")
        expect(commandIds).not.toContain("spec-only")
        expect(commandIds.filter((id) => id === "alpha" || id === "zeta")).toEqual([
          "alpha",
          "zeta",
        ])
      }),
  )
  it.scopedLive("project scope overrides builtin and user tool renderers", () =>
    Effect.gen(function* () {
      const { fixtureDir, fixtureProjectDir } = yield* integrationFixture
      const userOverrideDir = join(fixtureDir, "user-bash")
      mkdirSync(userOverrideDir, { recursive: true })
      writeFileSync(
        join(userOverrideDir, "override.client.ts"),
        `import { Effect } from "effect"
import { defineClientExtension, rendererContribution } from "@gent/tui/extensions"

export default defineClientExtension("@test/user-bash", {
  setup: Effect.succeed(
    rendererContribution(["bash"], () => "user-bash-override"),
  ),
})`,
      )
      const resolved = yield* loadTuiExtensions({
        builtins: builtinClientModules,
        userDir: userOverrideDir,
        projectDir: fixtureProjectDir,
      })
      const bashRenderer = Option.fromNullishOr(resolved.renderers.get("bash"))
      if (Option.isNone(bashRenderer)) return yield* Effect.die("expected bash renderer")
      expect(
        bashRenderer.value({
          toolCall: {
            id: "test",
            toolName: "bash",
            status: "completed",
            input: absent,
            summary: absent,
            output: absent,
          },
          expanded: false,
        }),
      ).toBe("project-bash-override")
      rmSync(userOverrideDir, { recursive: true, force: true })
    }),
  )
  it.scopedLive("disabled extensions are removed before setup runs", () =>
    Effect.gen(function* () {
      const { fixtureDir } = yield* integrationFixture
      const disabledDir = join(fixtureDir, "disabled-user")
      mkdirSync(disabledDir, { recursive: true })
      writeFileSync(
        join(disabledDir, "bomb.client.ts"),
        `import { Effect } from "effect"
export default {
  id: "@test/bomb",
  setup: Effect.sync(() => { throw new Error("setup() should not be called for disabled extension") }),
}`,
      )
      const resolved = yield* loadTuiExtensions({
        builtins: builtinClientModules,
        userDir: disabledDir,
        projectDir: join(fixtureDir, "no-project"),
        disabled: ["@gent/tools", "@test/bomb"],
      })
      expect(resolved.renderers.has("read")).toBe(false)
      expect(resolved.renderers.has("bash")).toBe(false)
      expect(resolved.interactionRenderers.has("handoff")).toBe(true)
      expect(commandsOf(resolved).some((command) => command.id === "plan.create")).toBe(false)
      rmSync(disabledDir, { recursive: true, force: true })
    }),
  )
  it.scopedLive("invalid extension files are skipped without breaking the builtin bundle", () =>
    Effect.gen(function* () {
      const { fixtureDir } = yield* integrationFixture
      const badDir = join(fixtureDir, "bad-ext")
      mkdirSync(badDir, { recursive: true })
      writeFileSync(join(badDir, "bad.client.ts"), "export default { not: 'an extension' }")
      const resolved = yield* loadTuiExtensions({
        builtins: builtinClientModules,
        userDir: badDir,
        projectDir: join(fixtureDir, "no-project"),
      })
      expect(resolved.renderers.has("read")).toBe(true)
      expect(resolved.failures).toEqual([
        { id: join(badDir, "bad.client.ts"), reason: "missing id" },
      ])
      rmSync(badDir, { recursive: true, force: true })
    }),
  )
  it.scopedLive("a same-scope collision drops the later contribution and keeps every builtin", () =>
    Effect.gen(function* () {
      const { fixtureDir } = yield* integrationFixture
      const collisionDir = join(fixtureDir, "collision-tool")
      mkdirSync(collisionDir, { recursive: true })
      writeFileSync(
        join(collisionDir, "a.client.ts"),
        `import { Effect } from "effect"
import { defineClientExtension, rendererContribution } from "@gent/tui/extensions"

export default defineClientExtension("@test/a", {
  setup: Effect.succeed(rendererContribution(["my_tool"], () => "a")),
})`,
      )
      writeFileSync(
        join(collisionDir, "b.client.ts"),
        `import { Effect } from "effect"
import { defineClientExtension, rendererContribution } from "@gent/tui/extensions"

export default defineClientExtension("@test/b", {
  setup: Effect.succeed(rendererContribution(["my_tool"], () => "b")),
})`,
      )
      const resolved = yield* loadTuiExtensions({
        builtins: builtinClientModules,
        userDir: collisionDir,
        projectDir: join(fixtureDir, "no-project"),
      })
      expect(resolved.renderers.has("read")).toBe(true)
      expect(resolved.renderers.has("bash")).toBe(true)
      const myTool = Option.fromNullishOr(resolved.renderers.get("my_tool"))
      if (Option.isNone(myTool)) return yield* Effect.die("expected my_tool renderer")
      expect(myTool.value(toolProps)).toBe("a")
      expect(resolved.failures).toHaveLength(1)
      expect(resolved.failures[0]?.id).toBe("@test/b")
      expect(resolved.failures[0]?.reason).toContain('renderer "my_tool"')
      rmSync(collisionDir, { recursive: true, force: true })
    }),
  )
  // The server fails every extension that shares an id within a scope; the
  // client applies the same rule, so neither half of a duplicate loads.
  it.scopedLive("two files with one id in a scope both fail and neither loads", () =>
    Effect.gen(function* () {
      const { fixtureDir } = yield* integrationFixture
      const duplicateDir = join(fixtureDir, "duplicate-id")
      mkdirSync(duplicateDir, { recursive: true })
      for (const name of ["one", "two"]) {
        writeFileSync(
          join(duplicateDir, `${name}.client.ts`),
          `import { Effect } from "effect"
import { defineClientExtension, rendererContribution } from "@gent/tui/extensions"

export default defineClientExtension("@test/dup", {
  setup: Effect.succeed(rendererContribution(["dup_${name}"], () => "${name}")),
})`,
        )
      }
      const resolved = yield* loadTuiExtensions({
        builtins: builtinClientModules,
        userDir: duplicateDir,
        projectDir: join(fixtureDir, "no-project"),
      })
      expect(resolved.renderers.has("dup_one")).toBe(false)
      expect(resolved.renderers.has("dup_two")).toBe(false)
      expect(resolved.failures).toEqual([
        { id: "@test/dup", reason: 'Duplicate extension id "@test/dup" in scope "user"' },
        { id: "@test/dup", reason: 'Duplicate extension id "@test/dup" in scope "user"' },
      ])
      rmSync(duplicateDir, { recursive: true, force: true })
    }),
  )
  it.scopedLive("builtin autocomplete sources stay visible", () =>
    Effect.gen(function* () {
      const { fixtureDir } = yield* integrationFixture
      const emptyUser = join(fixtureDir, "empty-user-ac")
      const emptyProject = join(fixtureDir, "empty-project-ac")
      mkdirSync(emptyUser, { recursive: true })
      mkdirSync(emptyProject, { recursive: true })
      const resolved = yield* loadTuiExtensions({
        builtins: builtinClientModules,
        userDir: emptyUser,
        projectDir: emptyProject,
      })
      const prefixes = new Set(resolved.autocompleteItems.map((entry) => entry.prefix))
      expect(prefixes.has("$")).toBe(true)
      expect(prefixes.has("@")).toBe(true)
      rmSync(emptyUser, { recursive: true, force: true })
      rmSync(emptyProject, { recursive: true, force: true })
    }),
  )
  it.scopedLive("startup with an active session does not break transport-only widgets", () => {
    const activeSessionRuntime = makeClientExtensionRuntime({
      transport: {
        client: createMockClient({ extension: { request: () => Effect.void } }),
        runtime: createMockRuntime(),
        currentSession: () =>
          Option.some({
            sessionId: SessionId.make("test-session-id"),
            branchId: BranchId.make("test-branch-id"),
          }),
        onExtensionStateChanged: () => () => {},
        onSessionEvent: () => () => {},
        modelCatalog: () => Option.none(),
      },
    })
    return Effect.gen(function* () {
      const { fixtureDir } = yield* integrationFixture
      const emptyUser = join(fixtureDir, "active-session-user")
      const emptyProject = join(fixtureDir, "active-session-project")
      mkdirSync(emptyUser, { recursive: true })
      mkdirSync(emptyProject, { recursive: true })
      yield* Effect.gen(function* () {
        const resolved = yield* loadTuiExtensions({
          builtins: builtinClientModules,
          userDir: emptyUser,
          projectDir: emptyProject,
          runtime: activeSessionRuntime,
        })
        // The builtin status labels: the goal (40) and the cache waste total (60).
        expect(resolved.statusLabels.map((label) => label.priority)).toEqual([40, 60])
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            rmSync(emptyUser, { recursive: true, force: true })
            rmSync(emptyProject, { recursive: true, force: true })
            yield* Effect.promise(() => activeSessionRuntime.dispose())
          }),
        ),
      )
    })
  })
})
describe("session UI state", () => {
  test("a picker replaces the current overlay and closes cleanly", () => {
    const withMermaid = transitionSessionUi(SessionUiState.initial(), { _tag: "OpenMermaid" })
    const withPicker = transitionSessionUi(withMermaid.state, {
      _tag: "OpenSettingsPicker",
      picker: "model",
    })
    const closed = transitionSessionUi(withPicker.state, { _tag: "CloseOverlay" })
    expect(withPicker.state.overlay).toEqual({ _tag: "model" })
    expect(closed.state.overlay).toEqual({ _tag: "none" })
  })
})

// ── tool renderer reach ─────────────────────────────────────────────────────

describe("tool renderer reach", () => {
  it.live("every builtin tool renderer names a tool a shipped extension registers", () =>
    Effect.gen(function* () {
      // The model sees only `cell`, and a cell hands each op to the renderer
      // registered for its tool: a renderer is reachable exactly when its name
      // is a real tool id.
      const loaded = yield* loadTuiExtensions({
        builtins: builtinClientModules,
        userDir: "/tmp/u-renderer-reach",
        projectDir: "/tmp/p-renderer-reach",
      })
      const toolIds = new Set<string>()
      for (const extension of BuiltinExtensions) {
        const contributions = yield* collectTestContributions(extension.setup, {
          cwd: "/tmp",
          home: "/nonexistent/gent-test-home",
        })
        for (const tool of contributions.tools ?? []) toolIds.add(tool.id)
      }
      expect(loaded.failures).toEqual([])
      expect(loaded.renderers.has("delegate.start")).toBe(true)
      expect([...loaded.renderers.keys()].filter((name) => !toolIds.has(name))).toEqual([])
    }).pipe(Effect.provide(BunServices.layer)),
  )
})
