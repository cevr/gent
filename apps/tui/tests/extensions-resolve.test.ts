import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { AgentEvent } from "@gent/core-internal/domain/event"
import { BranchId, InteractionRequestId, SessionId } from "@gent/core-internal/domain/ids"
import {
  autocompleteContribution,
  borderLabelContribution,
  clientContributions,
  clientCommandContribution,
  composerSurfaceContribution,
  interactionRendererContribution,
  overlayContribution,
  rendererContribution,
  widgetContribution,
  type ClientContributions,
  type ComposerSurfaceProps,
  type OverlayProps,
  type WidgetComponent,
} from "../src/extensions/client-facets.js"
import { resolveTuiExtensions, type LoadedTuiExtension } from "../src/extensions/resolve"
import type { ToolRenderer, ToolRendererProps } from "../src/components/tool-renderers/types"
import type { HeadlessToolRenderer } from "../src/headless-tool-renderers"

const make = (
  id: string,
  scope: "builtin" | "user" | "project",
  contributions: ClientContributions,
): LoadedTuiExtension => ({ id, scope, filePath: `/test/${id}`, contributions })

const renderer =
  (label: string): ToolRenderer =>
  (_props: ToolRendererProps) =>
    label
const headless =
  (label: string): HeadlessToolRenderer =>
  () =>
    Option.some(label)

const widget =
  (label: string): WidgetComponent =>
  () =>
    label
