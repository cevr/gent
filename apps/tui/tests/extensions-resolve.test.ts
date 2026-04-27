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
  type OverlayProps,
  type WidgetComponent,
} from "../src/extensions/client-facets.js"
import { resolveTuiExtensions, type LoadedTuiExtension } from "../src/extensions/resolve"
import type { ToolRenderer } from "../src/components/tool-renderers/types"

const make = (
  id: string,
  scope: "builtin" | "user" | "project",
  contributions: ReadonlyArray<ClientContribution>,
): LoadedTuiExtension => ({ id, scope, filePath: `/test/${id}`, contributions })

const renderer = (label: string): ToolRenderer => (() => label) as unknown as ToolRenderer

const widget =
  (label: string): WidgetComponent =>
  () =>
    label
const overlay = (label: string) => (_props: OverlayProps) => label

describe("resolveTuiExtensions", () => {
  test("client contribution constructors enforce slot-specific component contracts", () => {
    const good = widgetContribution({
      id: "typed-widget",
      slot: "below-input",
      component: widget("typed"),
    })

    widgetContribution({
      id: "bad-widget",
      slot: "below-input",
      // @ts-expect-error — widgets receive no props; overlays own open/onClose props
      component: (_props: OverlayProps) => "bad",
    })
    // @ts-expect-error — composer surfaces receive ComposerSurfaceProps, not overlay props
    composerSurfaceContribution((_props: OverlayProps) => "bad")

    expect(good._tag).toBe("widget")
  })

  test("higher scope wins for visible renderer surfaces", () => {
    const resolved = resolveTuiExtensions([
      make("builtin-tools", "builtin", [rendererContribution(["bash"], renderer("builtin"))]),
      make("user-tools", "user", [rendererContribution(["bash"], renderer("user"))]),
      make("project-tools", "project", [rendererContribution(["bash"], renderer("project"))]),
    ])

    expect((resolved.renderers.get("bash") as () => string)()).toBe("project")
  })

  test("widgets stay user-ordered by priority after scope resolution", () => {
    const resolved = resolveTuiExtensions([
      make("builtin-low", "builtin", [
        widgetContribution({
          id: "status",
          slot: "below-messages",
          priority: 30,
          component: widget("builtin"),
        }),
      ]),
      make("project-override", "project", [
        widgetContribution({
          id: "status",
          slot: "above-input",
          priority: 10,
          component: widget("project"),
        }),
        widgetContribution({
          id: "secondary",
          slot: "below-messages",
          priority: 20,
          component: widget("secondary"),
        }),
      ]),
    ])

    expect(resolved.widgets.map((entry) => entry.id)).toEqual(["status", "secondary"])
    expect(resolved.widgets[0]?.slot).toBe("above-input")
  })

  test("higher-scope commands keep the visible slash and keybind affordances", () => {
    const resolved = resolveTuiExtensions([
      make("builtin-command", "builtin", [
        clientCommandContribution({
          id: "cmd-old",
          title: "Old",
          slash: "deploy",
          keybind: "ctrl+k",
          onSelect: () => {},
        }),
      ]),
      make("project-command", "project", [
        clientCommandContribution({
          id: "cmd-new",
          title: "New",
          slash: "deploy",
          keybind: "ctrl+k",
          onSelect: () => {},
        }),
      ]),
    ])

    const oldCommand = resolved.commands.find((command) => command.id === "cmd-old")
    const newCommand = resolved.commands.find((command) => command.id === "cmd-new")

    expect(newCommand?.slash).toBe("deploy")
    expect(newCommand?.keybind).toBe("ctrl+k")
    expect(oldCommand?.slash).toBeUndefined()
    expect(oldCommand?.keybind).toBeUndefined()
  })

  test("interaction renderers resolve by metadata type with scope precedence", () => {
    const resolved = resolveTuiExtensions([
      make("builtin-default", "builtin", [interactionRendererContribution(widget("default"))]),
      make("builtin-ask", "builtin", [interactionRendererContribution(widget("ask"), "ask-user")]),
      make("project-ask", "project", [
        interactionRendererContribution(widget("project-ask"), "ask-user"),
      ]),
    ])

    expect((resolved.interactionRenderers.get(undefined) as () => string)()).toBe("default")
    expect((resolved.interactionRenderers.get("ask-user") as () => string)()).toBe("project-ask")
  })

  test("overlay surfaces use scope precedence and same-scope collisions still fail loudly", () => {
    const resolved = resolveTuiExtensions([
      make("builtin-overlay", "builtin", [
        overlayContribution({ id: "modal", component: overlay("builtin") }),
      ]),
      make("project-overlay", "project", [
        overlayContribution({ id: "modal", component: overlay("project") }),
      ]),
    ])

    expect((resolved.overlays.get("modal") as () => string)()).toBe("project")

    expect(() =>
      resolveTuiExtensions([
        make("a", "user", [overlayContribution({ id: "dup", component: overlay("a") })]),
        make("b", "user", [overlayContribution({ id: "dup", component: overlay("b") })]),
      ]),
    ).toThrow(/Same-scope TUI overlay collision/)
  })

  test("composer surfaces stay single-winner by scope and still fail on same-scope collisions", () => {
    const resolved = resolveTuiExtensions([
      make("builtin-composer", "builtin", [composerSurfaceContribution(widget("builtin"))]),
      make("project-composer", "project", [composerSurfaceContribution(widget("project"))]),
    ])

    expect((resolved.composerSurface as () => string)()).toBe("project")

    expect(() =>
      resolveTuiExtensions([
        make("a", "builtin", [composerSurfaceContribution(widget("a"))]),
        make("b", "builtin", [composerSurfaceContribution(widget("b"))]),
      ]),
    ).toThrow(/Same-scope TUI composer surface collision/)
  })

  test("border labels remain collected and priority sorted", () => {
    const resolved = resolveTuiExtensions([
      make("builtin-label", "builtin", [
        borderLabelContribution({
          position: "top-left",
          priority: 30,
          produce: () => [{ text: "30", color: "info" }],
        }),
      ]),
      make("project-labels", "project", [
        borderLabelContribution({
          position: "bottom-left",
          priority: 20,
          produce: () => [{ text: "20", color: "success" }],
        }),
        borderLabelContribution({
          position: "top-right",
          priority: 10,
          produce: () => [{ text: "10", color: "warning" }],
        }),
      ]),
    ])

    expect(resolved.borderLabels.map((label) => label.priority)).toEqual([10, 20, 30])
  })

  test("autocomplete contributions stay scope ordered and additive", () => {
    const resolved = resolveTuiExtensions([
      make("builtin-autocomplete", "builtin", [
        autocompleteContribution({ prefix: "$", title: "Skills", items: () => [] }),
      ]),
      make("user-autocomplete", "user", [
        autocompleteContribution({ prefix: "/", title: "Commands", items: () => [] }),
      ]),
      make("project-autocomplete", "project", [
        autocompleteContribution({ prefix: "@", title: "Files", items: () => [] }),
      ]),
    ])

    expect(resolved.autocompleteItems.map((entry) => entry.prefix)).toEqual(["$", "/", "@"])
  })

  test("same-scope command collisions still fail loudly", () => {
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

  test("unknown contribution tags still fail loudly", () => {
    const bogus = { _tag: "bogus-kind", payload: "ignored" } as unknown as ClientContribution
    expect(() => resolveTuiExtensions([make("a", "user", [bogus])])).toThrow(
      /Unknown TUI client contribution tag/,
    )
  })
})
