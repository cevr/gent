/** @jsxImportSource @opentui/solid */
import { describe, expect, it, test } from "effect-bun-test"
import {
  AutocompletePopup,
  Composer,
  StatusRow,
  createPasteManager,
  executeShell,
  isLargePaste,
  SHELL_READ_CAP_BYTES,
} from "../src/composer"
import {
  ConfigProvider,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Schedule,
  Schema,
} from "effect"
import { runProcess } from "@gent/core/extensions/api"
import {
  type ActiveInteraction,
  BranchId,
  dateFromMillis,
  type GentClientRpcError,
  GentRpcError,
  SessionId,
} from "@gent/core/protocol"
import { InteractionRequestId } from "@gent/core/extensions/branch-tools"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { RGBA } from "@opentui/core"
import {
  type StatusRowLabel,
  type ComposerEvent,
  ComposerInteractionState,
  ComposerState,
  type SessionController,
  type SlashSubmission,
  SessionControllerContext,
  SessionUiState,
  transitionComposerInteraction,
} from "../src/session"
import {
  createMockClient,
  renderFrame,
  renderScoped as renderScopedHarness,
  renderWithProviders as renderHarness,
} from "./render-harness-boundary"
import { createSignal, ErrorBoundary, type JSX, onMount, Show } from "solid-js"
import { PromptSearchState } from "../src/pickers"
import { type ClientContextValue, type SessionIdentity, useClient } from "../src/client"
import { useExtensionUI } from "../src/extensions/host"
import { type RenderWaitTimeoutError, waitForFrame } from "./helpers-boundary"
import { useScopedKeyboard } from "../src/terminal"
import { EnvProvider } from "../src/workspace"
import {
  type AutocompleteItem,
  autocompleteContribution,
  clientContributions,
  defineClientExtension,
} from "../src/extensions/client-facets"
import { builtinClientModules } from "../src/extensions/builtins"
import { rankAutocompleteItems } from "../src/autocomplete"
import { RpcClientError } from "effect/rpc/RpcClientError"
import { SocketCloseError } from "effect/socket/Socket"

// ── shell ───────────────────────────────────────────────────────────────────

/** The composer lives in a session view, so every mount has a session to draft in. */
const draftSession = {
  sessionId: SessionId.make("draft-session"),
  branchId: BranchId.make("draft-branch"),
  name: "Draft",
}
const renderWithProviders: typeof renderHarness = (ui, options) =>
  renderHarness(ui, { initialSession: draftSession, ...options })
const renderScoped: typeof renderScopedHarness = (ui, options) =>
  renderScopedHarness(ui, { initialSession: draftSession, ...options })

/**
 * Each test runs with its own gent data directory, a scoped temp directory,
 * so a `!cmd` whose output passes the cap spills there, never into the real
 * home. The rest of the config still comes from the environment.
 */
const scopedDataDir = ConfigProvider.layerAdd(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: "gent-composer-data-" })
    return ConfigProvider.fromEnvRecord({ GENT_DATA_DIR: dataDir })
  }),
  { asPrimary: true },
)
const testLayer = scopedDataDir.pipe(
  Layer.provideMerge(Layer.merge(BunFileSystem.layer, BunServices.layer)),
)
const shellTest = it.scopedLive.layer(testLayer)

describe("executeShell", () => {
  shellTest("executes simple command", () =>
    Effect.gen(function* () {
      const testDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
      const result = yield* executeShell("echo hello", testDir)
      expect(result.output).toBe("hello")
      expect(result.truncated).toBe(false)
    }),
  )

  shellTest("captures stderr", () =>
    Effect.gen(function* () {
      const testDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
      const result = yield* executeShell("echo error >&2", testDir)
      expect(result.output).toContain("error")
      expect(result.truncated).toBe(false)
    }),
  )

  shellTest("respects cwd", () =>
    Effect.gen(function* () {
      const testDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
      const result = yield* executeShell("pwd", testDir)
      // macOS may resolve /var to /private/var
      expect(result.output.endsWith(testDir.split("/").pop()!)).toBe(true)
      expect(result.truncated).toBe(false)
    }),
  )

  shellTest("handles multi-line output", () =>
    Effect.gen(function* () {
      const testDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
      const result = yield* executeShell("echo -e 'line1\\nline2\\nline3'", testDir)
      expect(result.output).toContain("line1")
      expect(result.output).toContain("line2")
      expect(result.output).toContain("line3")
      expect(result.truncated).toBe(false)
    }),
  )

  shellTest("handles empty output", () =>
    Effect.gen(function* () {
      const testDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
      const result = yield* executeShell("true", testDir)
      expect(result.output).toBe("")
      expect(result.truncated).toBe(false)
    }),
  )

  shellTest("handles command with arguments", () =>
    Effect.gen(function* () {
      const testDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
      const result = yield* executeShell("echo -n test", testDir)
      expect(result.output).toBe("test")
    }),
  )

  shellTest("handles pipes", () =>
    Effect.gen(function* () {
      const testDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
      const result = yield* executeShell("echo hello | tr 'h' 'H'", testDir)
      expect(result.output).toBe("Hello")
    }),
  )

  shellTest("handles file operations", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const testDir = yield* fs.makeTempDirectoryScoped()
      const testFile = `${testDir}/test.txt`
      yield* fs.writeFileString(testFile, "file content")
      const result = yield* executeShell(`cat ${testFile}`, testDir)
      expect(result.output).toBe("file content")
    }),
  )

  shellTest("truncates output over line limit", () =>
    // Generate output with more than 2000 lines
    Effect.gen(function* () {
      const testDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
      const result = yield* executeShell("seq 1 2500", testDir)
      expect(result.truncated).toBe(true)

      // Output should be truncated to ~2000 lines
      const lineCount = result.output.split("\n").length
      expect(lineCount).toBeLessThanOrEqual(2001)
      // The spill lands in this test's own data directory, not the real home.
      const savedPath = yield* Effect.fromOption(result.savedPath)
      expect(savedPath).toMatch(/\/gent-composer-data-[^/]*\/shell-output\/shell_[^/]*\.txt$/)
    }),
  )

  shellTest("truncates output over byte limit", () =>
    // Generate output over 50KB (each 'x' repeated 100 times per line, 600 lines = 60KB)
    Effect.gen(function* () {
      const testDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
      const result = yield* executeShell(
        "for i in $(seq 1 600); do printf '%0.s█' {1..100}; echo; done",
        testDir,
      )
      expect(result.truncated).toBe(true)

      // Output should be under 50KB
      expect(result.output.length).toBeLessThanOrEqual(50 * 1024)
      const savedPath = yield* Effect.fromOption(result.savedPath)
      expect(savedPath).toMatch(/\/gent-composer-data-[^/]*\/shell-output\/shell_[^/]*\.txt$/)
    }),
  )

  // The cap counts UTF-8 bytes, as the `@file` cap does, and cuts at a whole line.
  shellTest("multi-byte output past the byte cap is cut at a whole line", () =>
    Effect.gen(function* () {
      const testDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
      // 600 lines of 50 `é`: about 30,000 UTF-16 units, but 60,600 bytes of UTF-8.
      const result = yield* executeShell(
        "for i in $(seq 1 600); do printf 'é%.0s' {1..50}; echo; done",
        testDir,
      )
      expect(result.truncated).toBe(true)
      expect(new TextEncoder().encode(result.output).length).toBeLessThanOrEqual(50 * 1024)
      expect(result.output.split("\n").every((line) => line === "é".repeat(50))).toBe(true)
      expect(Option.isSome(result.savedPath)).toBe(true)
    }),
  )

  // `yes` never ends on its own: reading stops at the cap, the command is
  // ended there, and memory holds no more than the cap and one chunk.
  shellTest("output past the read cap ends the command and keeps what was read", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const testDir = yield* fs.makeTempDirectoryScoped()
      const result = yield* executeShell("yes", testDir)
      expect(result.ended).toBe(true)
      expect(result.truncated).toBe(true)
      const savedPath = yield* Effect.fromOption(result.savedPath)
      const saved = yield* fs.readFileString(savedPath)
      expect(saved).toContain("the command was ended")
      expect(saved.length).toBeGreaterThanOrEqual(SHELL_READ_CAP_BYTES)
      expect(saved.length).toBeLessThan(SHELL_READ_CAP_BYTES + 1024 * 1024)
      yield* fs.remove(savedPath)
    }).pipe(Effect.timeout("20 seconds")),
  )

  // An interrupt closes the command's scope, and the process goes with it.
  shellTest("an interrupted command ends its process", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const testDir = yield* fs.makeTempDirectoryScoped()
      const fiber = yield* Effect.forkChild(executeShell("echo $$ > pid; exec sleep 30", testDir))
      const pidFile = `${testDir}/pid`
      const poll = Schedule.spaced("10 millis")
      yield* fs.exists(pidFile).pipe(Effect.repeat({ until: (started) => started, schedule: poll }))
      const pid = (yield* fs.readFileString(pidFile)).trim()
      expect(pid.length).toBeGreaterThan(0)
      yield* Fiber.interrupt(fiber)
      // `ps -p` fails once no process has the id.
      yield* runProcess("ps", ["-p", pid]).pipe(
        Effect.repeat({ until: (ps) => ps.exitCode !== 0, schedule: poll }),
      )
    }).pipe(Effect.timeout("10 seconds")),
  )

  shellTest("a command inside the cap spills nothing", () =>
    Effect.gen(function* () {
      const testDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
      const result = yield* executeShell("echo small", testDir)
      expect(result.truncated).toBe(false)
      expect(Option.isNone(result.savedPath)).toBe(true)
    }),
  )

  shellTest("truncated output is written whole under the gent data directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const testDir = yield* fs.makeTempDirectoryScoped()
      const dataDir = yield* fs.makeTempDirectoryScoped()
      const lineCount = 2500
      // A run with its own data directory spills there, not into the real home.
      const inDataDir = Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnvRecord({ GENT_DATA_DIR: dataDir }),
      )
      const result = yield* executeShell(`seq 1 ${lineCount} | sed 's/^/line /'`, testDir).pipe(
        inDataDir,
      )
      expect(result.truncated).toBe(true)

      // The reader is handed a path, not just a stump of the output.
      const savedPath = yield* Effect.fromOption(result.savedPath)
      expect(savedPath.startsWith(`${dataDir}/shell-output/`)).toBe(true)

      const saved = yield* fs.readFileString(savedPath)
      // The whole output survives: the head the cap kept and the tail it cut.
      expect(saved).toContain("line 1\n")
      expect(saved).toContain(`line ${lineCount}`)
      expect(result.output).not.toContain(`line ${lineCount}`)
      // The header names the command that produced it.
      expect(saved).toContain(`# Command: seq 1 ${lineCount}`)

      yield* fs.remove(savedPath)
    }),
  )
})

// ── paste indicator ─────────────────────────────────────────────────────────

// The paste manager is per-controller: each composer owns its id counter and
// store, so every test makes its own rather than resetting shared state.

