/**
 * TUI extension resolver — per-slot conflict rule regression locks.
 *
 * The `ClientContribution` union has eight kinds, and each kind has its own
 * conflict rule (NOT uniform). These tests pin every rule so future structural
 * refactors can't silently regress merge semantics:
 *
 *   - renderers: last (highest scope) wins by tool name
 *   - widgets:   last (highest scope) wins by widget id; sorted by priority
 *   - commands:  last (highest scope) wins by command id; superseded
 *                keybind/slash entries are stripped from prior owners
 *   - overlays:  last (highest scope) wins by overlay id
 *   - interaction renderers: last (highest scope) wins by metadataType
 *   - composer surface: single slot, last (highest scope) wins
 *   - border labels: collected (no winner), sorted by priority
 *   - autocomplete: collected (no winner), scope-ordered
 *   - same-scope collisions throw across every rule
 */
import { describe, expect, test } from "bun:test"
import {
  autocompleteContribution,
  borderLabelContribution,
  clientCommandContribution,
  composerSurfaceContribution,
  interactionRendererContribution,
  overlayContribution,
  rendererContribution,
  widgetContribution,
  type ClientContribution,
} from "@gent/core/domain/extension-client.js"
import { resolveTuiExtensions, type LoadedTuiExtension } from "../src/extensions/resolve"
import type { ToolRenderer } from "../src/components/tool-renderers/types"

const make = (
  id: string,
  kind: "builtin" | "user" | "project",
  contributions: ReadonlyArray<ClientContribution>,
): LoadedTuiExtension => ({ id, kind, filePath: `/test/${id}`, contributions })

const renderer = (label: string): ToolRenderer => (() => label) as unknown as ToolRenderer

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const widget = (label: string): any => (() => label) as unknown

