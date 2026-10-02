import { describe, expect, it, test } from "effect-bun-test"
import {
  Effect,
  FileSystem,
  Layer,
  Logger,
  Option,
  Path,
  Predicate,
  References,
  Schema,
} from "effect"
import { BunPlatformLive, GentPlatform } from "@gent/core/host"
import { AgentEvent, BranchId, SessionId } from "@gent/core/protocol"
import { InteractionRequestId } from "@gent/core/extensions/branch-tools"
import {
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
import { writeFileSync } from "node:fs" // eslint-disable-line effect/noNodeBuiltinImport -- the logger callback is synchronous, so it writes the gate file directly.
import { join } from "node:path" // eslint-disable-line effect/noNodeBuiltinImport -- synchronous path fixture setup is a test boundary.
import { BunChildProcessSpawner, BunServices } from "@effect/platform-bun"
import { BuiltinExtensions } from "@gent/extensions"
import { collectTestContributions } from "@gent/core/test-utils"
import {
  makeClientExtensionRuntime,
  makeClientTestTransport,
  makeUnreachableTransport,
} from "../extension-test-harness-boundary"
import {
  defineRequests,
  ExtensionId,
  getToolId,
  ref,
  request,
  runProcess,
} from "@gent/core/extensions/api"
import { inRuntime } from "../helpers-boundary"
import { builtinClientModules } from "../../src/extensions/builtins"
import { type Command, executeSlashCommand } from "../../src/commands"
import { createMockClient } from "../render-harness-boundary"
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
// eslint-disable-next-line effect/noNullish -- a wire field the server leaves unset is present and undefined.
const absent = undefined
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
const cmd = (overrides: Partial<Command> & { id: string; slash: string }): Command => ({
  title: overrides.id,
  onSelect: () => {},
  ...overrides,
})

describe("resolveTuiExtensions", () => {
  test("higher scope wins for visible renderer surfaces", () => {
    const resolved = resolveTuiExtensions([
      make("builtin-tools", "builtin", rendererContribution(["bash"], renderer("builtin"))),
      make("user-tools", "user", rendererContribution(["bash"], renderer("user"))),
      make("project-tools", "project", rendererContribution(["bash"], renderer("project"))),
    ])

    const bashRenderer = Option.fromNullishOr(resolved.renderers.get("bash"))
    expect(Option.isSome(bashRenderer)).toBe(true)
    if (Option.isNone(bashRenderer)) return
    expect(bashRenderer.value.component(toolProps)).toBe("project")
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
    expect(bashRenderer.value.component(toolProps)).toBe("upper")
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
    expect(defaultRenderer.value.component(interactionProps)).toBe("prompt")
    expect(askRenderer.value.component(interactionProps)).toBe("project-ask")
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

  // `shift+ctrl+k` and `ctrl+shift+k` are one key, and so are `control+k` and `ctrl+k`.
  test("a same-scope keybind in another spelling of a held key collides", () => {
    for (const [held, respelled] of [
      ["ctrl+shift+k", "shift+ctrl+k"],
      ["ctrl+k", "control+k"],
      ["meta+k", "cmd+k"],
    ]) {
      const resolved = resolveTuiExtensions([
        make(
          "first",
          "user",
          clientCommandContribution({ id: "one", title: "One", keybind: held, onSelect: () => {} }),
        ),
        make(
          "second",
          "user",
          clientCommandContribution({
            id: "two",
            title: "Two",
            keybind: respelled,
            onSelect: () => {},
          }),
        ),
      ])
      const { commands, failures } = resolveCommands(resolved.commandSources)
      expect(commands.map((command) => command.title)).toEqual(["One"])
      expect(failures.map((failure) => failure.id)).toEqual(["second"])
    }
  })

  test("a project extension takes a builtin's slash and keybind", () => {
    let winner = ""
    const resolved = resolveTuiExtensions([
      make(
        "@gent/session",
        "builtin",
        clientCommandContribution({
          id: "session.model",
          title: "Model",
          slash: "model",
          keybind: "ctrl+k",
          onSelect: () => (winner = "builtin"),
        }),
      ),
      make(
        "@test/model",
        "project",
        clientCommandContribution({
          id: "project.model",
          title: "Project model",
          slash: "model",
          keybind: "ctrl+k",
          onSelect: () => (winner = "project"),
        }),
      ),
    ])
    const { commands, failures } = resolveCommands(resolved.commandSources)
    expect(executeSlashCommand("model", "", commands)).toBe(true)
    expect(winner).toBe("project")
    expect(failures).toEqual([])
    const project = commands.find((command) => command.id === "project.model")
    expect(project?.keybind).toBe("ctrl+k")
    // The builtin keeps its palette row; the slash and the keybind moved.
    const builtin = commands.find((command) => command.id === "session.model")
    expect(builtin?.slash).toBeUndefined()
    expect(builtin?.keybind).toBeUndefined()
  })

  test("a server slash that a session command already holds is dropped and reported", () => {
    const { commands, failures } = resolveCommands([
      {
        id: "@gent/session",
        scope: "builtin",
        source: "builtin:@gent/session",
        commands: [cmd({ id: "session.model", slash: "model" })],
      },
      {
        id: "@gent/example-models",
        scope: "builtin",
        source: "server:@gent/example-models",
        commands: [cmd({ id: "server:model", slash: "model" })],
      },
    ])
    expect(commands.map((command) => command.id)).toEqual(["session.model"])
    expect(failures.map((failure) => failure.id)).toEqual(["@gent/example-models"])
  })

  test("a keybind that types a character is refused in every scope, and the command stays", () => {
    const { commands, failures } = resolveCommands([
      {
        id: "@gent/session",
        scope: "builtin",
        source: "builtin:@gent/session",
        commands: [
          cmd({ id: "session.left", slash: "left", keybind: "left" }),
          cmd({ id: "session.help", slash: "help", keybind: "shift+/" }),
        ],
      },
      {
        id: "@test/keys",
        scope: "project",
        source: "/project/keys.client.ts",
        commands: [
          cmd({ id: "project.j", slash: "j", keybind: "j" }),
          cmd({ id: "project.space", slash: "space", keybind: "space" }),
          cmd({ id: "project.ctrl-j", slash: "ctrl-j", keybind: "ctrl+j" }),
          cmd({ id: "project.emoji", slash: "emoji", keybind: "🙂" }),
          cmd({ id: "project.accent", slash: "accent", keybind: "é" }),
          cmd({ id: "project.f1", slash: "f1", keybind: "f1" }),
          cmd({ id: "project.tab", slash: "tab", keybind: "tab" }),
        ],
      },
    ])
    const keybinds = Object.fromEntries(
      commands.map((command) => [
        command.id,
        Option.getOrElse(Option.fromNullishOr(command.keybind), () => "none"),
      ]),
    )
    expect(keybinds).toEqual({
      "session.left": "left",
      "session.help": "none",
      "project.j": "none",
      "project.space": "none",
      "project.ctrl-j": "ctrl+j",
      "project.emoji": "none",
      "project.accent": "none",
      "project.f1": "f1",
      "project.tab": "tab",
    })
    expect(commands.find((command) => command.id === "session.help")?.slash).toBe("help")
    expect(failures.map((failure) => failure.id)).toEqual([
      "@gent/session",
      "@test/keys",
      "@test/keys",
      "@test/keys",
      "@test/keys",
    ])
    expect(failures[1]?.reason).toContain('keybind "j"')
  })

  // A keybind runs before the Esc and ctrl+c ladders: a bare escape or a
  // ctrl+c would take the turn cancel and the quit away from the key.
  test("a bare escape or ctrl+c keybind is refused, and one with another modifier stays", () => {
    const { commands, failures } = resolveCommands([
      {
        id: "@test/keys",
        scope: "project",
        source: "/project/keys.client.ts",
        commands: [
          cmd({ id: "project.escape", slash: "escape", keybind: "escape" }),
          cmd({ id: "project.shift-escape", slash: "shift-escape", keybind: "shift+escape" }),
          cmd({ id: "project.ctrl-escape", slash: "ctrl-escape", keybind: "ctrl+escape" }),
          cmd({ id: "project.ctrl-c", slash: "ctrl-c", keybind: "ctrl+c" }),
          cmd({ id: "project.ctrl-shift-c", slash: "ctrl-shift-c", keybind: "ctrl+shift+c" }),
          cmd({ id: "project.ctrl-meta-c", slash: "ctrl-meta-c", keybind: "ctrl+meta+c" }),
        ],
      },
    ])
    const keybinds = Object.fromEntries(
      commands.map((command) => [
        command.id,
        Option.getOrElse(Option.fromNullishOr(command.keybind), () => "none"),
      ]),
    )
    expect(keybinds).toEqual({
      "project.escape": "none",
      "project.shift-escape": "none",
      "project.ctrl-escape": "ctrl+escape",
      "project.ctrl-c": "none",
      "project.ctrl-shift-c": "none",
      "project.ctrl-meta-c": "ctrl+meta+c",
    })
    expect(failures).toHaveLength(4)
    expect(failures[0]?.reason).toContain('keybind "escape"')
    expect(failures[2]?.reason).toContain('keybind "ctrl+c"')
  })
})

// ── extension effect setup ──────────────────────────────────────────────────

/**
 * `loadTuiExtensions` runs each Effect `setup` on the client runtime it gets.
 * A `setup` that is not an Effect fails its extension.
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
/** The modules a probe extension imported, as it hands them to the shell for the test to compare. */
const EntriesProbe = Schema.Struct({
  bound: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)),
  helperSessionId: Schema.Unknown,
  packageCreateSignal: Schema.Unknown,
})
// oxlint-disable-next-line effect/noDynamicImports -- the test imports a server-style file as the server loader does
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

  it.scopedLive(
    "a malformed known contribution bucket fails only its extension, and the healthy ones keep their rows",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "gent-client-malformed-bucket-",
        })
        const userDir = path.join(root, "home/.gent/extensions")
        const projectDir = path.join(root, "project/.gent/extensions")
        yield* fs.makeDirectory(userDir, { recursive: true })
        // A bucket that is not an array.
        yield* fs.writeFileString(
          path.join(userDir, "object-widgets.client.ts"),
          `
import { Effect } from "effect";
export default { id: "@user/object-widgets", setup: Effect.succeed({ widgets: {} }) };
`,
        )
        // An array whose command has no id and no onSelect.
        yield* fs.writeFileString(
          path.join(userDir, "headless-command.client.ts"),
          `
import { Effect } from "effect";
export default { id: "@user/headless-command", setup: Effect.succeed({ commands: [{ title: "x", slash: "x" }] }) };
`,
        )
        // A renderer whose tool names are not an array.
        yield* fs.writeFileString(
          path.join(userDir, "string-tools.client.ts"),
          `
import { Effect } from "effect";
export default {
  id: "@user/string-tools",
  setup: Effect.succeed({ renderers: [{ toolNames: "bash", component: () => null }] }),
};
`,
        )
        yield* fs.writeFileString(
          path.join(userDir, "healthy.client.ts"),
          `
import { Effect } from "effect";
import { autocompleteContribution } from "@gent/tui/extensions";
export default {
  id: "@user/healthy",
  setup: Effect.succeed(
    autocompleteContribution({ prefix: "%", title: "healthy", items: () => [] }),
  ),
};
`,
        )
        const good: ExtensionClientModule = {
          id: "@test/builtin-beside-malformed",
          setup: Effect.succeed(
            autocompleteContribution({ prefix: "!", title: "good", items: () => [] }),
          ),
        }
        const result = yield* loadTuiExtensions({ builtins: [good], userDir, projectDir, runtime })
        expect(result.autocompleteItems.map((c) => c.prefix)).toEqual(["!", "%"])
        expect(result.failures).toEqual([
          { id: "@user/headless-command", reason: 'malformed contribution "commands"' },
          { id: "@user/object-widgets", reason: 'malformed contribution "widgets"' },
          { id: "@user/string-tools", reason: 'malformed contribution "renderers"' },
        ])
      }).pipe(Effect.provide(BunServices.layer)),
  )

  it.scopedLive(
    "contributions read once inside their extension: a throwing bucket fails only it, and a bucket that changes after the check cannot reach resolution",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "gent-client-throwing-bucket-",
        })
        const userDir = path.join(root, "home/.gent/extensions")
        const projectDir = path.join(root, "project/.gent/extensions")
        yield* fs.makeDirectory(userDir, { recursive: true })
        yield* fs.writeFileString(
          path.join(userDir, "throwing.client.ts"),
          `
import { Effect } from "effect";
export default {
  id: "@user/throwing",
  setup: Effect.succeed({ get widgets() { throw new Error("broken") } }),
};
`,
        )
        // Well-formed on the first read, malformed on every read after it.
        yield* fs.writeFileString(
          path.join(userDir, "shifting.client.ts"),
          `
import { Effect } from "effect";
let reads = 0;
const widgets = [{ id: "shifting", slot: "below-input", component: () => null }];
export default {
  id: "@user/shifting",
  setup: Effect.succeed({ get widgets() { reads++; return reads === 1 ? widgets : {} } }),
};
`,
        )
        const good: ExtensionClientModule = {
          id: "@test/builtin-beside-throwing",
          setup: Effect.succeed(
            autocompleteContribution({ prefix: "!", title: "good", items: () => [] }),
          ),
        }
        const result = yield* loadTuiExtensions({ builtins: [good], userDir, projectDir, runtime })
        expect(result.autocompleteItems.map((c) => c.prefix)).toEqual(["!"])
        expect(result.widgets.map((w) => w.id)).toEqual(["shifting"])
        expect(result.failures.map((failure) => failure.id)).toEqual(["@user/throwing"])
        expect(result.failures[0]?.reason).toContain("broken")
      }).pipe(Effect.provide(BunServices.layer)),
  )

  it.scopedLive(
    "an entry field that throws fails only its extension, and a class instance's buckets still load",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "gent-client-nested-getter-",
        })
        const userDir = path.join(root, "home/.gent/extensions")
        const projectDir = path.join(root, "project/.gent/extensions")
        yield* fs.makeDirectory(userDir, { recursive: true })
        // Reading the component throws.
        yield* fs.writeFileString(
          path.join(userDir, "nested.client.ts"),
          `
import { Effect } from "effect";
const widget = {
  id: "nested",
  slot: "below-input",
  get component() {
    throw new Error("nested broken");
  },
};
export default { id: "@user/nested", setup: Effect.succeed({ widgets: [widget] }) };
`,
        )
        // The component answers its first read only: the loader reads it once.
        yield* fs.writeFileString(
          path.join(userDir, "once.client.ts"),
          `
import { Effect } from "effect";
let reads = 0;
const widget = {
  id: "once",
  slot: "below-input",
  get component() {
    reads++;
    if (reads > 1) throw new Error("read twice");
    return () => null;
  },
};
export default { id: "@user/once", setup: Effect.succeed({ widgets: [widget] }) };
`,
        )
        // Buckets as prototype getters of a class instance.
        yield* fs.writeFileString(
          path.join(userDir, "instance.client.ts"),
          `
import { Effect } from "effect";
class Contributions {
  get widgets() {
    return [{ id: "instance", slot: "below-input", component: () => null }];
  }
}
export default { id: "@user/instance", setup: Effect.succeed(new Contributions()) };
`,
        )
        const good: ExtensionClientModule = {
          id: "@test/builtin-beside-nested",
          setup: Effect.succeed(
            autocompleteContribution({ prefix: "!", title: "good", items: () => [] }),
          ),
        }
        const result = yield* loadTuiExtensions({ builtins: [good], userDir, projectDir, runtime })
        expect(result.autocompleteItems.map((c) => c.prefix)).toEqual(["!"])
        expect(result.widgets.map((w) => w.id).toSorted()).toEqual(["instance", "once"])
        expect(result.failures.map((failure) => failure.id)).toEqual(["@user/nested"])
        expect(result.failures[0]?.reason).toContain("nested broken")
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
  setup: effect.Effect.gen(function* () {
    const { shell } = yield* tui.ClientContext
    shell.cast(effect.Effect.succeed({ bound, helperSessionId, packageCreateSignal }))
    return tui.clientContributions(
      tui.widgetContribution({ id: "entries-probe", slot: "below-input", component: Probe }),
      tui.clientCommandContribution({ id: "entries-probe", title: "Entries probe", onSelect: () => {} }),
    )
  }),
})
`,
        )
        // The probe extension casts its imports to the shell; the test keeps the cast.
        const casts: Array<Effect.Effect<unknown>> = []
        const probeRuntime = makeClientExtensionRuntime({
          shell: {
            cast: (cast) => {
              casts.push(Effect.orDie(cast))
            },
          },
        })
        yield* Effect.addFinalizer(() => Effect.promise(() => probeRuntime.dispose()))
        const result = yield* loadTuiExtensions({ userDir, projectDir, runtime: probeRuntime })
        expect(result.failures).toEqual([])
        expect(result.widgets.map((entry) => entry.id)).toContain("entries-probe")
        expect(
          result.commandSources.flatMap((source) => source.commands.map((command) => command.id)),
        ).toContain("entries-probe")

        expect(casts).toHaveLength(1)
        const probe = yield* Schema.decodeUnknownEffect(EntriesProbe)(
          yield* Option.getOrThrow(Option.fromNullishOr(casts[0])),
        )
        expect(probe.helperSessionId).toBe(ProtocolEntry.SessionId)
        expect(probe.packageCreateSignal).toBe(SolidEntry.createSignal)
        for (const [specifier, entryModule] of Object.entries(clientEntries)) {
          for (const [name, value] of Object.entries(entryModule)) {
            const same = probe.bound[specifier]?.[name] === value
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
        const dir = yield* path.fromFileUrl(new URL("../../src/extensions", import.meta.url))
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

  it.live("an extension setup reads the file system and contributes its rows", () =>
    Effect.gen(function* () {
      const fxSetup: Effect.Effect<ClientContributions, never, FileSystem.FileSystem | Path.Path> =
        Effect.gen(function* () {
          // The runtime gives the setup both platform services.
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
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
        userDir: "/nonexistent/gent-test-user-setup-services",
        projectDir: "/nonexistent/gent-test-project-setup-services",
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
        userDir: "/nonexistent/gent-test-user-setup-failure",
        projectDir: "/nonexistent/gent-test-project-setup-failure",
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
        userDir: "/nonexistent/gent-test-u-hung-setup",
        projectDir: "/nonexistent/gent-test-p-hung-setup",
        loadTimeout: "50 millis",
        runtime,
      })
      expect(result.autocompleteItems.map((c) => c.prefix)).toContain("!")
      expect(result.failures.map((failure) => failure.id)).toEqual(["@test/hung"])
      expect(result.failures[0]?.reason).toContain("setup timed out")
    }).pipe(Effect.timeout("5 seconds")),
  )
  // Each import is a build and an import, up to the load timeout. Two files
  // whose imports finish only once both have started load only when the
  // imports overlap; one at a time, the first waits out its timeout. The
  // first file's import also finishes only after the last file has failed,
  // so its failure completes last, and the failures still keep discovery order.
  it.scopedLive("discovered files import concurrently and fail in discovery order", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "gent-client-overlap-" })
      const userDir = path.join(root, "user")
      yield* fs.makeDirectory(userDir, { recursive: true })
      const gateKey = `gent-probe-overlap-${path.basename(root)}`
      // The module of `a` waits for this file; the first import failure the
      // loader logs writes it, in the failing fiber before that fiber ends.
      // While `a` waits, only `c` can fail.
      const lastFailed = path.join(root, "last-failed")
      const failureSeen = Logger.make(({ message }) => {
        if ([message].flat().map(String).join(" ") === "tui-ext.import.failed")
          writeFileSync(lastFailed, "")
      })
      const bothStarted = `