describe("paste placeholders", () => {
  test("a paste is large from three lines or 150 characters", () => {
    const cases: ReadonlyArray<readonly [string, boolean]> = [
      ["hello", false],
      ["line1\nline2", false],
      ["x".repeat(149), false],
      ["a\nb\nc", true],
      ["x".repeat(150), true],
      ["function example() {\n  return 1\n}", true],
    ]
    for (const [paste, large] of cases) {
      expect([paste, isLargePaste(paste)]).toEqual([paste, large])
    }
  })

  // The count follows the shared line rule: a final newline ends the last
  // line and starts none, as every other count in gent reads it.
  test("a placeholder names the paste's size, and each manager counts its own ids", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["line1\nline2\nline3", "[Pasted 3 lines #1]"],
      ["a\nb\nc\n", "[Pasted 3 lines #1]"],
      ["original content\nwith lines", "[Pasted 2 lines #1]"],
      ["x".repeat(200), "[Pasted 200 chars #1]"],
    ]
    for (const [paste, placeholder] of cases) {
      expect(createPasteManager().createPlaceholder(paste)).toBe(placeholder)
    }
    const paste = createPasteManager()
    expect(paste.createPlaceholder("a\nb\nc")).toBe("[Pasted 3 lines #1]")
    expect(paste.createPlaceholder("x\ny\nz")).toBe("[Pasted 3 lines #2]")
  })

  test("each placeholder expands to its paste until the store clears; other text passes through", () => {
    const paste = createPasteManager()
    const first = "first\npaste\ncontent"
    const line = "x".repeat(200)
    const p1 = paste.createPlaceholder(first)
    const p2 = paste.createPlaceholder(line)
    expect(paste.expandPlaceholders(`Start ${p1} middle ${p2} end`)).toBe(
      `Start ${first} middle ${line} end`,
    )
    // An undo can bring a chip back, so a second expansion still finds its paste.
    expect(paste.expandPlaceholders(p1)).toBe(first)
    for (const input of ["text with [Pasted 5 lines #99] placeholder", "plain text", ""]) {
      expect(paste.expandPlaceholders(input)).toBe(input)
    }
    const cleared = paste.createPlaceholder("a\nb\nc")
    paste.clear()
    expect(paste.expandPlaceholders(cleared)).toBe(cleared)
  })
})

// ── composer frame anchor ───────────────────────────────────────────────────

/**
 * The status row's right-hand labels hold their place.
 *
 * The row used to spend one left-to-right width budget and drop whatever did
 * not fit, with no indication. Adding the cwd silently removed the effort, the
 * context gauge and the running total — the labels a reader checks at a glance
 * without reading the row. The right group is now laid out first and keeps its
 * columns; the left group truncates instead.
 */

const muted = RGBA.fromHex("#888888")
const label = (text: string): StatusRowLabel => ({ text, color: muted })

/** Everything the real row carries, longest-plausible cwd included. */
const labels: StatusRowLabel[] = [
  label("idle"),
  label("some-very-long-project-name (feature/a-long-branch)"),
  label("Claude Sonnet 5"),
  label("medium"),
  label("ctx 42%"),
  label("$12.34"),
]

const frameText = (width: number, rightLabels: number) =>
  Effect.gen(function* () {
    const setup = yield* Effect.promise(() =>
      renderWithProviders(() => <StatusRow labels={labels} rightLabels={rightLabels} />, {
        width,
        height: 10,
      }),
    )
    yield* Effect.promise(() => setup.flush())
    return setup.captureCharFrame()
  })