describe("resolveTuiExtensions — per-slot conflict rules", () => {
  test("renderers: project wins over user wins over builtin", () => {
    const r = resolveTuiExtensions([
      make("a", "builtin", [rendererContribution(["bash"], renderer("builtin"))]),
      make("b", "user", [rendererContribution(["bash"], renderer("user"))]),
      make("c", "project", [rendererContribution(["bash"], renderer("project"))]),
    ])
    expect(r.renderers.get("bash")).toBeDefined()
    // Calling the resolved renderer returns the project label
    expect((r.renderers.get("bash") as () => string)()).toBe("project")
  })

  test("renderers: same-scope collision throws", () => {
    expect(() =>
      resolveTuiExtensions([
        make("a", "builtin", [rendererContribution(["bash"], renderer("a"))]),
        make("b", "builtin", [rendererContribution(["bash"], renderer("b"))]),
      ]),
    ).toThrow(/Same-scope TUI renderer collision/)
  })

  test("widgets: sort by priority ascending", () => {
    const r = resolveTuiExtensions([
      make("a", "builtin", [
        widgetContribution({
          id: "high",
          slot: "below-messages",
          priority: 30,
          component: widget("high"),
        }),
        widgetContribution({
          id: "low",
          slot: "below-messages",
          priority: 10,
          component: widget("low"),
        }),
      ]),
    ])
    expect(r.widgets.map((w) => w.id)).toEqual(["low", "high"])
  })

  test("widgets: project wins over builtin by id", () => {
    const r = resolveTuiExtensions([
      make("a", "builtin", [
        widgetContribution({
          id: "tasks",
          slot: "below-messages",
          component: widget("builtin"),
        }),
      ]),
      make("b", "project", [
        widgetContribution({
          id: "tasks",
          slot: "above-input",
          component: widget("project"),
        }),
      ]),
    ])
    expect(r.widgets).toHaveLength(1)
    expect(r.widgets[0]!.slot).toBe("above-input")
  })

  test("commands: project wins by id, prior keybind/slash stripped from previous owner", () => {
    const r = resolveTuiExtensions([
      make("a", "builtin", [
        clientCommandContribution({
          id: "cmd-old",
          title: "Old",
          slash: "do",
          keybind: "ctrl+x",
          onSelect: () => {},
        }),
      ]),
      make("b", "project", [
        clientCommandContribution({
          id: "cmd-new",
          title: "New",
          slash: "do",
          keybind: "ctrl+x",
          onSelect: () => {},
        }),
      ]),
    ])
    expect(r.commands).toHaveLength(2)
    const old = r.commands.find((c) => c.id === "cmd-old")
    const fresh = r.commands.find((c) => c.id === "cmd-new")
    // Higher-scope owner keeps the keybind and slash
    expect(fresh?.slash).toBe("do")
    expect(fresh?.keybind).toBe("ctrl+x")
    // Lower-scope owner is stripped
    expect(old?.slash).toBeUndefined()
    expect(old?.keybind).toBeUndefined()
  })

  test("commands: same-scope id collision throws", () => {
    expect(() =>
      resolveTuiExtensions([
        make("a", "builtin", [
          clientCommandContribution({ id: "x", title: "A", onSelect: () => {} }),
        ]),
        make("b", "builtin", [
          clientCommandContribution({ id: "x", title: "B", onSelect: () => {} }),
        ]),
      ]),
    ).toThrow(/Same-scope TUI command collision/)
  })

  test("overlays: project wins by id", () => {
    const r = resolveTuiExtensions([
      make("a", "builtin", [overlayContribution({ id: "modal", component: widget("builtin") })]),
      make("b", "project", [overlayContribution({ id: "modal", component: widget("project") })]),
    ])
    expect(r.overlays.size).toBe(1)
    expect((r.overlays.get("modal") as () => string)()).toBe("project")
  })

  test("interaction renderers: distinct metadataType keys keep both; same key project wins", () => {
    const r = resolveTuiExtensions([
      make("a", "builtin", [interactionRendererContribution(widget("default"))]), // metadataType undefined
      make("b", "builtin", [interactionRendererContribution(widget("ask"), "ask-user")]),
      make("c", "project", [interactionRendererContribution(widget("ask-override"), "ask-user")]),
    ])
    expect(r.interactionRenderers.size).toBe(2)
    expect((r.interactionRenderers.get(undefined) as () => string)()).toBe("default")
    expect((r.interactionRenderers.get("ask-user") as () => string)()).toBe("ask-override")
  })

  test("composer surface: single slot, project wins", () => {
    const r = resolveTuiExtensions([
      make("a", "builtin", [composerSurfaceContribution(widget("builtin"))]),
      make("b", "project", [composerSurfaceContribution(widget("project"))]),
    ])
    expect((r.composerSurface as () => string)()).toBe("project")
  })

  test("composer surface: same-scope collision throws", () => {
    expect(() =>
      resolveTuiExtensions([
        make("a", "builtin", [composerSurfaceContribution(widget("a"))]),
        make("b", "builtin", [composerSurfaceContribution(widget("b"))]),
      ]),
    ).toThrow(/Same-scope TUI composer surface collision/)
  })

  test("border labels: collected from all extensions, sorted by priority", () => {
    const r = resolveTuiExtensions([
      make("a", "builtin", [
        borderLabelContribution({
          position: "top-left",
          priority: 30,
          produce: () => [{ text: "30", color: "info" }],
        }),
      ]),
      make("b", "user", [
        borderLabelContribution({
          position: "top-right",
          priority: 10,
          produce: () => [{ text: "10", color: "warn" }],
        }),
      ]),
      // Multiple labels per extension allowed
      make("c", "project", [
        borderLabelContribution({
          position: "bottom-left",
          priority: 20,
          produce: () => [{ text: "20", color: "ok" }],
        }),
      ]),
    ])
    expect(r.borderLabels.map((l) => l.priority)).toEqual([10, 20, 30])
  })

  test("autocomplete: collected from all extensions, scope-ordered, all surfaced", () => {
    const r = resolveTuiExtensions([
      make("a", "project", [
        autocompleteContribution({ prefix: "@", title: "Files", items: () => [] }),
      ]),
      make("b", "builtin", [
        autocompleteContribution({ prefix: "$", title: "Skills", items: () => [] }),
      ]),
      make("c", "user", [
        autocompleteContribution({ prefix: "/", title: "Commands", items: () => [] }),
      ]),
    ])
    // Scope-ordered: builtin → user → project
    expect(r.autocompleteItems.map((c) => c.prefix)).toEqual(["$", "/", "@"])
  })

  test("unknown contribution _kind throws (exhaustiveness gate)", () => {
    // Forge a contribution with a kind the resolver doesn't know about — the
    // entry guard must reject it rather than silently dropping it on the floor.
    const bogus = { _kind: "bogus-kind", payload: "ignored" } as unknown as ClientContribution
    expect(() => resolveTuiExtensions([make("a", "user", [bogus])])).toThrow(
      /Unknown TUI client contribution kind/,
    )
  })
})
