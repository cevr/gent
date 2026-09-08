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
import { RendererContext, useRenderer, writeSolidToScrollback } from "@opentui/solid"
import type { ScrollBoxRenderable } from "@opentui/core"
import { Effect, Option, Schema } from "effect"
import { useTerminalDimensions } from "../terminal-dimensions"
import { useScopedKeyboard } from "../keyboard/context"
import type { SessionItem } from "./message-list"
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

const fingerprint = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/** Owns native history snapshots. The session feed remains the source of truth. */
export function NativeTranscript(props: NativeTranscriptProps) {
  const renderer = useRenderer()
  const owner = getOwner()
  const dimensions = useTerminalDimensions()
  const [ready, setReady] = createSignal(false)
  const [nativeOutputReady, setNativeOutputReady] = createSignal(false)
  const [committedCount, setCommittedCount] = createSignal(0)
  const [committedRows, setCommittedRows] = createSignal(0)
  const [liveHeight, setLiveHeight] = createSignal(0)
  const [measurementVersion, setMeasurementVersion] = createSignal(0)
  const itemHeights = new Map<SessionItem, number>()
  let committed: string[] = []
  let partialFingerprint = Option.none<string>()
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
      partialFingerprint = Option.none()
      setCommittedCount(0)
      setCommittedRows(0)
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

  const write = (items: SessionItem[], rows?: { start: number; count: number }) => {
    // Native history replaces transcript rows. Reserve only the composer while committing it.
    const previousFooterHeight = renderer.footerHeight
    Effect.runSync(
      Effect.sync(() => {
        renderer.footerHeight = props.footerHeight
        writeSolidToScrollback(renderer, () => {
          const snapshotRenderer = useRenderer()
          let disposeSnapshot = () => {}
          onCleanup(() => disposeSnapshot())
          return runWithOwner(owner, () =>
            createRoot((dispose) => {
              disposeSnapshot = dispose
              return (
                <RendererContext.Provider value={snapshotRenderer}>
                  {Option.match(Option.fromNullishOr(rows), {
                    onNone: () => props.renderItems(items, false),
                    onSome: (slice) => (
                      <box height={slice.count} overflow="hidden" flexShrink={0}>
                        <box position="absolute" top={-slice.start} width="100%" flexShrink={0}>
                          {props.renderItems(items, false)}
                        </box>
                      </box>
                    ),
                  })}
                </RendererContext.Provider>
              )
            }),
          )
        })
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            // Restoring the surface also flushes the queued snapshot before it grows.
            renderer.footerHeight = previousFooterHeight
          }),
        ),
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
      // Layout and content changes invalidate saved rows and partial-item offsets.
      // Clear before the layout frame; replay only after its measurements arrive.
      renderer.resetSplitFooterForReplay({ clearSavedLines: replayPending() })
      renderer.requestRender()
    }
    if (!settlingNative) setNativeOutputReady(true)
  })

  createEffect(() => {
    if (!nativeOutputReady()) return
    const nextDisplayRevision = props.displayRevision
    if (displayRevision === nextDisplayRevision) return
    untrack(() => {
      renderer.resetSplitFooterForReplay()
      displayRevision = nextDisplayRevision
      setDisplayBoundary(captureTranscriptDisplay(props.items))
      committed = []
      partialFingerprint = Option.none()
      setCommittedCount(0)
      setCommittedRows(0)
    })
  })

  createEffect(() => {
    if (!nativeOutputReady() || props.streaming || props.expanded || props.overlayOpen) return
    const items = displayedItems()
    const next = items.map((item) => fingerprint(item))
    measurementVersion()
    const available = Math.max(0, dimensions().height - props.footerHeight)
    untrack(() => {
      const prefixMatches =
        committed.every((value, index) => next[index] === value) &&
        Option.match(partialFingerprint, {
          onNone: () => true,
          onSome: (value) => next[committed.length] === value,
        })
      if (!prefixMatches) {
        requestReplay()
        return
      }
      let remainingHeight = 0
      for (const item of items.slice(committed.length)) {
        remainingHeight += itemHeights.get(item) ?? 0
      }
      let nextCount = committed.length
      let rowOffset = committedRows()
      remainingHeight -= rowOffset
      while (nextCount < items.length && remainingHeight > available) {
        const item = items[nextCount]
        if (!item) break
        const height = Option.fromNullishOr(itemHeights.get(item))
        if (Option.isNone(height) || remainingHeight <= available) break
        const rows = Math.min(height.value - rowOffset, remainingHeight - available)
        if (rows <= 0) break
        write([item], { start: rowOffset, count: rows })
        remainingHeight -= rows
        rowOffset += rows
        if (rowOffset < height.value) break
        rowOffset = 0
        nextCount++
      }
      committed = next.slice(0, nextCount)
      partialFingerprint = Option.none()
      if (rowOffset > 0) partialFingerprint = Option.fromNullishOr(next[nextCount])
      setCommittedCount(nextCount)
      setCommittedRows(rowOffset)
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
          {(item, index) => {
            const offset = () => {
              if (props.expanded || index() > 0) return 0
              return committedRows()
            }
            const height = () => {
              measurementVersion()
              if (offset() === 0) return "auto"
              return Math.max(0, (itemHeights.get(item) ?? 0) - offset())
            }
            return (
              <box flexDirection="column" flexShrink={0} height={height()} overflow="hidden">
                <box
                  flexDirection="column"
                  flexShrink={0}
                  top={-offset()}
                  onSizeChange={function () {
                    if (itemHeights.get(item) === this.height) return
                    itemHeights.set(item, this.height)
                    setMeasurementVersion((version) => version + 1)
                  }}
                >
                  {props.renderItems([item], props.streaming && index() === liveItems().length - 1)}
                </box>
              </box>
            )
          }}
        </For>
        {props.children}
      </box>
    </scrollbox>
  )
}
