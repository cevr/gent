import { describe, expect, test } from "bun:test"
import {
  ComposerInteractionState,
  transitionComposerInteraction,
} from "../src/components/composer-interaction-state"
import type { AutocompleteContribution } from "../src/extensions/client-facets.js"

const testContributions: AutocompleteContribution[] = [
  { _tag: "autocomplete", prefix: "$", title: "Skills", items: () => [] },
  { _tag: "autocomplete", prefix: "@", title: "Files", items: () => [] },
  { _tag: "autocomplete", prefix: "/", title: "Commands", items: () => [] },
]

describe("transitionComposerInteraction", () => {
  test("derives mention autocomplete from draft changes", () => {
    const next = transitionComposerInteraction(
      ComposerInteractionState.initial(),
      { _tag: "DraftChanged", text: "ask @dee" },
      testContributions,
    )

    expect(next.draft).toBe("ask @dee")
    expect(next.autocomplete).toEqual({
      type: "@",
      filter: "dee",
      triggerPos: 4,
    })
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
    expect(edited.autocomplete).toBeNull()
    expect(exited.mode).toBe("editing")
  })

  test("detects inline trigger $ from contributions", () => {
    const next = transitionComposerInteraction(
      ComposerInteractionState.initial(),
      { _tag: "DraftChanged", text: "use $eff" },
      testContributions,
    )
    expect(next.autocomplete).toEqual({ type: "$", filter: "eff", triggerPos: 4 })
  })

  test("does not detect unregistered prefix", () => {
    const next = transitionComposerInteraction(
      ComposerInteractionState.initial(),
      { _tag: "DraftChanged", text: "use #tag" },
      testContributions,
    )
    expect(next.autocomplete).toBeNull()
  })

  test("detects custom inline prefix when registered", () => {
    const custom: AutocompleteContribution[] = [
      { _tag: "autocomplete", prefix: "#", title: "Tags", items: () => [] },
    ]
    const next = transitionComposerInteraction(
      ComposerInteractionState.initial(),
      { _tag: "DraftChanged", text: "use #tag" },
      custom,
    )
    expect(next.autocomplete).toEqual({ type: "#", filter: "tag", triggerPos: 4 })
  })

  test("no contributions means no autocomplete detection", () => {
    const next = transitionComposerInteraction(
      ComposerInteractionState.initial(),
      { _tag: "DraftChanged", text: "ask @dee" },
      [],
    )
    expect(next.autocomplete).toBeNull()
  })

  test("restore and clear draft close autocomplete", () => {
    const withAutocomplete = transitionComposerInteraction(
      ComposerInteractionState.initial(),
      { _tag: "DraftChanged", text: "/" },
      testContributions,
    )
    expect(withAutocomplete.autocomplete).not.toBeNull()

    const restored = transitionComposerInteraction(withAutocomplete, {
      _tag: "RestoreDraft",
      text: "previous prompt",
    })
    const cleared = transitionComposerInteraction(restored, { _tag: "ClearDraft" })

    expect(restored.draft).toBe("previous prompt")
    expect(restored.autocomplete).toBeNull()
    expect(cleared.draft).toBe("")
    expect(cleared.autocomplete).toBeNull()
  })
})