const gate = (globalThis[Symbol.for("${gateKey}")] ??= (() => {
  let open = () => {}
  const opened = new Promise((resolve) => { open = resolve })
  return { arrived: 0, open, opened }
})())
gate.arrived += 1
if (gate.arrived === 2) gate.open()
await gate.opened
`
      yield* fs.writeFileString(
        path.join(userDir, "a-slow.client.ts"),
        `${bothStarted}\nwhile (!(await Bun.file("${lastFailed}").exists())) await Bun.sleep(5)\nexport default { not: "an extension" }`,
      )
      yield* fs.writeFileString(
        path.join(userDir, "b-slow.client.ts"),
        `import { Effect } from "effect"
import { defineClientExtension, clientCommandContribution } from "@gent/tui/extensions"
${bothStarted}
export default defineClientExtension("@test/overlap", {
  setup: Effect.succeed(clientCommandContribution({ id: "overlap", title: "Overlap", onSelect: () => {} })),
})`,
      )
      yield* fs.writeFileString(
        path.join(userDir, "c-broken.client.ts"),
        `export default { not: "an extension" }`,
      )
      const result = yield* loadTuiExtensions({
        userDir,
        projectDir: path.join(root, "project"),
        loadTimeout: "3 seconds",
        runtime,
      }).pipe(
        Effect.provide(Logger.layer([failureSeen])),
        Effect.provideService(References.MinimumLogLevel, "All"),
      )
      expect(result.failures).toEqual([
        { id: path.join(userDir, "a-slow.client.ts"), reason: "missing id" },
        { id: path.join(userDir, "c-broken.client.ts"), reason: "missing id" },
      ])
      expect(commandsOf(result).map((command) => command.id)).toContain("overlap")
    }).pipe(Effect.timeout("10 seconds"), Effect.provide(BunServices.layer)),
  )
})

// ── autocomplete effect items ───────────────────────────────────────────────

/**
 * An autocomplete `items()` can return an Effect that reads `ClientContext`.
 * `runAutocompleteContributions` runs it on the client runtime: a typed
 * request goes through the transport and the reply is decoded. Success
 * returns the items; a failed request is reported and gives no rows.
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
const makeFakeTransport = (
  opts: {
    readonly requestReply?: unknown
    readonly requestEffect?: () => Effect.Effect<unknown, Error>
  } = {},
): ClientShellTransport =>
  makeClientTestTransport({
    currentSession: () => ({
      sessionId: SessionId.make("sess-1"),
      branchId: BranchId.make("branch-1"),
    }),
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
  it.live("Effect items that read ClientContext return their rows", () =>
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
            expect(t.currentSession().sessionId).toBe(SessionId.make("sess-1"))
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
      expect(result.map((entry) => entry.item)).toEqual([{ id: "hello", label: "got:hello" }])
      yield* Effect.promise(() => runtime.dispose())
    }),
  )
  it.live("a contribution whose transport call fails is reported and contributes no rows", () =>
    Effect.gen(function* () {
      // One broken contribution must not empty the popup for the rest, so the
      // helper names it to the caller's log and returns its rows as none.
      const transport = makeFakeTransport({
        requestEffect: () => Effect.fail(new AutocompleteTestError({ message: "transport down" })),
      })
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
      expect(failures[0]).toContain("transport down")
      yield* Effect.promise(() => runtime.dispose())
    }),
  )
  it.live("an extension request returns the server's reply", () =>
    Effect.gen(function* () {
      const transport = makeFakeTransport({ requestReply: ["effect-v4", "react"] })
      const runtime = makeTestRuntime(transport)
      const result = yield* inRuntime(runtime, listThings)
      expect(result).toEqual(["effect-v4", "react"])
      yield* Effect.promise(() => runtime.dispose())
    }),
  )
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
      expect(resolved.currentSession()).toEqual({
        sessionId: SessionId.make("sess-1"),
        branchId: BranchId.make("branch-1"),
      })
      expect("run" in resolved).toBe(false)
      expect("cast" in resolved).toBe(false)
      yield* Effect.promise(() => runtime.dispose())
    }),
  )
})

// ── extension integration ───────────────────────────────────────────────────

/**
 * TUI extension integration contracts.
 *
 * Keep one end-to-end story per user-visible outcome:
 * discovery, override precedence, disabled gating, invalid-file tolerance,
 * autocomplete visibility, and startup with an active session.
 */
const testRuntime = makeClientExtensionRuntime({ transport: makeUnreachableTransport() })
/** Run the loader on a client runtime, the stub one unless the test gives its own. */
const loadTuiExtensions = (
  opts: Parameters<typeof _loadTuiExtensions>[0] & { readonly runtime?: ClientRuntime },
): Effect.Effect<ResolvedTuiExtensions> =>
  inRuntime(opts.runtime ?? testRuntime, _loadTuiExtensions(opts))
const encodeTrustGrant = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ trustedProjects: Schema.Array(Schema.String) })),
)
const commandModule = (id: string, command: string) =>
  `import { Effect } from 'effect'; import { defineClientExtension, clientCommandContribution } from '@gent/tui/extensions'; export default defineClientExtension('${id}', { setup: Effect.succeed(clientCommandContribution({ id: '${command}', title: '${command}', onSelect: () => {} })) })`
// A scoped system temp directory: the loader binds `effect` and the public
// entries, so the files resolve them with no node_modules above.
const integrationFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const fixtureDir = yield* fs.makeTempDirectoryScoped({ prefix: "gent-client-integration-" })
  const fixtureUserDir = path.join(fixtureDir, "user")
  const fixtureProjectDir = path.join(fixtureDir, "project")
  /** Write `text` at `file` and make its parent directories. */
  const write = (file: string, text: string) =>
    fs
      .makeDirectory(path.dirname(file), { recursive: true })
      .pipe(Effect.andThen(fs.writeFileString(file, text)))
  // The project root is two levels above the project extension directory.
  const projectRoot = yield* fs.realPath(path.join(fixtureProjectDir, "../.."))
  yield* write(
    path.join(fixtureDir, "config.json"),
    encodeTrustGrant({ trustedProjects: [projectRoot] }),
  )
  yield* write(
    path.join(fixtureUserDir, "custom-read", "client.ts"),
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
  yield* write(
    path.join(fixtureProjectDir, "override-bash.client.ts"),
    `import { Effect } from "effect"
