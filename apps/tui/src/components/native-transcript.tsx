import {
  batch,
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  For,
  getOwner,
  onCleanup,
  onMount,
  runWithOwner,
  untrack,
  type JSX,
} from "solid-js"
import { insert, RendererContext, useRenderer } from "@opentui/solid"
import type { ScrollbackSurface, ScrollBoxRenderable } from "@opentui/core"
import { Effect, Fiber, Option, Predicate, Schema } from "effect"
import { useTerminalDimensions } from "../terminal-dimensions"
import { useScopedKeyboard } from "../keyboard/context"
import type { AssistantSegment, SessionItem, ToolCall } from "./message-list"
import type { DisclosureLevel } from "../routes/session-ui-state"
import { captureTranscriptDisplay, projectTranscriptDisplay } from "./transcript-display"

interface NativeTranscriptProps {
  items: SessionItem[]
  streaming: boolean
  footerHeight: number
  expanded: boolean
  disclosure: DisclosureLevel
  displayRevision: number
  overlayOpen: boolean
  renderItems: (items: SessionItem[], streaming: boolean) => JSX.Element
  children: JSX.Element
}

const encodeFingerprint = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const toolFingerprint = (call: ToolCall): ReadonlyArray<unknown> => [
  call.id,
  call.toolName,
  call.status,
  call.summary,
  call.output,
  call.durationMs,
  (call.operations ?? []).map(toolFingerprint),
]

const segmentFingerprint = (segment: AssistantSegment): ReadonlyArray<unknown> => {
  if (segment._tag === "tool-call") return [segment._tag, toolFingerprint(segment.toolCall)]
  if (segment._tag === "image") return [segment._tag, segment.image.mediaType]
  return [segment._tag, segment.content]
}

const isMessageItem = Predicate.or(
  Predicate.isTagged("regular-message"),
  Predicate.isTagged("interjection-message"),
)

/**
 * What a committed item looks like on screen, as a value that does not depend
 * on how the item was built.
 *
 * The transcript compares these position by position to decide what already
 * reached scrollback. The feed constructs one message two ways — the streaming
 * path writes `_tag` first and omits `segments` and `metadata`, the rebuild
 * path spreads the body and appends `_tag` last — so encoding the object
 * itself gave the same message two different strings. A rebuild then broke the
 * committed prefix, forced a replay, and cleared the terminal's saved lines.
 * Naming the drawn fields in a fixed order keeps a rebuild silent while real
 * edits, new text, and tool results still change the value.
 */
export const transcriptFingerprint = (item: SessionItem): string => {
  if (isMessageItem(item))
    return encodeFingerprint([
      item._tag,
      item.id,
      item.role,
      item.content,
      item.reasoning,
      item.images.length,
      item.createdAt,
      item.pendingMode,
      (item.toolCalls ?? []).map(toolFingerprint),
      (item.segments ?? []).map(segmentFingerprint),
      item.metadata?.customType,
      item.metadata?.hidden,
    ])
  if (item._tag === "turn-ended")
    return encodeFingerprint([
      item._tag,
      item.createdAt,
      item.seq,
      item.durationSeconds,
      item.steps.count,
      item.steps.toolCalls,
      item.steps.costUsd,
    ])
  if (item._tag === "error")
    return encodeFingerprint([item._tag, item.createdAt, item.seq, item.error])
  if (item._tag === "retrying")
    return encodeFingerprint([
      item._tag,
      item.createdAt,
      item.seq,
      item.attempt,
      item.maxAttempts,
      item.delayMs,
      item.resolved,
    ])
  return encodeFingerprint([item._tag, item.createdAt, item.seq])
}

/** The surface did not settle before its timeout; the rows still commit as rendered. */
class NativeSettleError extends Schema.TaggedError<NativeSettleError>()("NativeSettleError", {
  message: Schema.String,
}) {}