const overlay = (label: string) => (_props: OverlayProps) => label
const absent = Option.getOrUndefined(Option.none())
const toolProps: ToolRendererProps = {
  toolCall: {
    id: "test-tool-call",
    toolName: "bash",
    status: "completed",
    input: {},
    summary: "",
    output: "",
  },
  expanded: false,
}
const interactionProps = {
  event: AgentEvent.cases.InteractionPresented.make({
    sessionId: SessionId.make("session-test"),
    branchId: BranchId.make("branch-test"),
    requestId: InteractionRequestId.make("request-test"),
    text: "test",
    metadata: absent,
  }),
  resolve: () => {},
}
const overlayProps: OverlayProps = { open: true, onClose: () => {} }
const composerProps = {
  draft: "",
  setDraft: (_text: string) => {},
  submit: () => {},
  focused: false,
  mode: "editing",
} satisfies ComposerSurfaceProps

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

    expect(good.widgets?.[0]?.id).toBe("typed-widget")
  })

  test("higher scope wins for visible renderer surfaces", () => {
    const resolved = resolveTuiExtensions([
      make("builtin-tools", "builtin", rendererContribution(["bash"], renderer("builtin"))),
      make("user-tools", "user", rendererContribution(["bash"], renderer("user"))),
      make("project-tools", "project", rendererContribution(["bash"], renderer("project"))),
    ])

    const bashRenderer = Option.fromNullishOr(resolved.renderers.get("bash"))
    expect(Option.isSome(bashRenderer)).toBe(true)
    if (Option.isNone(bashRenderer)) return
    expect(bashRenderer.value(toolProps)).toBe("project")
  })

  test("headless renderer surfaces use the same renderer scope precedence", () => {
    const resolved = resolveTuiExtensions([
      make(
        "builtin-tools",
        "builtin",
        rendererContribution(["bash"], renderer("builtin"), { headless: headless("builtin") }),
      ),
      make(
        "project-tools",
        "project",
        rendererContribution(["bash"], renderer("project"), { headless: headless("project") }),
      ),
    ])

    const resolvedRenderer = Option.getOrElse(
      Option.fromNullishOr(resolved.headlessRenderers.get("bash")),
      () => headless("missing"),
    )
    expect(
      resolvedRenderer({
        toolName: "bash",
        status: "running",
        input: Option.none(),
        output: Option.none(),
        summary: Option.none(),
      }),
    ).toEqual(Option.some("project"))
  })

  test("widgets stay user-ordered by priority after scope resolution", () => {
    const resolved = resolveTuiExtensions([
      make(
        "builtin-low",
        "builtin",
        widgetContribution({
          id: "status",
          slot: "below-messages",
          priority: 30,
          component: widget("builtin"),
        }),
      ),
      make(
        "project-override",
        "project",
        clientContributions(
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
        ),
      ),
    ])

    expect(resolved.widgets.map((entry) => entry.id)).toEqual(["status", "secondary"])
    expect(resolved.widgets[0]?.slot).toBe("above-input")
  })

  test("higher-scope commands keep the visible slash and keybind affordances", () => {
    const resolved = resolveTuiExtensions([
      make(
        "builtin-command",
        "builtin",
        clientCommandContribution({
          id: "cmd-old",
          title: "Old",
          slash: "deploy",
          keybind: "ctrl+k",
          onSelect: () => {},
        }),
      ),
      make(
        "project-command",
        "project",
        clientCommandContribution({
          id: "cmd-new",
          title: "New",
          slash: "deploy",
          keybind: "ctrl+k",
          onSelect: () => {},
        }),
      ),
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
      make("builtin-default", "builtin", interactionRendererContribution(widget("default"))),
      make("builtin-ask", "builtin", interactionRendererContribution(widget("ask"), "ask-user")),
      make(
        "project-ask",
        "project",
        interactionRendererContribution(widget("project-ask"), "ask-user"),
      ),
    ])

    const defaultRenderer = Option.fromNullishOr(resolved.interactionRenderers.get(absent))
    const askRenderer = Option.fromNullishOr(resolved.interactionRenderers.get("ask-user"))
    expect(Option.isSome(defaultRenderer)).toBe(true)
    expect(Option.isSome(askRenderer)).toBe(true)
    if (Option.isNone(defaultRenderer) || Option.isNone(askRenderer)) return
    expect(defaultRenderer.value(interactionProps)).toBe("default")
    expect(askRenderer.value(interactionProps)).toBe("project-ask")
  })

  test("overlay surfaces use scope precedence and same-scope collisions still fail loudly", () => {
    const resolved = resolveTuiExtensions([
      make(
        "builtin-overlay",
        "builtin",
        overlayContribution({ id: "modal", component: overlay("builtin") }),
      ),
      make(
        "project-overlay",
        "project",
        overlayContribution({ id: "modal", component: overlay("project") }),
      ),
    ])

    const modal = Option.fromNullishOr(resolved.overlays.get("modal"))
    expect(Option.isSome(modal)).toBe(true)
    if (Option.isNone(modal)) return
    expect(modal.value(overlayProps)).toBe("project")

    expect(() =>
      resolveTuiExtensions([
        make("a", "user", overlayContribution({ id: "dup", component: overlay("a") })),
        make("b", "user", overlayContribution({ id: "dup", component: overlay("b") })),
      ]),
    ).toThrow(/Same-scope TUI overlay collision/)
  })

  test("composer surfaces stay single-winner by scope and still fail on same-scope collisions", () => {
    const resolved = resolveTuiExtensions([
      make("builtin-composer", "builtin", composerSurfaceContribution(widget("builtin"))),
      make("project-composer", "project", composerSurfaceContribution(widget("project"))),
    ])

    const composerSurface = Option.fromNullishOr(resolved.composerSurface)
    expect(Option.isSome(composerSurface)).toBe(true)
    if (Option.isNone(composerSurface)) return
    expect(composerSurface.value(composerProps)).toBe("project")

    expect(() =>
      resolveTuiExtensions([
        make("a", "builtin", composerSurfaceContribution(widget("a"))),
        make("b", "builtin", composerSurfaceContribution(widget("b"))),
      ]),
    ).toThrow(/Same-scope TUI composer surface collision/)
  })

  test("border labels remain collected and priority sorted", () => {
    const resolved = resolveTuiExtensions([
      make(
        "builtin-label",
        "builtin",
        borderLabelContribution({
          position: "top-left",
          priority: 30,
          produce: () => [{ text: "30", color: "info" }],
        }),
      ),
      make(
        "project-labels",
        "project",
        clientContributions(
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
        ),
      ),
    ])

    expect(resolved.borderLabels.map((label) => label.priority)).toEqual([10, 20, 30])
  })

  test("autocomplete contributions stay scope ordered and additive", () => {
    const resolved = resolveTuiExtensions([
      make(
        "builtin-autocomplete",
        "builtin",
        autocompleteContribution({ prefix: "$", title: "Skills", items: () => [] }),
      ),
      make(
        "user-autocomplete",
        "user",
        autocompleteContribution({ prefix: "/", title: "Commands", items: () => [] }),
      ),
      make(
        "project-autocomplete",
        "project",
        autocompleteContribution({ prefix: "@", title: "Files", items: () => [] }),
      ),
    ])

    expect(resolved.autocompleteItems.map((entry) => entry.prefix)).toEqual(["$", "/", "@"])
  })

  test("same-scope command collisions still fail loudly", () => {
    expect(() =>
      resolveTuiExtensions([
        make(
          "a",
          "builtin",
          clientCommandContribution({ id: "x", title: "A", onSelect: () => {} }),
        ),
        make(
          "b",
          "builtin",
          clientCommandContribution({ id: "x", title: "B", onSelect: () => {} }),
        ),
      ]),
    ).toThrow(/Same-scope TUI command collision/)
  })
})
