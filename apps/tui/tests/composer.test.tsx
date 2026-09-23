/** @jsxImportSource @opentui/solid */
import { describe, expect, it, test } from "effect-bun-test"
import {
  AutocompletePopup,
  Composer,
  ComposerFrame,
  countLines,
  createPasteManager,
  executeShell,
  isLargePaste,
  shellOutputDirectory,
} from "../src/composer"
import { Deferred, Effect, FileSystem, Layer, Option } from "effect"
import { type ActiveInteraction, BranchId, SessionId } from "@gent/core/protocol"
import { InteractionRequestId } from "@gent/core/extensions/branch-tools"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { RGBA } from "@opentui/core"
import {
  type StatusRowLabel,
  type ComposerEvent,
  ComposerInteractionState,
  ComposerState,
  type SessionController,
  SessionControllerContext,
  SessionUiState,
  transitionComposerInteraction,
} from "../src/session"
import { renderFrame, renderWithProviders } from "./render-harness-boundary"
import { createSignal, type JSX, onMount } from "solid-js"
import { PromptSearchState } from "../src/pickers"
import { useExtensionUI } from "../src/extensions/host"
import { type RenderWaitTimeoutError, waitForFrame } from "./helpers-boundary"
import { useScopedKeyboard } from "../src/terminal"
import {
  type AutocompleteItem,
  clientContributions,
  defineClientExtension,
} from "../src/extensions/client-facets"
import { builtinClientModules } from "../src/extensions/builtins"
import { rankAutocompleteItems } from "../src/autocomplete"

// ── shell.test ──────────────────────────────────────────────────────────────

const testLayer = Layer.merge(BunFileSystem.layer, BunServices.layer)
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
    }),
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
      const lineCount = 2500
      const result = yield* executeShell(`seq 1 ${lineCount} | sed 's/^/line /'`, testDir)
      expect(result.truncated).toBe(true)

      // The reader is handed a path, not just a stump of the output.
      const savedPath = yield* Effect.fromOption(result.savedPath)
      // The spill lives under the gent data directory, not under /tmp/gent.
      expect(savedPath.startsWith(shellOutputDirectory())).toBe(true)
      expect(savedPath).not.toContain("/tmp/gent")

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

// ── paste-indicator.test ────────────────────────────────────────────────────

// The paste manager is per-controller: each composer owns its id counter and
// store, so every test makes its own rather than resetting shared state.

describe("countLines", () => {
  test("counts single line", () => {
    expect(countLines("hello")).toBe(1)
  })

  test("counts multiple lines", () => {
    expect(countLines("line1\nline2")).toBe(2)
    expect(countLines("a\nb\nc")).toBe(3)
    expect(countLines("1\n2\n3\n4\n5")).toBe(5)
  })

  test("handles empty string", () => {
    expect(countLines("")).toBe(1)
  })

  test("handles trailing newline", () => {
    expect(countLines("line1\nline2\n")).toBe(3)
  })
})

describe("isLargePaste", () => {
  test("returns false for short single-line text", () => {
    expect(isLargePaste("hello")).toBe(false)
    expect(isLargePaste("short text")).toBe(false)
  })

  test("returns true for text with 3+ lines", () => {
    expect(isLargePaste("a\nb\nc")).toBe(true)
    expect(isLargePaste("line1\nline2\nline3")).toBe(true)
  })

  test("returns false for 2 lines", () => {
    expect(isLargePaste("line1\nline2")).toBe(false)
  })

  test("returns true for long text even if single line", () => {
    const longText = "x".repeat(150)
    expect(isLargePaste(longText)).toBe(true)
  })

  test("returns false for text just under threshold", () => {
    const shortText = "x".repeat(149)
    expect(isLargePaste(shortText)).toBe(false)
  })

  test("returns true if either condition is met", () => {
    expect(isLargePaste("a\nb\nc")).toBe(true)
    expect(isLargePaste("x".repeat(150))).toBe(true)
  })
})

