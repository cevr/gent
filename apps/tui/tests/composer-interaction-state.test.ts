import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import {
  ComposerInteractionState,
  transitionComposerInteraction,
} from "../src/components/composer-interaction-state"
import type { AutocompleteContribution } from "../src/extensions/client-facets.js"

const testContributions: AutocompleteContribution[] = [
  { prefix: "$", title: "Skills", items: () => [] },
  { prefix: "@", title: "Files", items: () => [] },
  { prefix: "/", title: "Commands", items: () => [] },
]

describe("transitionComposerInteraction", () => {
  test("derives mention autocomplete from draft changes", () => {
    const next = transitionComposerInteraction(
      ComposerInteractionState.initial(),
      { _tag: "DraftChanged", text: "ask @dee" },
      testContributions,
    )

    expect(next.draft).toBe("ask @dee")
    expect(next.autocomplete).toEqual(
      Option.some({
        type: "@",
        filter: "dee",
        triggerPos: 4,
      }),
    )
  })

  test("shell mode suppresses autocomplete until exit", () => {
    const shell = transitionComposerInteraction(ComposerInteractionState.initial(), {
      _tag: "EnterShell",
    })
    const edited = transitionComposerInteraction(shell, {
      _tag: "DraftChanged",
      text: "ls -la",
    })
    const exited = transitionComposerInteraction(edited, { _tag: "ExitShell" })

    expect(edited.mode).toBe("shell")
    expect(Option.isNone(edited.autocomplete)).toBe(true)
    expect(exited.mode).toBe("editing")
  })

  test("detects inline trigger $ from contributions", () => {
    const next = transitionComposerInteraction(
      ComposerInteractionState.initial(),
      { _tag: "DraftChanged", text: "use $eff" },
      testContributions,
    )
    expect(next.autocomplete).toEqual(Option.some({ type: "$", filter: "eff", triggerPos: 4 }))
  })

  test("does not detect unregistered prefix", () => {
    const next = transitionComposerInteraction(
      ComposerInteractionState.initial(),
      { _tag: "DraftChanged", text: "use #tag" },
      testContributions,
    )
    expect(Option.isNone(next.autocomplete)).toBe(true)
  })

  test("detects custom inline prefix when registered", () => {
    const custom: AutocompleteContribution[] = [{ prefix: "#", title: "Tags", items: () => [] }]
    const next = transitionComposerInteraction(
      ComposerInteractionState.initial(),
      { _tag: "DraftChanged", text: "use #tag" },
      custom,
    )
    expect(next.autocomplete).toEqual(Option.some({ type: "#", filter: "tag", triggerPos: 4 }))
  })

  test("no contributions means no autocomplete detection", () => {
    const next = transitionComposerInteraction(
      ComposerInteractionState.initial(),
      { _tag: "DraftChanged", text: "ask @dee" },
      [],
    )
    expect(Option.isNone(next.autocomplete)).toBe(true)
  })

  test("restore and clear draft close autocomplete", () => {
    const withAutocomplete = transitionComposerInteraction(
      ComposerInteractionState.initial(),
      { _tag: "DraftChanged", text: "/" },
      testContributions,
    )
    expect(Option.isSome(withAutocomplete.autocomplete)).toBe(true)

    const restored = transitionComposerInteraction(withAutocomplete, {
      _tag: "RestoreDraft",
      text: "previous prompt",
    })
    const cleared = transitionComposerInteraction(restored, { _tag: "ClearDraft" })

    expect(restored.draft).toBe("previous prompt")
    expect(Option.isNone(restored.autocomplete)).toBe(true)
    expect(cleared.draft).toBe("")
    expect(Option.isNone(cleared.autocomplete)).toBe(true)
  })
})