describe("the status row anchors its right-hand labels", () => {
  it.live("keeps the running total when the row cannot fit everything", () =>
    Effect.gen(function* () {
      const text = yield* frameText(60, 2)
      // The two anchored labels survive a width that cannot hold the row.
      expect(text).toContain("$12.34")
      expect(text).toContain("ctx 42%")
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.live("drops the anchored labels when nothing reserves them", () =>
    Effect.gen(function* () {
      // Without a reservation the old behaviour returns: the last labels are
      // pushed off the end by everything before them.
      const text = yield* frameText(60, 0)
      expect(text).not.toContain("$12.34")
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.live("shows every label when the row is wide enough", () =>
    Effect.gen(function* () {
      const text = yield* frameText(140, 2)
      expect(text).toContain("idle")
      expect(text).toContain("Claude Sonnet 5")
      expect(text).toContain("ctx 42%")
      expect(text).toContain("$12.34")
    }).pipe(Effect.timeout("10 seconds")),
  )
})

// ── composer render ─────────────────────────────────────────────────────────

/**
 * Registers the `/` contribution the popup draws from. Without a contribution
 * `deriveAutocomplete` finds no prefixes and returns none, so no popup can
 * open and a test asserting on one would be asserting on the echoed draft.
 */
function Contribute() {
  const ui = useExtensionUI()
  ui.setDynamicAutocomplete([
    {
      prefix: "/",
      title: "Commands",
      items: () => [
        { id: "clear", label: "/clear", description: "Clear messages" },
        { id: "sessions", label: "/sessions", description: "Open sessions picker" },
      ],
    },
  ])
  return <box />
}
/** Draws a marker once every command source has answered. */
function CommandsSettled() {
  const ui = useExtensionUI()
  return (
    <Show when={ui.commandsSettled()}>
      <text>commands settled</text>
    </Show>
  )
}
/** Draws a marker once the client extensions contribute `count` sources on `prefix`. */
function SourcesLoaded(props: { readonly prefix: string; readonly count: number }) {
  const ui = useExtensionUI()
  const loaded = () =>
    ui.autocompleteItems().filter((c) => c.prefix === props.prefix).length >= props.count
  return (
    <Show when={loaded()}>
      <text>sources loaded</text>
    </Show>
  )
}
function TestComposer(props: {
  readonly suspended?: boolean
  readonly onSubmit: (
    content: string,
    mode: "queue" | "interject",
    target: SessionIdentity,
    requestId: string,
  ) => void
  /** What the send answers; a failure stands for a send the server rejected. */
  readonly sendResult?: Effect.Effect<void, GentClientRpcError>
  readonly children?: JSX.Element
  readonly composerState?: () => ComposerState
  readonly dispatchComposer?: (event: ComposerEvent) => void
}) {
  const [interactionState, setInteractionState] = createSignal(ComposerInteractionState.initial())
  const ext = useExtensionUI()
  const mockController = {
    itemsSettled: () => true,
    items: () => [],
    messages: () => [],
    forkMessages: () => [],
    queueState: () => ({ steering: [], followUp: [] }),
    interactionState,
    saveDraft: () => {},
    // Suspended: a session pane (the model picker) holds the composer.
    uiState: (): SessionUiState => {
      if (props.suspended !== true) return SessionUiState.initial()
      return { ...SessionUiState.initial(), overlay: { _tag: "model" } }
    },
    composerState: props.composerState ?? (() => ComposerState.idle()),
    promptSearch: {
      state: PromptSearchState.closed,
      entries: () => [],
      open: () => {},
      onEvent: () => {},
    },
    activity: () => ({ phase: "idle" }),
    phaseLabel: () => "idle",
    armedCue: () => Option.none(),
    elapsed: () => 0,
    // Production threads the live contributions here (session-controller.ts).
    // Dropping them makes every popup assertion vacuous, so the harness
    // matches the real call.
    onComposerInteraction: (event: Parameters<typeof transitionComposerInteraction>[1]) =>
      setInteractionState((current) =>
        transitionComposerInteraction(current, event, ext.autocompleteItems()),
      ),
    onSubmit: (
      content: string,
      mode: "queue" | "interject",
      target: SessionIdentity,
      requestId: string,
    ) =>
      Effect.sync(() => props.onSubmit(content, mode, target, requestId)).pipe(
        Effect.andThen(props.sendResult ?? Effect.void),
      ),
    onSlashCommand: () => Effect.void,
    // The command runs as given: this harness has no ctrl+c ladder to stop it.
    runShell: <A, E, R>(_command: string, run: Effect.Effect<A, E, R>) => run,
    onRestoreQueue: () => {},
    dispatchComposer: props.dispatchComposer ?? (() => {}),
    resolveAuthGate: () => {},
    closeOverlay: () => {},
    onForkSelect: () => {},
    onModelSelect: () => {},
    onReasoningSelect: () => {},
    currentSessionName: () => "Test Session",
    onBranchPickerSelect: () => {},
  } satisfies SessionController
  return (
    <SessionControllerContext.Provider value={mockController}>
      <Contribute />
      <Composer>{props.children}</Composer>
    </SessionControllerContext.Provider>
  )
}
type TestKeys = Effect.Success<ReturnType<typeof renderScoped>>["mockInput"]
const PASTE = "x".repeat(200)
describe("Composer renderer", () => {
  // Two extensions may contribute rows under one prefix. The row the reader
  // picks inserts and records through the extension that offered it.
  it.live("a pick from the second contribution on a prefix uses that contribution's hooks", () =>
    Effect.gen(function* () {
      const picks: Array<string> = []
      const source = (name: string, id: string) =>
        defineClientExtension(`@test/pick-${name}`, {
          setup: Effect.succeed(
            clientContributions(
              autocompleteContribution({
                prefix: "%",
                title: `Source ${name}`,
                items: () => [{ id, label: `%${id}` }],
                formatInsertion: (picked) => `<${name}:${picked}> `,
                onSelect: (picked) => {
                  picks.push(`${name}:${picked}`)
                },
              }),
            ),
          ),
        })
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <TestComposer onSubmit={() => {}}>
              <Composer.Autocomplete />
              <SourcesLoaded prefix="%" count={2} />
            </TestComposer>
          ),
          {
            builtins: [...builtinClientModules, source("first", "alpha"), source("second", "beta")],
          },
        ),
      )
      yield* waitForFrame(setup, (frame) => frame.includes("sources loaded"), "both sources")
      yield* Effect.promise(() => setup.mockInput.typeText("%"))
      yield* waitForFrame(
        setup,
        (frame) => frame.includes("%alpha") && frame.includes("%beta"),
        "rows from both sources",
      )
      setup.mockInput.pressArrow("down")
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressKey("RETURN")
      const frame = yield* waitForFrame(setup, (next) => next.includes("┃ <"), "the inserted pick")
      expect(frame).toContain("┃ <second:beta>")
      expect(picks).toEqual(["second:beta"])
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.live("a pending interaction waits for client extensions instead of being denied", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>()
      const held = defineClientExtension("@test/held-load", {
        setup: Deferred.await(release).pipe(Effect.as(clientContributions())),
      })
      const dispatched: Array<ComposerEvent["_tag"]> = []
      const interaction = {
        _tag: "InteractionPresented",
        sessionId: SessionId.make("s"),
        branchId: BranchId.make("b"),
        requestId: InteractionRequestId.make("req-pending"),
        text: "Ship the release?",
        metadata: { type: "ask-user", questions: [{ question: "Ship the release?" }] },
      } satisfies ActiveInteraction
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <TestComposer
              onSubmit={() => {}}
              composerState={() => ({ _tag: "interaction", interaction })}
              dispatchComposer={(event) => {
                dispatched.push(event._tag)
              }}
            />
          ),
          { builtins: [...builtinClientModules, held] },
        ),
      )
      yield* Effect.promise(() => setup.renderOnce())
      expect(dispatched).toEqual([])
      expect(renderFrame(setup)).not.toContain("Ship the release?")

      yield* Deferred.complete(release, Effect.void)
      // "Other:" is the ask-user renderer's free-text row: the fallback prompt has none.
      yield* waitForFrame(setup, (frame) => frame.includes("Other:"), "ask-user")
      expect(dispatched).toEqual([])
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.live("plain enter submits and clears the composer", () =>
    Effect.gen(function* () {
      const submitted: Array<{
        content: string
        mode?: "queue" | "interject"
      }> = []
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <TestComposer
            onSubmit={(content, mode) => {
              submitted.push({ content, mode })
            }}
          />
        )),
      )
      setup.mockInput.pressKeys(["h", "i"])
      yield* Effect.promise(() => setup.renderOnce())
      expect(renderFrame(setup)).toContain("┃ hi")
      setup.mockInput.pressKey("RETURN")
      yield* Effect.promise(() => setup.renderOnce())
      expect(submitted).toEqual([{ content: "hi", mode: "queue" }])
      expect(renderFrame(setup)).not.toContain("┃ hi")
    }),
  )
  // A large paste becomes a placeholder where the caret is. The draft around
  // it stays whole, so submit sends the text before the caret, the paste, and
  // the text after the caret, in that order.
  it.live("a large paste in the middle of the draft sends the exact text", () =>
    Effect.gen(function* () {
      const submitted: Array<string> = []
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <TestComposer onSubmit={(content) => submitted.push(content)} />),
      )
      const pasted = "one\ntwo\nthree\nfour\nfive"
      yield* Effect.promise(() => setup.mockInput.typeText("hello world"))
      for (let i = 0; i < 5; i++) setup.mockInput.pressArrow("left")
      yield* Effect.promise(() => setup.mockInput.pasteBracketedText(pasted))
      yield* Effect.promise(() => setup.renderOnce())
      expect(renderFrame(setup)).toContain("hello [Pasted 5 lines #1]world")
      setup.mockInput.pressKey("RETURN")
      yield* Effect.promise(() => setup.renderOnce())
      expect(submitted).toEqual([`hello ${pasted}world`])
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.live("a large paste over a selection replaces it and sends the exact text", () =>
    Effect.gen(function* () {
      const submitted: Array<string> = []
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <TestComposer onSubmit={(content) => submitted.push(content)} />),
      )
      const pasted = "one\ntwo\nthree\nfour\nfive"
      yield* Effect.promise(() => setup.mockInput.typeText("hello world"))
      for (let i = 0; i < 5; i++) setup.mockInput.pressArrow("left", { shift: true })
      yield* Effect.promise(() => setup.mockInput.pasteBracketedText(pasted))
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressKey("RETURN")
      yield* Effect.promise(() => setup.renderOnce())
      expect(submitted).toEqual([`hello ${pasted}`])
    }).pipe(Effect.timeout("10 seconds")),
  )
  // A terminal that sends Enter as CR pastes CR-separated lines. The paste is
  // the one place raw terminal bytes reach the draft, so the lines, the chip's
  // count, what the model reads and the ↑ recall all see `\n`.
  it.live("a large paste with CR line breaks sends real lines and recalls with ↑", () =>
    Effect.gen(function* () {
      const submitted: Array<string> = []
      const thrown: Array<unknown> = []
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <ErrorBoundary
            fallback={(error) => {
              thrown.push(error)
              return <text>render threw</text>
            }}
          >
            <TestComposer onSubmit={(content) => submitted.push(content)} />
          </ErrorBoundary>
        )),
      )
      const lines = Array.from(
        { length: 10 },
        (_, i) => `pasted line ${i + 1} from a terminal that sends CR`,
      )
      yield* Effect.promise(() => setup.mockInput.pasteBracketedText(lines.join("\r")))
      yield* Effect.promise(() => setup.renderOnce())
      expect(renderFrame(setup)).toContain("[Pasted 10 lines #1]")
      setup.mockInput.pressKey("RETURN")
      yield* Effect.promise(() => setup.renderOnce())
      expect(submitted).toEqual([lines.join("\n")])
      setup.mockInput.pressArrow("up")
      yield* Effect.promise(() => setup.renderOnce())
      expect(thrown).toEqual([])
      expect(renderFrame(setup)).toContain("┃ pasted line 2 from")
    }).pipe(Effect.timeout("10 seconds")),
  )
  // Up and down walk the prompts sent before, newest first; a prompt sent
  // twice in a row is one entry. Down past the newest gives back the draft
  // the walk started from.
  it.live("up recalls earlier prompts and down gives back the draft", () =>
    Effect.gen(function* () {
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <TestComposer onSubmit={() => {}} />),
      )
      const send = (text: string) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => setup.mockInput.typeText(text))
          setup.mockInput.pressKey("RETURN")
          yield* waitForFrame(setup, (frame) => !frame.includes(`┃ ${text}`), `sent ${text}`)
        })
      yield* send("alpha")
      yield* send("beta")
      yield* send("beta")
      const press = (direction: "up" | "down", shown: string) =>
        Effect.gen(function* () {
          setup.mockInput.pressArrow(direction)
          return yield* waitForFrame(setup, (frame) => frame.includes(shown), shown)
        })
      yield* press("up", "┃ beta")
      yield* press("up", "┃ alpha")
      // The oldest entry stays; there is no third.
      setup.mockInput.pressArrow("up")
      yield* Effect.promise(() => setup.renderOnce())
      expect(renderFrame(setup)).toContain("┃ alpha")
      yield* press("down", "┃ beta")
      const restored = yield* press("down", "┃")
      expect(restored).not.toContain("┃ beta")
      expect(restored).not.toContain("┃ alpha")
      yield* Effect.promise(() => setup.mockInput.typeText("draft"))
      yield* waitForFrame(setup, (frame) => frame.includes("┃ draft"), "the draft")
      // Up recalls only from the draft's start; elsewhere it moves the cursor.
      setup.mockInput.pressKey("a", { ctrl: true })
      yield* press("up", "┃ beta")
      yield* press("down", "┃ draft")
    }).pipe(Effect.timeout("10 seconds")),
  )
  // A chip is one unit: a delete at its end takes the whole chip and its
  // stored text, so no fragment of it reaches the model.
  it.live("backspace or ctrl+w at a paste chip's end removes the whole chip", () =>
    Effect.gen(function* () {
      const submitted: Array<string> = []
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <TestComposer onSubmit={(content) => submitted.push(content)} />),
      )
      const chip = "x".repeat(200)
      yield* Effect.promise(() => setup.mockInput.typeText("keep "))
      yield* Effect.promise(() => setup.mockInput.pasteBracketedText(chip))
      yield* Effect.promise(() => setup.renderOnce())
      expect(renderFrame(setup)).toContain("┃ keep [Pasted 200 chars #1]")
      setup.mockInput.pressBackspace()
      yield* Effect.promise(() => setup.renderOnce())
      expect(renderFrame(setup)).not.toContain("Pasted")
      yield* Effect.promise(() => setup.mockInput.pasteBracketedText(chip))
      yield* Effect.promise(() => setup.renderOnce())
      expect(renderFrame(setup)).toContain("┃ keep [Pasted 200 chars #2]")
      setup.mockInput.pressKey("w", { ctrl: true })
      yield* Effect.promise(() => setup.renderOnce())
      expect(renderFrame(setup)).not.toContain("Pasted")
      setup.mockInput.pressKey("RETURN")
      yield* Effect.promise(() => setup.renderOnce())
      expect(submitted).toEqual(["keep"])
    }).pipe(Effect.timeout("10 seconds")),
  )
  // The chip delete is one undo step. An undo brings the chip back, and the
  // chip still sends the paste it stands for.
  it.scopedLive("an undone chip delete sends the paste again", () =>
    Effect.gen(function* () {
      const submitted: Array<string> = []
      // ctrl+- (undo) has a spelling only in the kitty keyboard protocol.
      const setup = yield* renderScoped(
        () => <TestComposer onSubmit={(content) => submitted.push(content)} />,
        { kittyKeyboard: true },
      )
      const chip = "x".repeat(200)
      yield* Effect.promise(() => setup.mockInput.typeText("keep "))
      yield* Effect.promise(() => setup.mockInput.pasteBracketedText(chip))
      yield* waitForFrame(setup, (frame) => frame.includes("[Pasted 200 chars #1]"), "the chip")
      setup.mockInput.pressBackspace()
      yield* waitForFrame(setup, (frame) => !frame.includes("Pasted"), "the chip deleted")
      setup.mockInput.pressKey("-", { ctrl: true })
      yield* waitForFrame(
        setup,
        (frame) => frame.includes("[Pasted 200 chars #1]"),
        "the chip back",
      )
      setup.mockInput.pressKey("RETURN")
      yield* Effect.promise(() => setup.renderOnce())
      expect(submitted).toEqual([`keep ${chip}`])
    }).pipe(Effect.timeout("10 seconds")),
  )
  // The textarea counts its caret in its own units, not in string indices. A
  // wide or multi-byte character before the chip must not shift the delete.
  it.scopedLive("a chip after a wide or accented character deletes whole", () =>
    Effect.gen(function* () {
      for (const prefix of ["界 ", "é "]) {
        const submitted: Array<string> = []
        const setup = yield* renderScoped(() => (
          <TestComposer onSubmit={(content) => submitted.push(content)} />
        ))
        yield* Effect.promise(() => setup.mockInput.pasteBracketedText(prefix))
        yield* Effect.promise(() => setup.mockInput.pasteBracketedText("x".repeat(200)))
        yield* waitForFrame(setup, (frame) => frame.includes("[Pasted 200 chars #1]"), "the chip")
        setup.mockInput.pressBackspace()
        yield* waitForFrame(setup, (frame) => !frame.includes("[Pasted"), "the chip deleted")
        expect(renderFrame(setup)).not.toContain("[")
        // The caret stands where the chip began.
        yield* Effect.promise(() => setup.mockInput.typeText("z"))
        setup.mockInput.pressKey("RETURN")
        yield* Effect.promise(() => setup.renderOnce())
        expect(submitted).toEqual([`${prefix}z`])
      }
    }).pipe(Effect.timeout("10 seconds")),
  )
  // A caret inside a chip is still at the chip: a delete there takes the
  // whole chip, so no broken placeholder reaches the model.
  it.scopedLive("backspace or ctrl+w from inside a chip removes the whole chip", () =>
    Effect.gen(function* () {
      for (const wordDelete of [false, true]) {
        const submitted: Array<string> = []
        const setup = yield* renderScoped(() => (
          <TestComposer onSubmit={(content) => submitted.push(content)} />
        ))
        yield* Effect.promise(() => setup.mockInput.typeText("keep "))
        yield* Effect.promise(() => setup.mockInput.pasteBracketedText("x".repeat(200)))
        yield* Effect.promise(() => setup.mockInput.typeText(" tail"))
        yield* waitForFrame(
          setup,
          (frame) => frame.includes("[Pasted 200 chars #1] tail"),
          "the chip",
        )
        // Past " tail", then one step into the chip.
        for (let i = 0; i < 6; i++) setup.mockInput.pressArrow("left")
        if (wordDelete) setup.mockInput.pressKey("w", { ctrl: true })
        else setup.mockInput.pressBackspace()
        yield* waitForFrame(setup, (frame) => !frame.includes("Pasted"), "the chip deleted")
        expect(renderFrame(setup)).not.toContain("[")
        yield* Effect.promise(() => setup.mockInput.typeText("z"))
        setup.mockInput.pressKey("RETURN")
        yield* Effect.promise(() => setup.renderOnce())
        expect(submitted).toEqual(["keep z tail"])
      }
    }).pipe(Effect.timeout("10 seconds")),
  )
  /**
   * Draws `keep <chip> tail`, runs `move` to place the caret, presses `edit`,
   * and answers what Enter then sends. The kitty keyboard protocol spells the
   * modified Delete keys.
   */
  const editAtChip = (
    move: (keys: TestKeys) => void,
    edit: (keys: TestKeys) => Effect.Effect<unknown>,
  ) =>
    Effect.gen(function* () {
      const submitted: Array<string> = []
      const setup = yield* renderScoped(
        () => <TestComposer onSubmit={(content) => submitted.push(content)} />,
        { kittyKeyboard: true },
      )
      yield* Effect.promise(() => setup.mockInput.typeText("keep "))
      yield* Effect.promise(() => setup.mockInput.pasteBracketedText(PASTE))
      yield* Effect.promise(() => setup.mockInput.typeText(" tail"))
      yield* waitForFrame(
        setup,
        (frame) => frame.includes("[Pasted 200 chars #1] tail"),
        "the chip",
      )
      // From the line start: "keep " is five steps, and the chip starts there.
      setup.mockInput.pressKey("a", { ctrl: true })
      move(setup.mockInput)
      yield* edit(setup.mockInput)
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressKey("RETURN")
      yield* Effect.promise(() => setup.renderOnce())
      return submitted
    })
  const press = (key: (keys: TestKeys) => void) => (keys: TestKeys) => Effect.sync(() => key(keys))
  const toChipStart = (keys: TestKeys) => {
    for (let i = 0; i < 5; i++) keys.pressArrow("right")
  }
  const intoChip = (keys: TestKeys) => {
    for (let i = 0; i < 8; i++) keys.pressArrow("right")
  }
  // A forward delete at the chip's start or inside it takes the whole chip.
  it.scopedLive("delete, shift+delete or ctrl+d at or inside a chip removes the whole chip", () =>
    Effect.gen(function* () {
      const deletes: ReadonlyArray<(keys: TestKeys) => Effect.Effect<unknown>> = [
        press((keys) => keys.pressKey("DELETE")),
        press((keys) => keys.pressKey("DELETE", { shift: true })),
        press((keys) => keys.pressKey("d", { ctrl: true })),
      ]
      for (const move of [toChipStart, intoChip]) {
        for (const edit of deletes) {
          expect(yield* editAtChip(move, edit)).toEqual(["keep  tail"])
        }
      }
    }).pipe(Effect.timeout("20 seconds")),
  )
  it.scopedLive("a forward word delete at or inside a chip removes the whole chip", () =>
    Effect.gen(function* () {
      const deletes: ReadonlyArray<(keys: TestKeys) => Effect.Effect<unknown>> = [
        press((keys) => keys.pressKey("d", { meta: true })),
        press((keys) => keys.pressKey("DELETE", { meta: true })),
        press((keys) => keys.pressKey("DELETE", { ctrl: true })),
      ]
      for (const move of [toChipStart, intoChip]) {
        for (const edit of deletes) {
          expect(yield* editAtChip(move, edit)).toEqual(["keep  tail"])
        }
      }
    }).pipe(Effect.timeout("20 seconds")),
  )
  // A line delete from inside a chip takes the whole chip with the rest of its span.
  it.scopedLive("ctrl+k or ctrl+u from inside a chip takes the whole chip", () =>
    Effect.gen(function* () {
      expect(
        yield* editAtChip(
          intoChip,
          press((keys) => keys.pressKey("k", { ctrl: true })),
        ),
      ).toEqual(["keep"])
      expect(
        yield* editAtChip(
          intoChip,
          press((keys) => keys.pressKey("u", { ctrl: true })),
        ),
      ).toEqual(["tail"])
    }).pipe(Effect.timeout("10 seconds")),
  )
  // A caret inside a chip never edits its text: typed text lands after the chip.
  it.scopedLive("a character typed inside a chip goes after it, and the paste still sends", () =>
    Effect.gen(function* () {
      expect(
        yield* editAtChip(
          intoChip,
          press((keys) => keys.pressKey("q")),
        ),
      ).toEqual([`keep ${PASTE}q tail`])
      expect(
        yield* editAtChip(intoChip, (keys) => Effect.promise(() => keys.pasteBracketedText("pq"))),
      ).toEqual([`keep ${PASTE}pq tail`])
    }).pipe(Effect.timeout("10 seconds")),
  )
  // The editor gets the draft as it would be sent: a paste chip is its text,
  // so the paste can be edited there.
  it.scopedLive.layer(BunFileSystem.layer)(
    "ctrl+g opens the draft with each paste chip as its text",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "gent-composer-editor-" })
        const editorPath = `${dir}/editor.js`
        const seen = `${dir}/seen`
        // The editor copies what it was given and leaves the file as it is.
        yield* fs.writeFileString(
          editorPath,
          `await Bun.write("${seen}", await Bun.file(process.argv.at(-1)).text());`,
        )
        const setup = yield* renderScoped(() => (
          <EnvProvider
            env={{
              visual: Option.some(`bun ${editorPath}`),
              editor: Option.none(),
              shutdown: () => {},
              resumable: true,
              writeTerminal: () => {},
            }}
          >
            <TestComposer onSubmit={() => {}} />
          </EnvProvider>
        ))
        yield* Effect.promise(() => setup.mockInput.typeText("keep "))
        yield* Effect.promise(() => setup.mockInput.pasteBracketedText(PASTE))
        yield* waitForFrame(setup, (frame) => frame.includes("[Pasted"), "the paste chip")
        setup.mockInput.pressKey("g", { ctrl: true })
        yield* fs
          .exists(seen)
          .pipe(Effect.repeat({ until: (done) => done, schedule: Schedule.spaced("20 millis") }))
        expect(yield* fs.readFileString(seen)).toBe(`keep ${PASTE}`)
      }).pipe(Effect.timeout("10 seconds")),
  )
  it.live("suspended composer blocks enter submission", () =>
    Effect.gen(function* () {
      const submitted: string[] = []
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <TestComposer
            suspended
            onSubmit={(content) => {
              submitted.push(content)
            }}
          />
        )),
      )
      setup.mockInput.pressKeys(["h", "i"])
      setup.mockInput.pressKey("RETURN")
      yield* Effect.promise(() => setup.renderOnce())
      expect(submitted).toEqual([])
      expect(renderFrame(setup)).toContain("┃ hi")
    }),
  )
  it.scopedLive("slash trigger renders the command popup", () =>
    Effect.gen(function* () {
      const setup = yield* renderScoped(
        () => (
          <TestComposer onSubmit={() => {}}>
            <Composer.Autocomplete />
          </TestComposer>
        ),
        { width: 80, height: 24 },
      )
      yield* Effect.promise(() => setup.mockInput.typeText("/"))
      // The rows arrive through a resource, so the frame is polled rather than
      // rendered once.
      yield* waitForFrame(setup, (frame) => frame.includes("/sessions"), "command rows")
      const frame = renderFrame(setup)
      // Assert the popup itself: its title, both contributed rows, and the
      // footer it draws. A bare `toContain("/")` passes on the slash echoed in
      // the composer, so it holds even with no popup mounted at all.
      expect(frame).toContain("Commands")
      expect(frame).toContain("/clear")
      expect(frame).toContain("Clear messages")
      expect(frame).toContain("/sessions")
      // The footer names both keys because they do different things: enter
      // runs the command it completes, tab only completes it.
      expect(frame).toContain("enter select")
      expect(frame).toContain("tab complete")
    }),
  )
})