describe("createPlaceholder", () => {
  test("creates placeholder with line count", () => {
    const paste = createPasteManager()
    const placeholder = paste.createPlaceholder("line1\nline2\nline3")
    expect(placeholder).toMatch(/\[Pasted ~3 lines #paste-\d+\]/)
  })

  test("stores original text for later retrieval", () => {
    const paste = createPasteManager()
    const text = "original content\nwith lines"
    const placeholder = paste.createPlaceholder(text)
    expect(placeholder).toBe("[Pasted ~2 lines #paste-1]")
    expect(paste.expandPlaceholders(placeholder)).toBe(text)
  })

  test("increments ID for each placeholder", () => {
    const paste = createPasteManager()
    expect(paste.createPlaceholder("a\nb\nc")).toBe("[Pasted ~3 lines #paste-1]")
    expect(paste.createPlaceholder("x\ny\nz")).toBe("[Pasted ~3 lines #paste-2]")
  })

  test("each manager owns its own id sequence", () => {
    expect(createPasteManager().createPlaceholder("a\nb\nc")).toBe("[Pasted ~3 lines #paste-1]")
    expect(createPasteManager().createPlaceholder("a\nb\nc")).toBe("[Pasted ~3 lines #paste-1]")
  })
})

describe("expandPlaceholders", () => {
  test("expands single placeholder", () => {
    const paste = createPasteManager()
    const original = "line1\nline2\nline3"
    const placeholder = paste.createPlaceholder(original)

    expect(paste.expandPlaceholders(`Before ${placeholder} after`)).toBe(`Before ${original} after`)
  })

  test("expands multiple placeholders", () => {
    const paste = createPasteManager()
    const text1 = "first\npaste\ncontent"
    const text2 = "second\npaste\nhere"
    const p1 = paste.createPlaceholder(text1)
    const p2 = paste.createPlaceholder(text2)

    expect(paste.expandPlaceholders(`Start ${p1} middle ${p2} end`)).toBe(
      `Start ${text1} middle ${text2} end`,
    )
  })

  test("removes placeholder from store after expansion", () => {
    const paste = createPasteManager()
    const placeholder = paste.createPlaceholder("a\nb\nc")

    expect(paste.expandPlaceholders(placeholder)).toBe("a\nb\nc")
    // Second expansion finds nothing left to substitute.
    expect(paste.expandPlaceholders(placeholder)).toBe(placeholder)
  })

  test("preserves unknown placeholders", () => {
    const paste = createPasteManager()
    const input = "text with [Pasted ~5 lines #paste-unknown] placeholder"
    expect(paste.expandPlaceholders(input)).toBe(input)
  })

  test("handles text without placeholders", () => {
    const paste = createPasteManager()
    const input = "just regular text without any placeholders"
    expect(paste.expandPlaceholders(input)).toBe(input)
  })

  test("handles empty string", () => {
    expect(createPasteManager().expandPlaceholders("")).toBe("")
  })

  test("clear drops stored pastes", () => {
    const paste = createPasteManager()
    const placeholder = paste.createPlaceholder("a\nb\nc")
    paste.clear()
    expect(paste.expandPlaceholders(placeholder)).toBe(placeholder)
  })
})

describe("paste workflow integration", () => {
  test("full paste and expand cycle", () => {
    const paste = createPasteManager()
    const pastedCode = `function example() {
  const x = 1
  const y = 2
  return x + y
}`
    expect(isLargePaste(pastedCode)).toBe(true)

    const placeholder = paste.createPlaceholder(pastedCode)
    expect(placeholder).toMatch(/\[Pasted ~5 lines #paste-\d+\]/)

    const userInput = `Check this code: ${placeholder}`
    expect(paste.expandPlaceholders(userInput)).toBe(`Check this code: ${pastedCode}`)
  })
})

// ── composer-frame-anchor.test ──────────────────────────────────────────────

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
      renderWithProviders(
        () => (
          <ComposerFrame labels={labels} rightLabels={rightLabels}>
            <box />
          </ComposerFrame>
        ),
        { width, height: 10 },
      ),
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

// ── composer-render.test ────────────────────────────────────────────────────

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
function TestComposer(props: {
  readonly suspended?: boolean
  readonly onSubmit: (content: string, mode?: "queue" | "interject") => void
  readonly children?: JSX.Element
  readonly composerState?: () => ComposerState
  readonly dispatchComposer?: (event: ComposerEvent) => void
}) {
  const [interactionState, setInteractionState] = createSignal(ComposerInteractionState.initial())
  const ext = useExtensionUI()
  const mockController = {
    items: () => [],
    messages: () => [],
    forkMessages: () => [],
    queueState: () => ({ steering: [], followUp: [] }),
    interactionState,
    saveDraft: () => {},
    uiState: SessionUiState.initial,
    composerState: props.composerState ?? (() => ComposerState.idle()),
    promptSearch: {
      state: PromptSearchState.closed,
      entries: () => [],
      isOpen: () => props.suspended === true,
      open: () => {},
      onEvent: () => {},
    },
    activity: () => ({ phase: "idle", turn: 0 }),
    phaseLabel: () => "idle",
    elapsed: () => 0,
    // Production threads the live contributions here (session-controller.ts).
    // Dropping them makes every popup assertion vacuous, so the harness
    // matches the real call.
    onComposerInteraction: (event: Parameters<typeof transitionComposerInteraction>[1]) =>
      setInteractionState((current) =>
        transitionComposerInteraction(current, event, ext.autocompleteItems()),
      ),
    onSubmit: props.onSubmit,
    onSlashCommand: (_cmd: string, _args: string) => Effect.void,
    onRestoreQueue: () => {},
    dispatchComposer: props.dispatchComposer ?? (() => {}),
    resolveAuthGate: () => {},
    closeOverlay: () => {},
    onForkSelect: () => {},
    onModelSelect: () => {},
    onReasoningSelect: () => {},
    currentSessionName: () => "Test Session",
    onBranchPickerDismiss: () => {},
    onBranchPickerSelect: () => {},
  } satisfies SessionController
  return (
    <SessionControllerContext.Provider value={mockController}>
      <Contribute />
      <Composer>{props.children}</Composer>
    </SessionControllerContext.Provider>
  )
}
describe("Composer renderer", () => {
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
  it.live("slash trigger renders the command popup", () =>
    Effect.gen(function* () {
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <TestComposer onSubmit={() => {}}>
              <Composer.Autocomplete />
            </TestComposer>
          ),
          { width: 80, height: 24 },
        ),
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
      expect(frame).toContain("Enter Run")
      expect(frame).toContain("Tab Complete")
      setup.renderer.destroy()
    }),
  )
})

// ── components/autocomplete-popup.test ──────────────────────────────────────

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
  it.live("wraps the cursor at both ends through the shared list", () =>
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
                onSelect={(value) => picked.push(value)}
                onComplete={(value) => completed.push(value)}
                onClose={() => {}}
                onGhostChange={() => {}}
              />
            </>
          ),
          { width: 80, height: 24 },
        ),
      )
      yield* waitForFrame(setup, (frame) => frame.includes("/gamma"), "items")
      // Up from the first row lands on the last.
      setup.mockInput.pressArrow("up")
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      expect(picked).toEqual(["gamma"])
      // Down from the last row lands on the first. Tab acts on the same row as
      // enter would, and reports through the completion prop instead.
      setup.mockInput.pressArrow("down")
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressTab()
      expect(completed).toEqual(["alpha"])
      expect(picked).toEqual(["gamma"])
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
                onComplete={(value) => completed.push(value)}
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
                onSelect={(value) => picked.push(value)}
                onComplete={(value) => picked.push(value)}
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

