import { describe, expect, test } from "bun:test"
import {
  ComposerInteractionState,
  transitionComposerInteraction,
} from "../src/components/composer-interaction-state"

describe("transitionComposerInteraction", () => {
  test("derives mention autocomplete from draft changes", () => {
    const next = transitionComposerInteraction(ComposerInteractionState.initial(), {
      _tag: "DraftChanged",
      text: "ask @dee",
    })

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

  test("restore and clear draft close autocomplete", () => {
    const withAutocomplete = transitionComposerInteraction(ComposerInteractionState.initial(), {
      _tag: "OpenAutocomplete",
      autocomplete: { type: "/", filter: "", triggerPos: 0 },
    })
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