// ── composer submit ─────────────────────────────────────────────────────────

/**
 * Submit takes the draft before any async work: a second Enter while a
 * `!cmd` runs or `@file` refs expand finds an empty composer. `@file` and
 * `!cmd` resolve against the session's directory, which a resumed or switched
 * session does not share with the TUI's launch directory.
 */

const submitTest = it.scopedLive.layer(testLayer)

const refusedSend = Schema.decodeSync(GentRpcError)({
  _tag: "InvalidStateError",
  message: "send refused",
})

/** A session rooted in `cwd`, as `session.get` returns it. */
const storedSessionIn = (cwd: string) => ({
  id: SessionId.make("session-elsewhere"),
  name: "Elsewhere",
  cwd,
  activeBranchId: BranchId.make("branch-elsewhere"),
  createdAt: dateFromMillis(0),
  updatedAt: dateFromMillis(0),
})

describe("Composer submit", () => {
  submitTest("@file resolves against the session's directory, not the launch directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const launchDir = yield* fs.makeTempDirectoryScoped()
      const sessionDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${launchDir}/notes.md`, "LAUNCH COPY")
      yield* fs.writeFileString(`${sessionDir}/notes.md`, "SESSION COPY")
      const submitted: Array<string> = []
      // The session is reached by id alone, so its record names no cwd and the
      // composer reads it from the server.
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => <TestComposer onSubmit={(content) => submitted.push(content)} />,
          {
            cwd: launchDir,
            client: createMockClient({
              session: { get: () => Effect.succeed(storedSessionIn(sessionDir)) },
            }),
            initialSession: {
              sessionId: SessionId.make("session-elsewhere"),
              branchId: BranchId.make("branch-elsewhere"),
              name: "Elsewhere",
            },
          },
        ),
      )
      yield* Effect.promise(() => setup.mockInput.typeText("see @notes.md"))
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, () => submitted.length === 1, "submitted")
      expect(submitted[0]).toContain("SESSION COPY")
      expect(submitted[0]).not.toContain("LAUNCH COPY")
    }).pipe(Effect.timeout("10 seconds")),
  )

  submitTest(
    "a switch while @file expands leaves the message in the session it was drafted in",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        yield* fs.writeFileString(`${dir}/notes.md`, "notes body")
        // The drafted-in session names no cwd, so the submit reads it from the
        // server; the read waits on a gate the test opens after the switch.
        const gate = yield* Deferred.make<void>()
        const sent: Array<{ content: string; target: SessionIdentity }> = []
        let client = Option.none<ClientContextValue>()
        const CaptureClient = () => {
          client = Option.some(useClient())
          return <box />
        }
        const setup = yield* Effect.promise(() =>
          renderWithProviders(
            () => (
              <TestComposer onSubmit={(content, _mode, target) => sent.push({ content, target })}>
                <CaptureClient />
              </TestComposer>
            ),
            {
              cwd: dir,
              client: createMockClient({
                session: {
                  get: () => Deferred.await(gate).pipe(Effect.as(storedSessionIn(dir))),
                },
              }),
            },
          ),
        )
        yield* Effect.promise(() => setup.mockInput.typeText("see @notes.md"))
        yield* Effect.promise(() => setup.renderOnce())
        setup.mockInput.pressEnter()
        yield* Effect.promise(() => setup.renderOnce())
        if (Option.isNone(client)) return yield* Effect.die("the client never mounted")
        client.value.switchSession(SessionId.make("other"), BranchId.make("other-branch"), "Other")
        yield* Deferred.succeed(gate, void 0)
        yield* waitForFrame(setup, () => sent.length === 1, "submitted")
        expect(sent[0]?.content).toContain("notes body")
        expect(sent[0]?.target).toEqual({
          sessionId: draftSession.sessionId,
          branchId: draftSession.branchId,
        })
      }).pipe(Effect.timeout("10 seconds")),
  )

  submitTest("!cmd runs in the session's directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const launchDir = yield* fs.makeTempDirectoryScoped()
      const sessionDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${sessionDir}/marker-session.txt`, "")
      const submitted: Array<string> = []
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => <TestComposer onSubmit={(content) => submitted.push(content)} />,
          {
            cwd: launchDir,
            initialSession: {
              sessionId: SessionId.make("session-elsewhere"),
              branchId: BranchId.make("branch-elsewhere"),
              name: "Elsewhere",
              cwd: sessionDir,
            },
          },
        ),
      )
      yield* Effect.promise(() => setup.mockInput.typeText("!"))
      yield* Effect.promise(() => setup.mockInput.typeText("ls"))
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, () => submitted.length === 1, "submitted")
      expect(submitted[0]).toContain("marker-session.txt")
    }).pipe(Effect.timeout("10 seconds")),
  )

  // A resumed session can be rooted in a directory that is gone. The spawn
  // fails, and the reader gets the command back with the reason.
  submitTest("!cmd in a session whose directory is gone restores the draft and shows why", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const launchDir = yield* fs.makeTempDirectoryScoped()
      const submitted: Array<string> = []
      let client = Option.none<ClientContextValue>()
      const CaptureClient = () => {
        client = Option.some(useClient())
        return <box />
      }
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <TestComposer onSubmit={(content) => submitted.push(content)}>
              <CaptureClient />
            </TestComposer>
          ),
          {
            cwd: launchDir,
            initialSession: {
              sessionId: SessionId.make("session-gone"),
              branchId: BranchId.make("branch-gone"),
              name: "Gone",
              cwd: "/nonexistent/gent-probe-x",
            },
          },
        ),
      )
      yield* Effect.promise(() => setup.mockInput.typeText("!"))
      yield* Effect.promise(() => setup.mockInput.typeText("echo hi"))
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* waitForFrame(
        setup,
        () => Option.exists(client, (c) => Option.exists(c.error(), (m) => m.startsWith("Shell:"))),
        "error shown",
      )
      yield* waitForFrame(setup, (frame) => frame.includes("echo hi"), "draft restored")
      expect(submitted).toEqual([])
    }).pipe(Effect.timeout("10 seconds")),
  )

  // A command as long as a paste comes back as its text, not a placeholder:
  // the reader sees the command Enter would run.
  submitTest("a long refused !cmd comes back as the command, not a paste placeholder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const launchDir = yield* fs.makeTempDirectoryScoped()
      let client = Option.none<ClientContextValue>()
      const CaptureClient = () => {
        client = Option.some(useClient())
        return <box />
      }
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <TestComposer onSubmit={() => {}}>
              <CaptureClient />
            </TestComposer>
          ),
          {
            cwd: launchDir,
            initialSession: {
              sessionId: SessionId.make("session-gone-long"),
              branchId: BranchId.make("branch-gone-long"),
              name: "Gone",
              cwd: "/nonexistent/gent-probe-x",
            },
          },
        ),
      )
      yield* Effect.promise(() => setup.mockInput.typeText("!"))
      yield* Effect.promise(() => setup.mockInput.typeText(`echo ${"z".repeat(160)}`))
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* waitForFrame(
        setup,
        () => Option.exists(client, (c) => Option.exists(c.error(), (m) => m.startsWith("Shell:"))),
        "error shown",
      )
      const frame = yield* waitForFrame(
        setup,
        (current) => current.includes("$ echo") && current.includes("zzzzzzzzzz"),
        "command restored",
      )
      expect(frame).not.toContain("[Pasted")
    }).pipe(Effect.timeout("10 seconds")),
  )

  submitTest("a second Enter while !cmd runs neither runs it again nor sends twice", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      // The command waits for a gate file, so it is still running when the
      // second Enter arrives. The finalizer opens the gate on every exit.
      yield* Effect.addFinalizer(() => Effect.ignore(fs.writeFileString(`${dir}/go`, "")))
      const submitted: Array<string> = []
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => <TestComposer onSubmit={(content) => submitted.push(content)} />,
          {
            cwd: dir,
          },
        ),
      )
      yield* Effect.promise(() => setup.mockInput.typeText("!"))
      yield* Effect.promise(() =>
        setup.mockInput.typeText("until [ -e go ]; do sleep 0.02; done; echo ran >> count"),
      )
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      // The draft left the composer when the command started.
      expect(renderFrame(setup)).not.toContain("until")
      setup.mockInput.pressEnter()
      yield* fs.writeFileString(`${dir}/go`, "")
      yield* waitForFrame(setup, () => submitted.length === 1, "submitted")
      expect(submitted).toHaveLength(1)
      expect(yield* fs.readFileString(`${dir}/count`)).toBe("ran\n")
    }).pipe(Effect.timeout("10 seconds")),
  )

  // The command ran and its side effects are done; only the send of its output
  // was refused. What comes back is that output as a message, not the command,
  // so Enter sends it instead of running the command a second time.
  submitTest("a refused send of a !cmd's output restores the output, not the command", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      const submitted: Array<string> = []
      let sends = 0
      // The first send is refused; the next one lands.
      const sendResult = Effect.suspend(() => {
        sends++
        if (sends === 1) return Effect.fail(refusedSend)
        return Effect.void
      })
      let client = Option.none<ClientContextValue>()
      const CaptureClient = () => {
        client = Option.some(useClient())
        return <box />
      }
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <TestComposer onSubmit={(content) => submitted.push(content)} sendResult={sendResult}>
              <CaptureClient />
            </TestComposer>
          ),
          { cwd: dir },
        ),
      )
      yield* Effect.promise(() => setup.mockInput.typeText("!"))
      yield* Effect.promise(() => setup.mockInput.typeText("echo ran >> count; printf tu1-out"))
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* waitForFrame(
        setup,
        () =>
          Option.exists(client, (c) => Option.exists(c.error(), (m) => m.includes("send refused"))),
        "error shown",
      )
      // The reason says the command ran, so the reader does not run it again.
      const reason = Option.flatMap(client, (c) => c.error())
      expect(Option.exists(reason, (m) => m.includes("ran"))).toBe(true)
      // The output is as large as a paste, so it comes back as a placeholder.
      yield* waitForFrame(setup, (frame) => frame.includes("[Pasted 3 lines"), "output restored")
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, () => sends === 2, "sent again")
      expect(submitted[1]).toBe(submitted[0])
      expect(submitted[1]).toContain("tu1-out")
      expect(yield* fs.readFileString(`${dir}/count`)).toBe("ran\n")
    }).pipe(Effect.timeout("10 seconds")),
  )

  // The draft left the composer at submit. A send the server rejects puts it
  // back and says why, in the error line rather than as a connection issue.
  submitTest("a send the server rejects restores the draft and shows the reason", () =>
    Effect.gen(function* () {
      let client = Option.none<ClientContextValue>()
      const CaptureClient = () => {
        client = Option.some(useClient())
        return <box />
      }
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <TestComposer
            onSubmit={() => {}}
            sendResult={Effect.fail(
              Schema.decodeSync(GentRpcError)({
                _tag: "InvalidStateError",
                message: "send refused",
              }),
            )}
          >
            <CaptureClient />
          </TestComposer>
        )),
      )
      yield* Effect.promise(() => setup.mockInput.typeText("keep me"))
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* waitForFrame(
        setup,
        () =>
          Option.exists(client, (c) => Option.exists(c.error(), (m) => m.includes("send refused"))),
        "error shown",
      )
      yield* waitForFrame(setup, (frame) => frame.includes("keep me"), "draft restored")
    }).pipe(Effect.timeout("10 seconds")),
  )

  // The reader pasted while a send was out. The refusal joins the draft and
  // leaves the paste as its placeholder; the paste expands only at submit.
  submitTest("a refusal keeps the reader's paste placeholder in the draft", () =>
    Effect.gen(function* () {
      const reply = yield* Deferred.make<void>()
      const submitted: Array<string> = []
      let sends = 0
      const sendResult = Effect.suspend(() => {
        sends++
        if (sends === 1) return Deferred.await(reply).pipe(Effect.andThen(Effect.fail(refusedSend)))
        return Effect.void
      })
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <TestComposer onSubmit={(content) => submitted.push(content)} sendResult={sendResult} />
        )),
      )
      yield* Effect.promise(() => setup.mockInput.typeText("first send"))
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, () => sends === 1, "first send out")
      const pasted = "one\ntwo\nthree\nfour\nfive"
      yield* Effect.promise(() => setup.mockInput.pasteBracketedText(pasted))
      yield* waitForFrame(setup, (frame) => frame.includes("[Pasted 5 lines"), "placeholder")
      yield* Deferred.complete(reply, Effect.void)
      const frame = yield* waitForFrame(
        setup,
        (text) => text.includes("first send"),
        "refused back",
      )
      expect(frame).toContain("[Pasted 5 lines #1]")
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, () => sends === 2, "sent again")
      expect(submitted[1]).toBe(`first send\n\n${pasted}`)
    }).pipe(Effect.timeout("10 seconds")),
  )

  // The server admitted the send and ran its turn, but every reply was lost.
  // The text comes back, and Enter sends it again under the first request id,
  // so the server's dedup makes it one message. An edited text is a new one.
  submitTest("a send whose reply was lost goes again under its first request id", () =>
    Effect.gen(function* () {
      const admitted = new Map<string, string>()
      const ids: Array<string> = []
      let sends = 0
      const lost = new RpcClientError({ reason: new SocketCloseError({ code: 1006 }) })
      const sendResult = Effect.suspend(() => {
        sends++
        if (sends === 1) return Effect.fail(lost)
        return Effect.void
      })
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <TestComposer
            onSubmit={(content, _mode, _target, requestId) => {
              ids.push(requestId)
              // The server's dedup: one message per request id.
              if (!admitted.has(requestId)) admitted.set(requestId, content)
            }}
            sendResult={sendResult}
          />
        )),
      )
      yield* Effect.promise(() => setup.mockInput.typeText("send once"))
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, (frame) => frame.includes("┃ send once"), "text back")
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, () => sends === 2, "sent again")
      expect(ids).toHaveLength(2)
      expect(ids[1]).toBe(ids[0])
      expect([...admitted.values()]).toEqual(["send once"])
    }).pipe(Effect.timeout("10 seconds")),
  )

  submitTest("an edited text whose reply was lost goes as a new request", () =>
    Effect.gen(function* () {
      const ids: Array<string> = []
      let sends = 0
      const lost = new RpcClientError({ reason: new SocketCloseError({ code: 1006 }) })
      const sendResult = Effect.suspend(() => {
        sends++
        if (sends === 1) return Effect.fail(lost)
        return Effect.void
      })
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <TestComposer
            onSubmit={(_content, _mode, _target, requestId) => ids.push(requestId)}
            sendResult={sendResult}
          />
        )),
      )
      yield* Effect.promise(() => setup.mockInput.typeText("send once"))
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, (frame) => frame.includes("┃ send once"), "text back")
      yield* Effect.promise(() => setup.mockInput.typeText(" more"))
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, () => sends === 2, "sent again")
      expect(ids).toHaveLength(2)
      expect(ids[1]).not.toBe(ids[0])
    }).pipe(Effect.timeout("10 seconds")),
  )

  submitTest("a refused send goes again under a new request id", () =>
    Effect.gen(function* () {
      const ids: Array<string> = []
      let sends = 0
      const sendResult = Effect.suspend(() => {
        sends++
        if (sends === 1) return Effect.fail(refusedSend)
        return Effect.void
      })
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <TestComposer
            onSubmit={(_content, _mode, _target, requestId) => ids.push(requestId)}
            sendResult={sendResult}
          />
        )),
      )
      yield* Effect.promise(() => setup.mockInput.typeText("send again"))
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, (frame) => frame.includes("┃ send again"), "text back")
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, () => sends === 2, "sent again")
      expect(ids).toHaveLength(2)
      expect(ids[1]).not.toBe(ids[0])
    }).pipe(Effect.timeout("10 seconds")),
  )

  // Two sends in flight, both refused, the later one first: neither text is
  // lost, and the composer holds them in the order they were sent.
  submitTest("two refused sends both come back, in the order they were sent", () =>
    Effect.gen(function* () {
      const firstReply = yield* Deferred.make<void>()
      const secondReply = yield* Deferred.make<void>()
      const replies = [firstReply, secondReply]
      let calls = 0
      const refused = refusedSend
      const sendResult = Effect.suspend(() => {
        const reply = Option.fromUndefinedOr(replies[calls++])
        if (Option.isNone(reply)) return Effect.fail(refused)
        return Deferred.await(reply.value).pipe(Effect.andThen(Effect.fail(refused)))
      })
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <TestComposer onSubmit={() => {}} sendResult={sendResult} />),
      )
      yield* Effect.promise(() => setup.mockInput.typeText("first send"))
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, () => calls === 1, "first send out")
      yield* Effect.promise(() => setup.mockInput.typeText("second send"))
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, () => calls === 2, "second send out")
      yield* Deferred.complete(secondReply, Effect.void)
      yield* waitForFrame(setup, (frame) => frame.includes("second send"), "second back")
      yield* Deferred.complete(firstReply, Effect.void)
      const frame = yield* waitForFrame(
        setup,
        (text) => text.includes("first send") && text.includes("second send"),
        "both back",
      )
      expect(frame.indexOf("first send")).toBeLessThan(frame.indexOf("second send"))
    }).pipe(Effect.timeout("10 seconds")),
  )

  submitTest("a second Enter while @file refs expand does not send twice", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${dir}/notes.md`, "notes body")
      const submitted: Array<string> = []
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => <TestComposer onSubmit={(content) => submitted.push(content)} />,
          {
            cwd: dir,
          },
        ),
      )
      yield* Effect.promise(() => setup.mockInput.typeText("see @notes.md"))
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, () => submitted.length >= 1, "submitted")
      // Both expansions would start together; a second send lands within this bound.
      const second = yield* waitForFrame(
        setup,
        () => submitted.length >= 2,
        "second send",
        300,
      ).pipe(Effect.option)
      expect(Option.isNone(second)).toBe(true)
      expect(submitted).toHaveLength(1)
      expect(submitted[0]).toContain("notes body")
    }).pipe(Effect.timeout("10 seconds")),
  )
})

// ── autocomplete popup ──────────────────────────────────────────────────────

/**
 * The autocomplete popup under the composer: its rows come from extension
 * contributions, its cursor is the shared list's, and its keys are the
 * composer's whenever it has nothing to select.
 *
 * Enter and tab act on the same row through different props. The popup is the
 * last place that still knows which key arrived, so it reports them apart:
 * `onSelect` for enter, `onComplete` for tab. Collapsing the two is what made
 * tab run commands instead of completing them.
 */

const slashItems: ReadonlyArray<AutocompleteItem> = [
  { id: "alpha", label: "/alpha", description: "first" },
  { id: "beta", label: "/beta" },
  { id: "gamma", label: "/gamma" },
]

/** Registers the slash contribution before the popup mounts and fetches. */
function ContributePopup(props: { readonly items: ReadonlyArray<AutocompleteItem> }) {
  const ui = useExtensionUI()
  ui.setDynamicAutocomplete([{ prefix: "/", title: "Commands", items: () => props.items }])
  return <box />
}

/** A handler under the popup: sees only the keys the popup leaves alone. */
function KeyProbe(props: { readonly onKey: (name: string) => void }) {
  useScopedKeyboard((event) => {
    props.onKey(event.name)
    return false
  })
  return <box />
}

describe("AutocompletePopup renderer", () => {
  it.live("each open tells the source once, before its first fetch", () =>
    Effect.gen(function* () {
      const seen: Array<string> = []
      const [open, setOpen] = createSignal(true)
      const [filter, setFilter] = createSignal("src/")
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => {
            const ui = useExtensionUI()
            ui.setDynamicAutocomplete([
              {
                prefix: "@",
                title: "Files",
                onOpen: () => seen.push("open"),
                items: (typed) => {
                  seen.push(`items ${typed}`)
                  return [{ id: `${typed}x`, label: `@${typed}x` }]
                },
              },
            ])
            return (
              <Show when={open()}>
                <AutocompletePopup
                  state={{ type: "@", filter: filter(), triggerPos: 0 }}
                  onSelect={() => {}}
                  onComplete={() => {}}
                  onClose={() => {}}
                  onGhostChange={() => {}}
                />
              </Show>
            )
          },
          { width: 80, height: 24 },
        ),
      )
      yield* waitForFrame(setup, (frame) => frame.includes("@src/x"), "first open")
      setFilter("src/a")
      yield* waitForFrame(setup, (frame) => frame.includes("@src/ax"), "typed key")
      setOpen(false)
      yield* Effect.promise(() => setup.renderOnce())
      setOpen(true)
      yield* waitForFrame(setup, (frame) => frame.includes("@src/ax"), "second open")
      expect(seen).toEqual(["open", "items src/", "items src/a", "open", "items src/a"])
    }),
  )

  it.live("enter picks the row under the cursor and tab completes it", () =>
    Effect.gen(function* () {
      const picked: Array<string> = []
      const completed: Array<string> = []
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <ContributePopup items={slashItems} />
              <AutocompletePopup
                state={{ type: "/", filter: "", triggerPos: 0 }}
                onSelect={(pick) => picked.push(pick.item.id)}
                onComplete={(pick) => completed.push(pick.item.id)}
                onClose={() => {}}
                onGhostChange={() => {}}
              />
            </>
          ),
          { width: 80, height: 24 },
        ),
      )
      yield* waitForFrame(setup, (frame) => frame.includes("/gamma"), "items")
      // Tab acts on the row enter would, and reports through the completion prop.
      setup.mockInput.pressArrow("down")
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressTab()
      expect(completed).toEqual(["beta"])
      expect(picked).toEqual([])
      setup.mockInput.pressEnter()
      expect(picked).toEqual(["beta"])
    }),
  )

  it.live("the ghost names the row tab completes after the cursor moves", () =>
    Effect.gen(function* () {
      const items: ReadonlyArray<AutocompleteItem> = [
        { id: "model", label: "/model" },
        { id: "monitor", label: "/monitor" },
      ]
      const ghosts: Array<string> = []
      const completed: Array<string> = []
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <ContributePopup items={items} />
              <AutocompletePopup
                state={{ type: "/", filter: "mo", triggerPos: 0 }}
                onSelect={() => {}}
                onComplete={(pick) => completed.push(pick.item.id)}
                onClose={() => {}}
                onGhostChange={(ghost) => ghosts.push(Option.getOrElse(ghost, () => ""))}
              />
            </>
          ),
          { width: 80, height: 24 },
        ),
      )
      yield* waitForFrame(setup, (frame) => frame.includes("/monitor"), "items")
      expect(ghosts.at(-1)).toBe("model")
      setup.mockInput.pressArrow("down")
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressTab()
      expect(completed).toEqual(["monitor"])
      expect(ghosts.at(-1)).toBe("monitor")
    }),
  )
  it.live("a query typed in the composer after the cursor moved selects the top match", () =>
    Effect.gen(function* () {
      const names = ["agents", "branch", "btw", "model", "mermaid", "new"]
      const [filter, setFilter] = createSignal("")
      const picked: Array<string> = []
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => {
            const ui = useExtensionUI()
            ui.setDynamicAutocomplete([
              {
                prefix: "/",
                title: "Commands",
                items: (typed) =>
                  names
                    .values()
                    .filter((name) => name.startsWith(typed))
                    .map((name) => ({ id: name, label: `/${name}` }))
                    .toArray(),
              },
            ])
            return (
              <AutocompletePopup
                state={{ type: "/", filter: filter(), triggerPos: 0 }}
                onSelect={(pick) => picked.push(pick.item.id)}
                onComplete={() => {}}
                onClose={() => {}}
                onGhostChange={() => {}}
              />
            )
          },
          { width: 80, height: 24 },
        ),
      )
      yield* waitForFrame(setup, (frame) => frame.includes("/new"), "items")
      for (let press = 0; press < 5; press++) setup.mockInput.pressArrow("down")
      yield* Effect.promise(() => setup.renderOnce())
      // The composer narrows the rows to branch and btw; the top match is branch.
      setFilter("b")
      yield* waitForFrame(setup, (frame) => !frame.includes("/new"), "narrowed")
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      expect(picked).toEqual(["branch"])
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.live("leaves every key to the composer while it has nothing to select", () =>
    Effect.gen(function* () {
      const picked: Array<string> = []
      const seen: Array<string> = []
      let closed = 0
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <KeyProbe onKey={(name) => seen.push(name)} />
              <ContributePopup items={[]} />
              <AutocompletePopup
                state={{ type: "/", filter: "zzz", triggerPos: 0 }}
                onSelect={(pick) => picked.push(pick.item.id)}
                onComplete={(pick) => picked.push(pick.item.id)}
                onClose={() => {
                  closed += 1
                }}
                onGhostChange={() => {}}
              />
            </>
          ),
          { width: 80, height: 24 },
        ),
      )
      yield* waitForFrame(setup, (frame) => frame.includes("No matches"), "empty")
      setup.mockInput.pressEnter()
      setup.mockInput.pressArrow("down")
      yield* Effect.promise(() => setup.renderOnce())
      expect(picked).toEqual([])
      expect(seen).toEqual(["return", "down"])
      // Escape still closes the popup.
      setup.mockInput.pressEscape()
      yield* waitForFrame(setup, () => closed === 1, "closed")
      expect(seen).toEqual(["return", "down"])
    }),
  )
})

// ── composer ghost ──────────────────────────────────────────────────────────

/**
 * The ghost line: the completion Tab would take, drawn muted under the input.
 *
 * It lives on a row of its own rather than inside the buffer. The buffer's
 * own virtual-text facility cannot draw it — marks created with `virtual: true`
 * are stored but never rendered, and holding one across an edit breaks undo —
 * and a ghost drawn beside a shrink-to-fit textarea is split mid-word by the
 * first wrap. A separate row survives wrapping and, more importantly, keeps
 * the draft exactly what the reader typed: the ghost is never in the buffer,
 * so no submit path can carry it.
 *
 * What the ghost shows is the top-ranked row, which is the row Tab completes.
 * The two cannot disagree, because both read the same ranked list.
 */

/** The commands that reproduce the `/ag` ordering problem in the live registry. */
function RegisterCommandsGhost() {
  const ui = useExtensionUI()
  onMount(() => {
    ui.setSessionCommands([
      { id: "message.fork", title: "Fork from Message", slash: "fork", onSelect: () => {} },
      { id: "auth.manage", title: "Manage API Keys", slash: "auth", onSelect: () => {} },
      { id: "agents.view", title: "Agents", slash: "agents", onSelect: () => {} },
      { id: "session.model", title: "Set Model", slash: "model", onSelect: () => {} },
    ])
  })
  return <box />
}

/** The `/` contribution, ranked exactly as the session registry ranks it. */
function ContributeGhost() {
  const ui = useExtensionUI()
  ui.setDynamicAutocomplete([
    {
      prefix: "/",
      title: "Commands",
      items: (filter: string) =>
        rankAutocompleteItems(
          ui.commands().flatMap((c) =>
            Option.match(Option.fromNullishOr(c.slash), {
              onNone: () => [],
              onSome: (slash) => [{ id: slash, label: `/${slash}`, description: c.title }],
            }),
          ),
          filter,
        ),
    },
  ])
  return <box />
}

function TestComposerGhost(props: {
  readonly onSubmit: (text: string) => void
  readonly children?: JSX.Element
}) {
  const [interactionState, setInteractionState] = createSignal(ComposerInteractionState.initial())
  const ext = useExtensionUI()
  const mockController = {
    itemsSettled: () => true,
    items: () => [],
    messages: () => [],
    forkMessages: () => [],
    queueState: () => ({ steering: [], followUp: [] }),
    interactionState,
    saveDraft: () => {},
    uiState: SessionUiState.initial,
    composerState: () => ComposerState.idle(),
    promptSearch: {
      state: PromptSearchState.closed,
      entries: () => [],
      open: () => {},
      onEvent: () => {},
    },
    activity: () => ({ phase: "idle" }),
    phaseLabel: () => "idle",
    armedCue: () => Option.none(),
    elapsed: () => 0,
    onComposerInteraction: (event: Parameters<typeof transitionComposerInteraction>[1]) =>
      setInteractionState((current) =>
        transitionComposerInteraction(current, event, ext.autocompleteItems()),
      ),
    onSubmit: (text: string) => Effect.sync(() => props.onSubmit(text)),
    onSlashCommand: () => Effect.void,
    // The command runs as given: this harness has no ctrl+c ladder to stop it.
    runShell: <A, E, R>(_command: string, run: Effect.Effect<A, E, R>) => run,
    onRestoreQueue: () => {},
    dispatchComposer: () => {},
    resolveAuthGate: () => {},
    closeOverlay: () => {},
    onForkSelect: () => {},
    onModelSelect: () => {},
    onReasoningSelect: () => {},
    currentSessionName: () => "Test Session",
    onBranchPickerSelect: () => {},
  } satisfies SessionController
  return (
    <SessionControllerContext.Provider value={mockController}>
      <RegisterCommandsGhost />
      <ContributeGhost />
      <Composer>{props.children}</Composer>
    </SessionControllerContext.Provider>
  )
}

const mount = (submitted: Array<string>) =>
  Effect.promise(() =>
    renderWithProviders(
      () => (
        <TestComposerGhost
          onSubmit={(text) => {
            submitted.push(text)
          }}
        >
          <Composer.Autocomplete />
        </TestComposerGhost>
      ),
      { width: 80, height: 24 },
    ),
  )

describe("Composer ghost line", () => {
  it.live("offers the top-ranked completion for a partial name", () =>
    Effect.gen(function* () {
      const submitted: Array<string> = []
      const setup = yield* mount(submitted)
      yield* Effect.promise(() => setup.mockInput.typeText("/ag"))
      // `agents` is the ghost because it is the top row. Before ranking, the
      // top row was `/fork` — a ghost then would have offered the wrong word.
      yield* waitForFrame(setup, (frame) => frame.includes("agents ⇥"), "ghost")
    }),
  )

  it.live("withdraws the ghost when the filter matches nothing", () =>
    Effect.gen(function* () {
      const submitted: Array<string> = []
      const setup = yield* mount(submitted)
      yield* Effect.promise(() => setup.mockInput.typeText("/ag"))
      yield* waitForFrame(setup, (frame) => frame.includes("agents ⇥"), "ghost")
      // `/agzz` matches no command, so there is nothing to offer.
      yield* Effect.promise(() => setup.mockInput.typeText("zz"))
      yield* waitForFrame(setup, (frame) => !frame.includes("agents ⇥"), "ghost withdrawn")
    }),
  )

  it.live("shows no ghost once the name is fully typed", () =>
    Effect.gen(function* () {
      const submitted: Array<string> = []
      const setup = yield* mount(submitted)
      yield* Effect.promise(() => setup.mockInput.typeText("/agents"))
      yield* waitForFrame(setup, (frame) => frame.includes("/agents"), "draft")
      // There is no remainder left to offer, so the row stays empty.
      expect(renderFrame(setup)).not.toContain("agents ⇥")
    }),
  )

  it.live("never submits the ghost as text", () =>
    Effect.gen(function* () {
      const submitted: Array<string> = []
      const setup = yield* mount(submitted)
      // `@` has no dispatch path, so Enter here submits the draft verbatim —
      // the cleanest place to prove the ghost is not part of it.
      yield* Effect.promise(() => setup.mockInput.typeText("hello wor"))
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      expect(submitted).toEqual(["hello wor"])
    }),
  )
})

// ── composer slash enter ────────────────────────────────────────────────────

/**
 * Enter on a slash command name runs it.
 *
 * Completing `/agents` used to insert `/agents ` — a trailing space — and wait
 * for a second Enter before dispatching. Every slash command treats an empty
 * argument as "open my picker" or "show usage", so naming one is already a
 * full invocation and the first Enter dispatches it.
 *
 * The other autocomplete prefixes keep the trailing space: `@file.ts ` is the
 * start of a sentence, not a command.
 *
 * An unregistered name is the same one Enter. `/xyz` opens the popup — the
 * trigger only needs a `/` at position 0, not a matching row — and the popup
 * then holds no rows to select. The popup declines a key it cannot act on,
 * so the draft submits on the first press, and a name no command carries
 * goes out as a message.
 *
 * Tab does not run anything. It is the key that builds `/model sonnet`:
 * complete the name, keep the caret, type the argument. Enter and tab reach
 * the popup as separate props for exactly that reason — when they shared one
 * callback, tab dispatched the first matching row, so `/ag` + Tab ran `/fork`.
 */

interface Dispatched {
  readonly cmd: string
  readonly args: string
}

/**
 * Registers the slash commands under test: one that takes nothing (`/agents`)
 * and two that take an optional argument (`/model`, `/think`).
 */
function RegisterCommandsSlashEnter() {
  const ui = useExtensionUI()
  onMount(() => {
    ui.setSessionCommands([
      // `slashAutocompleteItems` keeps registration order — it does no
      // relevance sorting — so row 0 under a filter is the earliest-registered
      // match. These two carry `ag` in their titles, not their slash names,
      // and live they are registered before `/agents`. That is why `/ag`
      // preselects `/fork`, and why dispatching row 0 ran the wrong command.
      {
        id: "message.fork",
        title: "Fork from Message",
        slash: "fork",
        onSelect: () => {},
      },
      {
        id: "auth.manage",
        title: "Manage API Keys",
        slash: "auth",
        onSelect: () => {},
      },
      {
        id: "agents.view",
        title: "Agents",
        slash: "agents",
        aliases: ["tree"],
        onSelect: () => {},
      },
      {
        id: "session.model",
        title: "Set Model",
        slash: "model",
        onSelect: () => {},
        onSlash: () => {},
      },
      {
        id: "session.think",
        title: "Set Reasoning",
        slash: "think",
        onSelect: () => {},
        onSlash: () => {},
      },
    ])
  })
  return <box />
}

/** Contributes the `/` popup the composer completes against, plus `@` files. */
function ContributeSlashEnter() {
  const ui = useExtensionUI()
  ui.setDynamicAutocomplete([
    {
      prefix: "/",
      title: "Commands",
      // The live popup matches a slash name or its title, which is why `/ag`
      // lists `/fork` ("Fork from Message") and `/auth` ("Manage API Keys")
      // ahead of `/agents`.
      items: (filter: string) =>
        ui.commands().flatMap((c) =>
          Option.match(Option.fromNullishOr(c.slash), {
            onNone: () => [],
            onSome: (slash) => {
              const haystack = `${slash} ${c.title}`.toLowerCase()
              if (!haystack.includes(filter.toLowerCase())) return []
              return [{ id: slash, label: `/${slash}` }]
            },
          }),
        ),
    },
    {
      prefix: "@",
      title: "Files",
      items: (filter: string) => {
        if (filter.startsWith("src/")) return [{ id: "src/main.ts", label: "main.ts" }]
        return [
          { id: "notes.ts", label: "notes.ts" },
          { id: "src/", label: "src/" },
        ].filter((item) => item.id.includes(filter))
      },
      // As the files extension does: a directory keeps completing.
      formatInsertion: (id: string) => {
        if (id.endsWith("/")) return `@${id}`
        return `@${id} `
      },
    },
  ])
  return <box />
}

function TestComposerSlashEnter(props: {
  readonly onSlashCommand: (cmd: string, args: string) => void
  /** A draft sent as a message. */
  readonly onSubmit?: (content: string) => void
  readonly children?: JSX.Element
}) {
  const [interactionState, setInteractionState] = createSignal(ComposerInteractionState.initial())
  // The real controller derives autocomplete from the live contributions
  // (session-controller.ts:389). Without them nothing ever opens a popup and
  // Enter would reach the plain submit path, testing the wrong seam.
  const ext = useExtensionUI()
  const mockController = {
    itemsSettled: () => true,
    items: () => [],
    messages: () => [],
    forkMessages: () => [],
    queueState: () => ({ steering: [], followUp: [] }),
    interactionState,
    saveDraft: () => {},
    uiState: SessionUiState.initial,
    composerState: () => ComposerState.idle(),
    promptSearch: {
      state: PromptSearchState.closed,
      entries: () => [],
      open: () => {},
      onEvent: () => {},
    },
    activity: () => ({ phase: "idle" }),
    phaseLabel: () => "idle",
    armedCue: () => Option.none(),
    elapsed: () => 0,
    onComposerInteraction: (event: Parameters<typeof transitionComposerInteraction>[1]) =>
      setInteractionState((current) =>
        transitionComposerInteraction(current, event, ext.autocompleteItems()),
      ),
    onSubmit: (content: string) => Effect.sync(() => props.onSubmit?.(content)),
    onSlashCommand: ({ cmd, args }: SlashSubmission) => {
      props.onSlashCommand(cmd, args)
      return Effect.void
    },
    // The command runs as given: this harness has no ctrl+c ladder to stop it.
    runShell: <A, E, R>(_command: string, run: Effect.Effect<A, E, R>) => run,
    onRestoreQueue: () => {},
    dispatchComposer: () => {},
    resolveAuthGate: () => {},
    closeOverlay: () => {},
    onForkSelect: () => {},
    onModelSelect: () => {},
    onReasoningSelect: () => {},
    currentSessionName: () => "Test Session",
    onBranchPickerSelect: () => {},
  } satisfies SessionController
  return (
    <SessionControllerContext.Provider value={mockController}>
      <RegisterCommandsSlashEnter />
      <ContributeSlashEnter />
      <Composer>{props.children}</Composer>
    </SessionControllerContext.Provider>
  )
}

/** Type `text`, wait for the popup to list `expected`, then press Enter once. */
const typeThenEnter = (
  dispatched: Array<Dispatched>,
  text: string,
  expected: string,
): Effect.Effect<Awaited<ReturnType<typeof renderWithProviders>>, RenderWaitTimeoutError> =>
  Effect.gen(function* () {
    const setup = yield* Effect.promise(() =>
      renderWithProviders(
        () => (
          <TestComposerSlashEnter
            onSlashCommand={(cmd, args) => {
              dispatched.push({ cmd, args })
            }}
          >
            <Composer.Autocomplete />
          </TestComposerSlashEnter>
        ),
        { width: 80, height: 24 },
      ),
    )
    yield* Effect.promise(() => setup.mockInput.typeText(text))
    yield* waitForFrame(setup, (frame) => frame.includes(expected), expected)
    setup.mockInput.pressEnter()
    yield* Effect.promise(() => setup.renderOnce())
    return setup
  })

/** Type `text`, wait for the popup to list `expected`, then press Tab once. */
const typeThenTab = (
  dispatched: Array<Dispatched>,
  text: string,
  expected: string,
): Effect.Effect<Awaited<ReturnType<typeof renderWithProviders>>, RenderWaitTimeoutError> =>
  Effect.gen(function* () {
    const setup = yield* Effect.promise(() =>
      renderWithProviders(
        () => (
          <TestComposerSlashEnter
            onSlashCommand={(cmd, args) => {
              dispatched.push({ cmd, args })
            }}
          >
            <Composer.Autocomplete />
          </TestComposerSlashEnter>
        ),
        { width: 80, height: 24 },
      ),
    )
    yield* Effect.promise(() => setup.mockInput.typeText(text))
    yield* waitForFrame(setup, (frame) => frame.includes(expected), expected)
    setup.mockInput.pressTab()
    yield* Effect.promise(() => setup.renderOnce())
    return setup
  })

describe("Composer slash Enter", () => {
  it.live("runs a zero-argument command on the first Enter", () =>
    Effect.gen(function* () {
      const dispatched: Array<Dispatched> = []
      const setup = yield* typeThenEnter(dispatched, "/agents", "/agents")
      expect(dispatched).toEqual([{ cmd: "agents", args: "" }])
      // No trailing-space leftover parked in the composer.
      expect(renderFrame(setup)).not.toContain("/agents ")
    }),
  )

  it.live("opens a bare optional-argument command on the first Enter", () =>
    Effect.gen(function* () {
      const dispatched: Array<Dispatched> = []
      yield* typeThenEnter(dispatched, "/model", "/model")
      expect(dispatched).toEqual([{ cmd: "model", args: "" }])
    }),
  )

  it.live("opens bare /think on the first Enter", () =>
    Effect.gen(function* () {
      const dispatched: Array<Dispatched> = []
      yield* typeThenEnter(dispatched, "/think", "/think")
      expect(dispatched).toEqual([{ cmd: "think", args: "" }])
    }),
  )

  it.live("passes a typed argument through on submit", () =>
    Effect.gen(function* () {
      const dispatched: Array<Dispatched> = []
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <TestComposerSlashEnter
              onSlashCommand={(cmd, args) => {
                dispatched.push({ cmd, args })
              }}
            >
              <Composer.Autocomplete />
            </TestComposerSlashEnter>
          ),
          { width: 80, height: 24 },
        ),
      )
      // The space closes the slash popup, so Enter submits the whole line.
      yield* Effect.promise(() => setup.mockInput.typeText("/model sonnet"))
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      expect(dispatched).toEqual([{ cmd: "model", args: "sonnet" }])
    }),
  )

  it.live("keeps the trailing space for a file reference", () =>
    Effect.gen(function* () {
      const dispatched: Array<Dispatched> = []
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <TestComposerSlashEnter
              onSlashCommand={(cmd, args) => {
                dispatched.push({ cmd, args })
              }}
            >
              <Composer.Autocomplete />
            </TestComposerSlashEnter>
          ),
          { width: 80, height: 24 },
        ),
      )
      yield* Effect.promise(() => setup.mockInput.typeText("@notes"))
      yield* waitForFrame(setup, (frame) => frame.includes("notes.ts"), "file row")
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, (frame) => frame.includes("@notes.ts"), "inserted")
      // The `@` path inserts and waits — it never dispatches a command.
      expect(dispatched).toEqual([])
      expect(renderFrame(setup)).toContain("@notes.ts")
    }),
  )

  it.live("a directory row completes into the directory and keeps the popup open", () =>
    Effect.gen(function* () {
      const dispatched: Array<Dispatched> = []
      const setup = yield* typeThenEnter(dispatched, "@src", "src/")
      yield* waitForFrame(setup, (frame) => frame.includes("main.ts"), "directory rows")
      expect(renderFrame(setup)).toContain("@src/")
      expect(dispatched).toEqual([])
    }),
  )

  // Only a known command name is a command. A path, a typo or a pasted log
  // line that starts with `/` is text for the model.
  it.scopedLive("a draft whose first word names no command is sent as a message", () =>
    Effect.gen(function* () {
      for (const draft of ["/xyz", "/tmp/x.log what is this?"]) {
        const dispatched: Array<Dispatched> = []
        const submitted: Array<string> = []
        const setup = yield* renderScoped(
          () => (
            <TestComposerSlashEnter
              onSlashCommand={(cmd, args) => dispatched.push({ cmd, args })}
              onSubmit={(content) => submitted.push(content)}
            >
              <Composer.Autocomplete />
              <CommandsSettled />
            </TestComposerSlashEnter>
          ),
          { width: 80, height: 24 },
        )
        yield* waitForFrame(setup, (frame) => frame.includes("commands settled"), "commands")
        yield* Effect.promise(() => setup.mockInput.typeText(draft))
        yield* waitForFrame(setup, (frame) => frame.includes(draft), "the draft")
        setup.mockInput.pressEnter()
        yield* waitForFrame(setup, (frame) => !frame.includes(draft), "the draft sent")
        expect(dispatched).toEqual([])
        expect(submitted).toEqual([draft])
      }
    }).pipe(Effect.timeout("10 seconds")),
  )

  // A paste is never a command, even one that starts with a command's name.
  it.scopedLive("a draft that starts with a paste chip is sent as a message", () =>
    Effect.gen(function* () {
      const dispatched: Array<Dispatched> = []
      const submitted: Array<string> = []
      const setup = yield* renderScoped(
        () => (
          <TestComposerSlashEnter
            onSlashCommand={(cmd, args) => dispatched.push({ cmd, args })}
            onSubmit={(content) => submitted.push(content)}
          />
        ),
        { width: 80, height: 24 },
      )
      const log = "/model app.log:12 error\n".repeat(5)
      yield* Effect.promise(() => setup.mockInput.pasteBracketedText(log))
      yield* Effect.promise(() => setup.mockInput.typeText(" why?"))
      yield* waitForFrame(setup, (frame) => frame.includes("lines #1] why?"), "the chip")
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, (frame) => !frame.includes("why?"), "the draft sent")
      expect(dispatched).toEqual([])
      expect(submitted).toEqual([`${log} why?`.trim()])
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.live("selects a row instead of submitting while the popup has one", () =>
    Effect.gen(function* () {
      const dispatched: Array<Dispatched> = []
      // `/mod` matches `/model`, so a row exists. Enter must select that row,
      // which dispatches `/model` — not submit the literal text `/mod`.
      yield* typeThenEnter(dispatched, "/mod", "/model")
      expect(dispatched).toEqual([{ cmd: "model", args: "" }])
    }),
  )

  it.live("completes a command name on Tab without running it", () =>
    Effect.gen(function* () {
      const dispatched: Array<Dispatched> = []
      const setup = yield* typeThenTab(dispatched, "/agents", "/agents")
      // Tab is the completion key. Nothing ran.
      expect(dispatched).toEqual([])
      // The name is in the draft with its trailing space, ready for an argument.
      yield* waitForFrame(setup, (frame) => frame.includes("/agents "), "completed draft")
    }),
  )

  it.live("completes the selected row, not the first match, on Tab", () =>
    Effect.gen(function* () {
      const dispatched: Array<Dispatched> = []
      // The regression: `/ag` matches `/fork` and `/auth` by title before it
      // matches `/agents` by name, and the first row is preselected. Tab used
      // to dispatch that row, so `/ag` + Tab ran `/fork`. Tab must run nothing
      // whatever sits under the cursor.
      const setup = yield* typeThenTab(dispatched, "/ag", "/fork")
      expect(dispatched).toEqual([])
      // The draft holds a completed name, so the composer is not left empty.
      yield* waitForFrame(setup, (frame) => frame.includes("/fork "), "completed draft")
    }),
  )

  it.live("leaves an argument typeable after Tab completes the name", () =>
    Effect.gen(function* () {
      const dispatched: Array<Dispatched> = []
      // The affordance Tab exists for: complete `/model`, then type `sonnet`,
      // then submit the pair. A Tab that dispatched would never reach the arg.
      const setup = yield* typeThenTab(dispatched, "/model", "/model")
      expect(dispatched).toEqual([])
      yield* Effect.promise(() => setup.mockInput.typeText("sonnet"))
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      expect(dispatched).toEqual([{ cmd: "model", args: "sonnet" }])
    }),
  )

  it.live("inserts a file reference on Tab", () =>
    Effect.gen(function* () {
      const dispatched: Array<Dispatched> = []
      // The `@` path never dispatched and must not start now.
      const setup = yield* typeThenTab(dispatched, "@notes", "notes.ts")
      expect(dispatched).toEqual([])
      yield* waitForFrame(setup, (frame) => frame.includes("@notes.ts"), "inserted")
    }),
  )
})