// ── components/composer-ghost.test ──────────────────────────────────────────

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
      isOpen: () => false,
      open: () => {},
      onEvent: () => {},
    },
    activity: () => ({ phase: "idle", turn: 0 }),
    phaseLabel: () => "idle",
    elapsed: () => 0,
    onComposerInteraction: (event: Parameters<typeof transitionComposerInteraction>[1]) =>
      setInteractionState((current) =>
        transitionComposerInteraction(current, event, ext.autocompleteItems()),
      ),
    onSubmit: (text: string) => props.onSubmit(text),
    onSlashCommand: () => Effect.void,
    onRestoreQueue: () => {},
    dispatchComposer: () => {},
    resolveAuthGate: () => {},
    closeOverlay: () => {},
    onForkSelect: () => {},
    onModelSelect: () => {},
    onReasoningSelect: () => {},
    currentSessionName: () => "Test Session",
    onBranchPickerDismiss: () => {},
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

// ── components/composer-slash-enter.test ────────────────────────────────────

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
 * then holds no rows to select. The composer used to claim that Enter anyway
 * and drop it, so the first press did nothing and only a second one reported
 * `Unknown command: /xyz`. The popup declines a key it cannot act on, so the
 * draft submits and the error surfaces on the first press.
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
      items: () => [{ id: "notes.ts", label: "notes.ts" }],
    },
  ])
  return <box />
}

function TestComposerSlashEnter(props: {
  readonly onSlashCommand: (cmd: string, args: string) => void
  readonly children?: JSX.Element
}) {
  const [interactionState, setInteractionState] = createSignal(ComposerInteractionState.initial())
  // The real controller derives autocomplete from the live contributions
  // (session-controller.ts:389). Without them nothing ever opens a popup and
  // Enter would reach the plain submit path, testing the wrong seam.
  const ext = useExtensionUI()
  const mockController = {
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
      isOpen: () => false,
      open: () => {},
      onEvent: () => {},
    },
    activity: () => ({ phase: "idle", turn: 0 }),
    phaseLabel: () => "idle",
    elapsed: () => 0,
    onComposerInteraction: (event: Parameters<typeof transitionComposerInteraction>[1]) =>
      setInteractionState((current) =>
        transitionComposerInteraction(current, event, ext.autocompleteItems()),
      ),
    onSubmit: () => {},
    onSlashCommand: (cmd: string, args: string) => {
      props.onSlashCommand(cmd, args)
      return Effect.void
    },
    onRestoreQueue: () => {},
    dispatchComposer: () => {},
    resolveAuthGate: () => {},
    closeOverlay: () => {},
    onForkSelect: () => {},
    onModelSelect: () => {},
    onReasoningSelect: () => {},
    currentSessionName: () => "Test Session",
    onBranchPickerDismiss: () => {},
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

  it.live("reports an unregistered command on the first Enter", () =>
    Effect.gen(function* () {
      const dispatched: Array<Dispatched> = []
      // `/xyz` matches no registered command, so the popup opens with no rows.
      // The Enter has to reach the submit path regardless: dispatching is what
      // produces `Unknown command: /xyz` from `executeSlashCommand`.
      const setup = yield* typeThenEnter(dispatched, "/xyz", "No matches")
      expect(dispatched).toEqual([{ cmd: "xyz", args: "" }])
      // The draft is gone — the key was consumed by the submit, not dropped.
      expect(renderFrame(setup)).not.toContain("/xyz")
    }),
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
