/** @jsxImportSource @opentui/solid */
/**
 * Native history hands a completed item to scrollback and only then drops it
 * from the live view. Two things can interrupt that handover: an overlay that
 * takes the screen back while the surface settles, and a display clear that
 * lands between the settle and the commit. Both are held open here.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Option } from "effect"
import { createSignal } from "solid-js"
import { useRenderer } from "@opentui/solid"
import { SyntaxStyle } from "@opentui/core"
import type { CliRenderer, CliRendererExternalOutputEvent } from "@opentui/core"
import { NativeTranscript } from "../src/components/native-transcript"
import { MessageList, type Message } from "../src/components/message-list"
import { renderWithProviders } from "./render-harness-boundary"
import { makeSettleHold } from "./scrollback-hold-boundary"

const syntaxStyle = () => SyntaxStyle.create()
const absent = Option.getOrUndefined(Option.none())

const assistant = (id: string, content: string): Message => ({
  _tag: "regular-message",
  id,
  role: "assistant",
  content,
  reasoning: "",
  images: [],
  createdAt: 0,
  toolCalls: absent,
  segments: [{ _tag: "text", content }],
})

/** Long enough that the transcript wants to move the leading item to history. */
const longBody = (label: string) =>
  Array.from({ length: 12 }, (_, index) => `${label} line ${index + 1}`).join("\n\n")

const transcript = (options: {
  readonly items: Message[]
  readonly displayRevision: () => number
  readonly overlayOpen: () => boolean
  readonly onRenderer: (renderer: CliRenderer) => void
}) => {
  const renderer = useRenderer()
  options.onRenderer(renderer)
  return (
    <NativeTranscript
      items={options.items}
      streaming={false}
      footerHeight={3}
      expanded={false}
      disclosure="collapsed"
      displayRevision={options.displayRevision()}
      overlayOpen={options.overlayOpen()}
      renderItems={(visible) => (
        <MessageList
          items={visible}
          disclosure="collapsed"
          syntaxStyle={syntaxStyle}
          streaming={false}
        />
      )}
    >
      <box />
    </NativeTranscript>
  )
}

describe("native transcript commit handover", () => {
  it.live(
    "an overlay that takes the screen mid-commit leaves the item in the live view",
    () =>
      Effect.gen(function* () {
        const hold = yield* makeSettleHold
        const items = [assistant("first", longBody("FIRST-ITEM")), assistant("second", "TAIL")]
        const [overlayOpen, setOverlayOpen] = createSignal(false)
        const committedText: string[] = []

        const setup = yield* Effect.promise(() =>
          renderWithProviders(
            () =>
              transcript({
                items,
                displayRevision: () => 0,
                overlayOpen,
                onRenderer: (renderer) => {
                  hold.applyTo(renderer)
                  renderer.on("external_output", (event: CliRendererExternalOutputEvent) => {
                    committedText.push(
                      new TextDecoder().decode(event.snapshot.getRealCharBytes(false)),
                    )
                  })
                },
              }),
            { width: 60, height: 14 },
          ),
        )
        yield* Effect.promise(() => setup.flush())
        yield* hold.held

        // An overlay takes the screen while the commit is still held.
        setOverlayOpen(true)
        yield* Effect.promise(() => setup.flush())

        // Releasing now runs the commit against the alternate screen.
        yield* hold.release
        yield* Effect.promise(() => setup.flush())

        // The commit was refused, so nothing reached scrollback yet.
        expect(committedText.join("")).not.toContain("FIRST-ITEM line 1")

        // The overlay closes, the split footer returns, and the item that came
        // back is offered again. It must reach scrollback exactly once: an item
        // dropped from the live view without a commit is lost text.
        setOverlayOpen(false)
        yield* Effect.promise(() => setup.flush())
        yield* Effect.promise(() => setup.flush())
        yield* Effect.promise(() => setup.flush())
        expect(committedText.join("")).toContain("FIRST-ITEM line 1")
      }).pipe(Effect.timeout("10 seconds")),
    15_000,
  )

  it.live(
    "a display clear cancels a commit that is still settling",
    () =>
      Effect.gen(function* () {
        const hold = yield* makeSettleHold
        const [displayRevision, setDisplayRevision] = createSignal(0)
        const committedText: string[] = []
        const items = [assistant("first", longBody("CLEARED-ITEM")), assistant("second", "TAIL")]

        const setup = yield* Effect.promise(() =>
          renderWithProviders(
            () =>
              transcript({
                items,
                displayRevision,
                overlayOpen: () => false,
                onRenderer: (renderer) => {
                  hold.applyTo(renderer)
                  renderer.on("external_output", (event: CliRendererExternalOutputEvent) => {
                    committedText.push(
                      new TextDecoder().decode(event.snapshot.getRealCharBytes(false)),
                    )
                  })
                },
              }),
            { width: 60, height: 14 },
          ),
        )
        yield* Effect.promise(() => setup.flush())
        yield* hold.held

        // `/clear` bumps the revision while the commit is still held.
        setDisplayRevision(1)
        yield* Effect.promise(() => setup.flush())

        yield* hold.release
        yield* Effect.promise(() => setup.flush())
        yield* Effect.promise(() => setup.flush())

        expect(committedText.join("")).not.toContain("CLEARED-ITEM")
      }).pipe(Effect.timeout("10 seconds")),
    15_000,
  )

  /**
   * Scrollback is written by letting the committed rows scroll off the top of
   * the output region above the footer, so that region has to exist and has to
   * be scrollable. Two footer spellings used to destroy it: a footer grown to
   * the full screen left no region, and a per-commit footer change ran
   * OpenTUI's `applyScreenMode` mid-commit, which rewrites the screen with
   * `ESC[nS` and drops the rows instead of scrolling them away. Both reported
   * success to the component while the terminal kept no history at all.
   */
  it.live(
    "a tall live view still leaves the terminal rows to scroll",
    () =>
      Effect.gen(function* () {
        // Enough items that the live view wants far more than the 14 rows the
        // terminal has, which is what used to push the footer to full screen.
        const items = Array.from({ length: 8 }, (_, index) =>
          assistant(`item-${index}`, longBody(`ITEM-${index}`)),
        )
        const screenHeight = 14
        const footerHeights: number[] = []
        let committedFooterHeights: number[] = []

        const setup = yield* Effect.promise(() =>
          renderWithProviders(
            () =>
              transcript({
                items,
                displayRevision: () => 0,
                overlayOpen: () => false,
                onRenderer: (renderer) => {
                  // Record the footer height the renderer actually holds at the
                  // moment rows are handed to scrollback, and on every frame,
                  // so a height that only exists mid-commit is still seen.
                  renderer.on("external_output", () => {
                    committedFooterHeights.push(renderer.footerHeight)
                  })
                  renderer.on("frame", () => {
                    footerHeights.push(renderer.footerHeight)
                  })
                },
              }),
            { width: 60, height: screenHeight },
          ),
        )
        for (let pass = 0; pass < 6; pass++) {
          yield* Effect.promise(() => setup.flush())
        }

        expect(footerHeights.length).toBeGreaterThan(0)
        // Every height the component asked for must leave a region the
        // terminal can scroll. One row cannot scroll, so two is the floor.
        for (const height of footerHeights) {
          expect(screenHeight - height).toBeGreaterThanOrEqual(2)
        }
        // And each commit ran against such a footer.
        for (const height of committedFooterHeights) {
          expect(screenHeight - height).toBeGreaterThanOrEqual(2)
        }
        committedFooterHeights = []
      }).pipe(Effect.timeout("10 seconds")),
    15_000,
  )
})