import { defineClientExtension, rendererContribution } from "@gent/tui/extensions"

export default defineClientExtension("@test/override-bash", {
  setup: Effect.succeed(
    rendererContribution(["bash"], () => "project-bash-override"),
  ),
})`,
  )
  yield* write(path.join(fixtureUserDir, "alpha.client.ts"), commandModule("@test/alpha", "alpha"))
  yield* write(path.join(fixtureUserDir, "zeta.client.ts"), commandModule("@test/zeta", "zeta"))
  yield* write(
    path.join(fixtureUserDir, ".hidden.client.tsx"),
    commandModule("@test/hidden", "hidden"),
  )
  yield* write(
    path.join(fixtureUserDir, "_internal.client.tsx"),
    commandModule("@test/internal", "internal"),
  )
  yield* write(
    path.join(fixtureUserDir, "__tests__", "client.tsx"),
    commandModule("@test/spec-only", "spec-only"),
  )
  yield* write(
    path.join(fixtureProjectDir, "prebuilt.client.mjs"),
    commandModule("@test/prebuilt", "prebuilt"),
  )
  return { fixtureDir, fixtureUserDir, fixtureProjectDir, write }
}).pipe(Effect.provide(BunServices.layer))
describe("loadTuiExtensions", () => {
  it.scopedLive(
    "with an active session and no user or project extensions, the builtin surfaces load",
    () => {
      const activeSessionRuntime = makeClientExtensionRuntime({
        transport: {
          client: createMockClient({ extension: { request: () => Effect.void } }),
          currentSession: () => ({
            sessionId: SessionId.make("test-session-id"),
            branchId: BranchId.make("test-branch-id"),
          }),
          onExtensionStateChanged: () => () => {},
          onSessionEvent: () => () => {},
          modelCatalog: () => Option.none(),
        },
      })
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const { fixtureDir } = yield* integrationFixture
        const emptyUser = join(fixtureDir, "empty-user")
        const emptyProject = join(fixtureDir, "empty-project")
        yield* fs.makeDirectory(emptyUser)
        yield* fs.makeDirectory(emptyProject)
        yield* Effect.addFinalizer(() => Effect.promise(() => activeSessionRuntime.dispose()))
        const resolved = yield* loadTuiExtensions({
          builtins: builtinClientModules,
          userDir: emptyUser,
          projectDir: emptyProject,
          runtime: activeSessionRuntime,
        })
        expect(resolved.renderers.has("read")).toBe(true)
        expect(resolved.renderers.has("bash")).toBe(true)
        expect(resolved.interactionRenderers.has("handoff")).toBe(true)
        const prefixes = new Set(resolved.autocompleteItems.map((entry) => entry.prefix))
        expect(prefixes.has("$")).toBe(true)
        expect(prefixes.has("@")).toBe(true)
        // The builtin status labels: the goal (40) and the cache waste total (60).
        expect(resolved.statusLabels.map((label) => label.priority)).toEqual([40, 60])
      }).pipe(Effect.provide(BunServices.layer))
    },
  )
  it.scopedLive("disabling @gent/interaction-tools drops the handoff renderer with its tool", () =>
    Effect.gen(function* () {
      const { fixtureDir } = yield* integrationFixture
      const resolved = yield* loadTuiExtensions({
        builtins: builtinClientModules,
        userDir: join(fixtureDir, "no-user"),
        projectDir: join(fixtureDir, "no-project"),
        disabled: ["@gent/interaction-tools"],
      })
      expect(resolved.interactionRenderers.has("handoff")).toBe(false)
      expect(resolved.interactionRenderers.has("ask-user")).toBe(false)
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
        expect(resolved.failures).toEqual([])
        expect(commandIds.filter((id) => id === "alpha" || id === "zeta")).toEqual([
          "alpha",
          "zeta",
        ])
      }),
  )
  it.scopedLive("project scope overrides builtin and user tool renderers", () =>
    Effect.gen(function* () {
      const { fixtureDir, fixtureProjectDir, write } = yield* integrationFixture
      const userOverrideDir = join(fixtureDir, "user-bash")
      yield* write(
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
        bashRenderer.value.component({
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
    }),
  )
  it.scopedLive("disabled extensions are removed before setup runs", () =>
    Effect.gen(function* () {
      const { fixtureDir, write } = yield* integrationFixture
      const disabledDir = join(fixtureDir, "disabled-user")
      yield* write(
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
      // The bomb never ran: a setup that ran would fail it by name.
      expect(resolved.failures).toEqual([])
    }),
  )
  it.scopedLive("invalid extension files are skipped without breaking the builtin bundle", () =>
    Effect.gen(function* () {
      const { fixtureDir, write } = yield* integrationFixture
      const badDir = join(fixtureDir, "bad-ext")
      yield* write(join(badDir, "bad.client.ts"), "export default { not: 'an extension' }")
      const resolved = yield* loadTuiExtensions({
        builtins: builtinClientModules,
        userDir: badDir,
        projectDir: join(fixtureDir, "no-project"),
      })
      expect(resolved.renderers.has("read")).toBe(true)
      expect(resolved.failures).toEqual([
        { id: join(badDir, "bad.client.ts"), reason: "missing id" },
      ])
    }),
  )
  it.scopedLive("a same-scope collision drops the later contribution and keeps every builtin", () =>
    Effect.gen(function* () {
      const { fixtureDir, write } = yield* integrationFixture
      const collisionDir = join(fixtureDir, "collision-tool")
      yield* write(
        join(collisionDir, "a.client.ts"),
        `import { Effect } from "effect"
