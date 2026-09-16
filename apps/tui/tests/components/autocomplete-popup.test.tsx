/** @jsxImportSource @opentui/solid */
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
import { describe, expect, it } from "effect-bun-test"
import { Effect } from "effect"
import { AutocompletePopup } from "../../src/components/autocomplete-popup"
import { useExtensionUI } from "../../src/extensions/context"
import { useScopedKeyboard } from "../../src/keyboard/context"
import type { AutocompleteItem } from "../../src/extensions/client-facets.js"
import { renderWithProviders } from "../render-harness-boundary"
import { waitForRenderedFrame } from "../helpers-boundary"

const slashItems: ReadonlyArray<AutocompleteItem> = [
  { id: "alpha", label: "/alpha", description: "first" },
  { id: "beta", label: "/beta" },
  { id: "gamma", label: "/gamma" },
]

/** Registers the slash contribution before the popup mounts and fetches. */
function Contribute(props: { readonly items: ReadonlyArray<AutocompleteItem> }) {
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
              <Contribute items={slashItems} />
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
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("/gamma"), "items"),
      )
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
              <Contribute items={[]} />
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
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("No matches"), "empty"),
      )
      setup.mockInput.pressEnter()
      setup.mockInput.pressArrow("down")
      yield* Effect.promise(() => setup.renderOnce())
      expect(picked).toEqual([])
      expect(seen).toEqual(["return", "down"])
      // Escape still closes the popup.
      setup.mockInput.pressEscape()
      yield* Effect.promise(() => waitForRenderedFrame(setup, () => closed === 1, "closed"))
      expect(seen).toEqual(["return", "down"])
    }),
  )
})