/** Owns native history snapshots. The session feed remains the source of truth. */
export function NativeTranscript(props: NativeTranscriptProps) {
  const renderer = useRenderer()
  const owner = getOwner()
  const dimensions = useTerminalDimensions()
  const [ready, setReady] = createSignal(false)
  const [nativeOutputReady, setNativeOutputReady] = createSignal(false)
  const [committedCount, setCommittedCount] = createSignal(0)
  const [liveHeight, setLiveHeight] = createSignal(0)
  const [measurementVersion, setMeasurementVersion] = createSignal(0)
  const itemHeights = new Map<SessionItem, number>()
  let committed: string[] = []
  /**
   * How far the queue has been offered items. It runs ahead of `committed`
   * while commits are in flight, so a re-render cannot enqueue the same item
   * twice; a commit that does not land rewinds it to `committed.length`.
   */
  let queued = 0
  /**
   * Bumped when a queued commit hands its item back. The rewind of `queued`
   * runs on the queue fiber, so the pass that offers items needs a reactive
   * nudge to run again and retry the item that came back.
   */
  const [retryVersion, setRetryVersion] = createSignal(0)
  /**
   * Which display a commit belongs to. A `/clear` bumps it, so a commit queued
   * before the clear finds a stale stamp when its surface finally settles and
   * drops its rows instead of writing history the reader already dismissed.
   */
  let displayGeneration = 0
  let displayRevision = 0
  const [displayBoundary, setDisplayBoundary] = createSignal(captureTranscriptDisplay([]))
  const displayedItems = createMemo(() => projectTranscriptDisplay(props.items, displayBoundary()))
  let viewport = Option.none<ScrollBoxRenderable>()
  let settlingNative = false
  const [replayPending, setReplayPending] = createSignal(false)
  let measuredDimensions = dimensions()
  let measuredDisclosure = props.disclosure
  const finishNativeReturn = () => {
    settlingNative = false
    if (props.expanded || props.overlayOpen) return
    batch(() => {
      setReplayPending(false)
      setNativeOutputReady(true)
    })
  }

  const requestReplay = () => {
    renderer.off("frame", finishNativeReturn)
    settlingNative = false
    batch(() => {
      setNativeOutputReady(false)
      setReplayPending(true)
      committed = []
      queued = 0
      setCommittedCount(0)
    })
  }

  useScopedKeyboard(
    (event) => {
      if (Option.isNone(viewport)) return false
      if (event.name === "pageup") {
        viewport.value.scrollBy(-viewport.value.height)
        return true
      }
      if (event.name === "pagedown") {
        viewport.value.scrollBy(viewport.value.height)
        return true
      }
      return false
    },
    { when: () => props.expanded && !props.overlayOpen },
  )

  // Native history commits are serialized: markdown highlights arrive from the
  // tree-sitter worker asynchronously, and scrollback is immutable once written,
  // so each item renders on a surface, settles, and only then commits its rows.
  let disposed = false
  let nativeTail: Fiber.Fiber<void> = Effect.runFork(Effect.void)
  const enqueueNative = (task: Effect.Effect<void>) => {
    const previous = nativeTail
    nativeTail = Effect.runFork(
      Fiber.await(previous).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            if (disposed || renderer.isDestroyed) return Effect.void
            return task
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("transcript.native-commit-failed").pipe(
            Effect.annotateLogs({ cause: String(cause) }),
          ),
        ),
      ),
    )
  }

  /** Scrollback accepts a commit only while the split footer owns the screen. */
  const canCommitNatively = () =>
    renderer.screenMode === "split-footer" && renderer.externalOutputMode === "capture-stdout"

  /**
   * Renders one item onto a scrollback surface, settles it, and commits its
   * rows. Reports whether the rows reached scrollback: an overlay that opens
   * while the surface settles takes the screen back, and scrollback rejects a
   * commit from the alternate screen. An item that did not commit stays in the
   * live view, so closing the overlay still shows it.
   */
  const commitItems = (items: SessionItem[], footerHeight: number): Effect.Effect<boolean> =>
    Effect.suspend(() => {
      const generation = displayGeneration
      const stillCurrent = () => displayGeneration === generation && canCommitNatively()
      if (!stillCurrent()) return Effect.succeed(false)
      // Native history takes complete transcript items. Reserve only the composer while committing it.
      const previousFooterHeight = renderer.footerHeight
      renderer.footerHeight = footerHeight
      const surface: ScrollbackSurface = renderer.createScrollbackSurface()
      const surfaceRenderer = Object.create(surface.renderContext)
      Object.defineProperties(surfaceRenderer, {
        root: { get: () => surface.root, enumerable: true },
        width: { get: () => surface.width, enumerable: true },
        height: { get: () => surface.height, enumerable: true },
      })
      const disposeSnapshot = Option.fromNullishOr(
        runWithOwner(owner, () =>
          createRoot((dispose) => {
            insert(surface.root, () => (
              <RendererContext.Provider value={surfaceRenderer}>
                {props.renderItems(items, false)}
              </RendererContext.Provider>
            ))
            return dispose
          }),
        ),
      )
      return Effect.tryPromise({
        try: () => surface.settle(2000),
        catch: (error) => new NativeSettleError({ message: String(error) }),
      }).pipe(
        // A highlight that never lands still commits; the row text is complete.
        // A surface the renderer already tore down has nothing left to draw.
        Effect.catch(() =>
          Effect.suspend(() => {
            if (surface.isDestroyed) return Effect.void
            return Effect.sync(() => surface.render())
          }),
        ),
        // Settling is asynchronous. The screen may have changed hands and the
        // reader may have cleared the display while it ran, so both are
        // checked again before the rows are handed over.
        Effect.andThen(
          Effect.suspend(() => {
            if (surface.isDestroyed || !stillCurrent()) return Effect.succeed(false)
            return Effect.sync(() => {
              surface.commitRows(0, surface.height)
              return true
            })
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (Option.isSome(disposeSnapshot)) disposeSnapshot.value()
            if (!surface.isDestroyed) surface.destroy()
            // Restoring the surface also flushes the queued snapshot before it grows.
            renderer.footerHeight = previousFooterHeight
          }),
        ),
      )
    })

  /** The screen changed hands: give the item back to the live view. */
  const rewind = () => {
    queued = committed.length
    setRetryVersion((version) => version + 1)
  }

  /**
   * Hands one item to native history and, only once its rows land, drops it
   * from the live view. A commit that could not happen leaves the counters
   * untouched, so the item stays visible and a later pass retries it.
   */
  const write = (item: SessionItem, fingerprintValue: string) => {
    enqueueNative(
      commitItems([item], props.footerHeight).pipe(
        Effect.andThen((landed) =>
          Effect.sync(() => {
            if (!landed) return rewind()
            committed = [...committed, fingerprintValue]
            setCommittedCount(committed.length)
          }),
        ),
        Effect.onError(() => Effect.sync(rewind)),
      ),
    )
  }

  onMount(() => {
    renderer.footerHeight = props.footerHeight
    renderer.screenMode = "split-footer"
    renderer.externalOutputMode = "capture-stdout"
    // Native history scrolls in the terminal. Mouse tracking would swallow the wheel.
    renderer.useMouse = false
    // A new transcript must not inherit the previous screen's cursor origin.
    renderer.resetSplitFooterForReplay()
    setReady(true)
  })

  onCleanup(() => {
    disposed = true
    renderer.off("frame", finishNativeReturn)
    if (renderer.isDestroyed) return
    renderer.externalOutputMode = "passthrough"
    renderer.screenMode = "alternate-screen"
    renderer.useMouse = true
  })

  createEffect(() => {
    const next = dimensions()
    const disclosure = props.disclosure
    if (
      next.width === measuredDimensions.width &&
      next.height === measuredDimensions.height &&
      disclosure === measuredDisclosure
    )
      return
    measuredDimensions = next
    measuredDisclosure = disclosure
    untrack(requestReplay)
  })

  createEffect(() => {
    if (!ready()) return
    if (props.expanded || props.overlayOpen) {
      setNativeOutputReady(false)
      renderer.externalOutputMode = "passthrough"
      renderer.screenMode = "alternate-screen"
      // The expanded transcript owns scrolling, so the wheel must reach the scrollbox.
      renderer.useMouse = true
      return
    }
    const returning = renderer.screenMode === "alternate-screen"
    renderer.footerHeight = Math.min(
      dimensions().height,
      Math.max(1, props.footerHeight + Math.max(1, liveHeight())),
    )
    renderer.screenMode = "split-footer"
    renderer.externalOutputMode = "capture-stdout"
    renderer.useMouse = false
    if ((returning || replayPending()) && !settlingNative) {
      settlingNative = true
      renderer.once("frame", finishNativeReturn)
      // Layout and content changes invalidate saved snapshots.
      // Clear before the layout frame; replay only after its measurements arrive.
      const clearSavedLines = replayPending()
      enqueueNative(
        Effect.sync(() => {
          renderer.resetSplitFooterForReplay({ clearSavedLines })
          renderer.requestRender()
        }),
      )
    }
    if (!settlingNative) setNativeOutputReady(true)
  })

  createEffect(() => {
    if (!nativeOutputReady()) return
    const nextDisplayRevision = props.displayRevision
    if (displayRevision === nextDisplayRevision) return
    untrack(() => {
      displayRevision = nextDisplayRevision
      const cleared = props.items
      // Bumped before the queue sees the reset: a commit already settling now
      // finds a stale stamp and drops its rows rather than writing history the
      // reader just dismissed.
      displayGeneration += 1
      // The boundary moves at once, so no later pass can offer a pre-clear
      // item again while the queue is still draining.
      batch(() => {
        setDisplayBoundary(captureTranscriptDisplay(cleared))
        committed = []
        queued = 0
        setCommittedCount(0)
      })
      // The renderer reset joins the commit queue rather than jumping it, so
      // the queue stays the single writer of scrollback.
      enqueueNative(Effect.sync(() => renderer.resetSplitFooterForReplay()))
    })
  })

  createEffect(() => {
    if (!nativeOutputReady() || props.streaming || props.expanded || props.overlayOpen) return
    const items = displayedItems()
    const next = items.map((item) => transcriptFingerprint(item))
    measurementVersion()
    retryVersion()
    const available = Math.max(0, dimensions().height - props.footerHeight)
    untrack(() => {
      const prefixMatches = committed.every((value, index) => next[index] === value)
      if (!prefixMatches) {
        requestReplay()
        return
      }
      let remainingHeight = 0
      for (const item of items.slice(queued)) {
        remainingHeight += itemHeights.get(item) ?? 0
      }
      while (queued < items.length && remainingHeight > available) {
        const item = items[queued]
        if (!item) break
        const height = Option.fromNullishOr(itemHeights.get(item))
        if (Option.isNone(height)) break
        const value = next[queued]
        if (!Predicate.isString(value)) break
        // A completed item has one owner: native history or the live view. The
        // live view keeps it until the queued commit reports that it landed.
        write(item, value)
        remainingHeight -= height.value
        queued++
      }
      const currentItems = new Set(items)
      for (const item of itemHeights.keys()) {
        if (!currentItems.has(item)) itemHeights.delete(item)
      }
    })
  })

  const liveItems = createMemo(() => {
    if (props.expanded) return props.items
    return displayedItems().slice(committedCount())
  })
  const viewportHeight = () => {
    const available = Math.max(0, dimensions().height - props.footerHeight)
    if (props.expanded) return available
    return Math.min(Math.max(1, liveHeight()), available)
  }

  return (
    <scrollbox
      ref={(value) => {
        viewport = Option.some(value)
      }}
      height={viewportHeight()}
      minHeight={0}
      overflow="hidden"
      // Measure content without the current viewport height as a limit.
      viewportOptions={{ overflow: "scroll" }}
      // Let the live tail shrink after leading messages enter native history.
      contentOptions={{ minHeight: 0 }}
      flexShrink={1}
      stickyScroll
      stickyStart="bottom"
      focusable={false}
      verticalScrollbarOptions={{ visible: false }}
    >
      <box
        flexDirection="column"
        flexShrink={0}
        onSizeChange={function () {
          if (props.expanded || props.overlayOpen) return
          setLiveHeight(this.height)
        }}
      >
        <For each={liveItems()}>
          {(item, index) => (
            <box
              flexDirection="column"
              flexShrink={0}
              onSizeChange={function () {
                if (itemHeights.get(item) === this.height) return
                itemHeights.set(item, this.height)
                setMeasurementVersion((version) => version + 1)
              }}
            >
              {props.renderItems([item], props.streaming && index() === liveItems().length - 1)}
            </box>
          )}
        </For>
        {props.children}
      </box>
    </scrollbox>
  )
}