import { defineClientExtension, rendererContribution } from "@gent/tui/extensions"

export default defineClientExtension("@test/a", {
  setup: Effect.succeed(rendererContribution(["my_tool"], () => "a")),
})`,
      )
      yield* write(
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
      expect(myTool.value.component(toolProps)).toBe("a")
      expect(resolved.failures).toHaveLength(1)
      expect(resolved.failures[0]?.id).toBe("@test/b")
      expect(resolved.failures[0]?.reason).toContain('renderer "my_tool"')
    }),
  )
  // The server fails every extension that shares an id within a scope; the
  // client applies the same rule, so neither half of a duplicate loads.
  it.scopedLive("two files with one id in a scope both fail and neither loads", () =>
    Effect.gen(function* () {
      const { fixtureDir, write } = yield* integrationFixture
      const duplicateDir = join(fixtureDir, "duplicate-id")
      for (const name of ["one", "two"]) {
        yield* write(
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
    }),
  )
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
        userDir: "/nonexistent/gent-test-u-renderer-reach",
        projectDir: "/nonexistent/gent-test-p-renderer-reach",
      })
      const toolIds = new Set<string>()
      for (const extension of BuiltinExtensions) {
        const contributions = yield* collectTestContributions(extension.setup, {
          cwd: "/nonexistent/gent-test-cwd",
          home: "/nonexistent/gent-test-home",
        })
        for (const tool of contributions.tools ?? []) toolIds.add(getToolId(tool))
      }
      expect(loaded.failures).toEqual([])
      expect(loaded.renderers.has("delegate.start")).toBe(true)
      expect([...loaded.renderers.keys()].filter((name) => !toolIds.has(name))).toEqual([])
    }).pipe(Effect.provide(BunServices.layer)),
  )
})

describe("client extension compile", () => {
  // The test run's preload loads Babel itself, so these run in a fresh process
  // that loads it the way a launch does.
  it.live(
    "importing the Bun adapter loads no Babel module until a client extension compiles",
    () =>
      Effect.gen(function* () {
        const stdout = yield* runFresh(
          [
            `await import("${adapterUrl}")`,
            `console.log(Object.keys(require.cache).filter((key) => key.includes("/@babel/")).length)`,
          ],
          [],
        )
        expect(stdout).toBe("0")
      }).pipe(Effect.timeout("25 seconds"), Effect.provide(freshProcessLayer)),
    30_000,
  )

  it.live(
    "a build interrupted while the Solid plugin loads leaves the next build working",
    () =>
      Effect.gen(function* () {
        const stdout = yield* runFresh(
          [
            `const { Effect, Fiber, Option } = await import("${import.meta.resolve("effect")}")`,
            `const { buildClientExtension } = await import("${adapterUrl}")`,
            `const names = { external: [], rename: () => Option.none(), solidRuntime: "@opentui/solid" }`,
            `const file = import.meta.dir + "/widget.tsx"`,
            `const first = Effect.runFork(buildClientExtension(file, names))`,
            `await Effect.runPromise(Fiber.interrupt(first))`,
            `const exit = await Effect.runPromiseExit(buildClientExtension(file, names))`,
            `console.log(exit._tag === "Success" && exit.value.includes("widget-text") ? "built" : String(exit))`,
          ],
          [["widget.tsx", `export const widget = "widget-text"`]],
        )
        expect(stdout).toBe("built")
      }).pipe(Effect.timeout("25 seconds"), Effect.provide(freshProcessLayer)),
    30_000,
  )
})

const adapterUrl = new URL("../../src/bun-adapter.ts", import.meta.url).href

/** Run `lines` as a script in a fresh Bun beside `files`; its stdout, trimmed. */
const runFresh = (
  lines: ReadonlyArray<string>,
  files: ReadonlyArray<readonly [name: string, text: string]>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const platform = yield* GentPlatform
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "gent-fresh-process-" })
      for (const [name, text] of files) yield* fs.writeFileString(path.join(directory, name), text)
      const script = path.join(directory, "script.ts")
      yield* fs.writeFileString(script, lines.join("\n"))
      const result = yield* runProcess(yield* platform.execPath, ["--config=/dev/null", script], {
        cwd: directory,
      })
      expect(result.exitCode).toBe(0)
      return result.stdout.trim()
    }),
  )

const freshProcessLayer = Layer.mergeAll(
  BunPlatformLive,
  BunChildProcessSpawner.layer.pipe(Layer.provide(BunServices.layer)),
)
