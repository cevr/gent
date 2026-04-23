import { describe, expect, test } from "bun:test"
import {
  autocompleteContribution,
  borderLabelContribution,
  clientCommandContribution,
  interactionRendererContribution,
  rendererContribution,
  widgetContribution,
  type ClientContribution,
} from "../src/extensions/client-facets.js"
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

describe("resolveTuiExtensions", () => {
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
          produce: () => [{ text: "20", color: "ok" }],
        }),
        borderLabelContribution({
          position: "top-right",
          priority: 10,
          produce: () => [{ text: "10", color: "warn" }],
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
})
