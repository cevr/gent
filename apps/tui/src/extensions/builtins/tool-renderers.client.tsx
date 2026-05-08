/**
 * Todo-tools TUI widget — transport-only.
 *
 * Transport-only widget. The widget owns its own Solid signal inside an
 * Effect-typed setup, fetched via the
 * typed transport (`requestExtension(ref(TodoListRequest))`) and refreshed
 * when todo state-change pulses arrive on the active session stream.
 *
 * Lifecycle: setup runs once per `ExtensionUIProvider` mount via
 * `runtime.runPromise`. The Solid `createRoot` disposer and the pulse
 * unsubscribe are registered with `ClientLifecycle.addCleanup`; the
 * provider's `onCleanup` runs them when it unmounts, so this widget
 * leaves no detached root behind.
 */
import { createMemo } from "solid-js"
import { Effect } from "effect"
import {
  defineClientExtension,
  borderLabelContribution,
  clientContributions,
  clientCommandContribution,
  interactionRendererContribution,
  overlayContribution,
  rendererContribution,
  widgetContribution,
} from "../client-facets.js"
import { TodoWidget, type TodoPreview } from "../../components/todo-widget"
import { TodoDialog } from "../../components/todo-dialog"
import { BUILTIN_TOOL_RENDERERS } from "../../components/tool-renderers/index"
import { PromptRenderer } from "../../components/interaction-renderers/prompt"
import { AskUserRenderer } from "../../components/interaction-renderers/ask-user"
import { type TodoEntry, TODO_EXTENSION_ID, TodoListRequest } from "@gent/extensions/client.js"
import { ref } from "@gent/core/extensions/api"
import { ClientTransport, requestExtension } from "../client-transport"
import {
  ClientShell,
  ClientComposer,
  ClientLifecycle,
  makeClientSessionResource,
} from "../client-services"
import { useScopedKeyboard } from "../../keyboard/context"

const EXT_ID = TODO_EXTENSION_ID

export const builtinTools = defineClientExtension("@gent/tools", {
  setup: Effect.gen(function* () {
    const shell = yield* ClientShell
    return clientContributions(
      ...BUILTIN_TOOL_RENDERERS.map((entry) =>
        rendererContribution(entry.toolNames, entry.component, { headless: entry.headless }),
      ),
      clientCommandContribution({
        id: "tools.review",
        title: "Review",
        description: "Run adversarial dual-model code review",
        category: "Tools",
        slash: "review",
        onSelect: () =>
          shell.sendMessage(
            "Use the review tool in report mode on the most recent changes. Focus on correctness, edge cases, and architectural issues.",
          ),
        onSlash: (args) =>
          shell.sendMessage(
            args.trim().length > 0
              ? `Use the review tool in report mode: ${args.trim()}`
              : "Use the review tool in report mode on the most recent changes. Focus on correctness, edge cases, and architectural issues.",
          ),
      }),
      clientCommandContribution({
        id: "tools.counsel",
        title: "Counsel",
        description: "Get a cross-vendor second opinion",
        category: "Tools",
        slash: "counsel",
        onSelect: () =>
          shell.sendMessage(
            "Use the counsel tool in standard mode to get a second opinion on the current approach.",
          ),
        onSlash: (args) =>
          shell.sendMessage(
            args.trim().length > 0
              ? `Use the counsel tool: ${args.trim()}`
              : "Use the counsel tool in standard mode to get a second opinion on the current approach.",
          ),
      }),
      clientCommandContribution({
        id: "tools.research",
        title: "Research",
        description: "Research external repositories",
        category: "Tools",
        slash: "research",
        onSelect: () =>
          shell.sendMessage(
            "Use the research tool to understand how an external library or framework works. Ask me which repo to research.",
          ),
        onSlash: (args) =>
          shell.sendMessage(
            args.trim().length > 0
              ? `Use the research tool: ${args.trim()}`
              : "Use the research tool to understand how an external library or framework works. Ask me which repo to research.",
          ),
      }),
      clientCommandContribution({
        id: "tools.loop",
        title: "Loop",
        description: "Iterate until condition met",
        category: "Tools",
        slash: "loop",
        onSelect: () =>
          shell.sendMessage(
            "Use the loop tool to iterate on the current todo until complete or a condition is met.",
          ),
        onSlash: (args) =>
          shell.sendMessage(
            args.trim().length > 0
              ? `Use the loop tool: ${args.trim()}`
              : "Use the loop tool to iterate on the current todo until complete or a condition is met.",
          ),
      }),
    )
  }),
})

export const builtinInteractions = defineClientExtension("@gent/interaction-tools", {
  setup: Effect.succeed(
    clientContributions(
      interactionRendererContribution(PromptRenderer),
      interactionRendererContribution(PromptRenderer, "prompt"),
      interactionRendererContribution(AskUserRenderer, "ask-user"),
    ),
  ),
})

export const builtinTodos = defineClientExtension("@gent/todo", {
  setup: Effect.gen(function* () {
    const transport = yield* ClientTransport
    const shell = yield* ClientShell
    const composer = yield* ClientComposer
    const lifecycle = yield* ClientLifecycle

    const isTodoMutation = (event: { readonly _tag: string; readonly extensionId?: string }) =>
      event._tag === "ExtensionStateChanged" && event.extensionId === EXT_ID

    const todosResource = yield* makeClientSessionResource<readonly TodoEntry[]>({
      transport,
      lifecycle,
      cast: shell.cast,
      label: `${EXT_ID} todo list`,
      fetch: (session) => requestExtension(ref(TodoListRequest), {}, transport, session),
      subscribe: (refetch) =>
        transport.onSessionEvent((envelope) => {
          if (isTodoMutation(envelope.event)) refetch()
        }),
    })
    const liveTodos = (): readonly TodoEntry[] => todosResource.read() ?? []

    const runningCount = (): number =>
      liveTodos().filter((t) => t.status === "in_progress" || t.status === "pending").length

    const TodoDialogOverlay = (overlayProps: { open: boolean; onClose: () => void }) => (
      <TodoDialog open={overlayProps.open} onClose={overlayProps.onClose} todos={liveTodos()} />
    )

    const TrackedTodoWidget = () => {
      const previews = createMemo((): TodoPreview[] =>
        liveTodos().map((t) => ({ subject: t.subject, status: t.status })),
      )
      return <TodoWidget previewTodos={previews()} />
    }

    // Down-arrow opens todos dialog when draft is empty and todos are running.
    // Registers per render via `useScopedKeyboard` so unmount cleans up.
    const TodoTracker = () => {
      useScopedKeyboard(
        (event) => {
          if (event.name !== "down") return false
          const cs = composer.state()
          if (cs.draft !== "" || !cs.inputFocused) return false
          if (runningCount() === 0) return false
          shell.openOverlay("todos-dialog")
          return true
        },
        { when: () => runningCount() > 0 },
      )
      return null
    }

    return clientContributions(
      widgetContribution({
        id: "todos",
        slot: "below-messages",
        priority: 20,
        component: TrackedTodoWidget,
      }),
      widgetContribution({
        id: "todo-tracker",
        slot: "below-input",
        priority: 999,
        component: TodoTracker,
      }),
      overlayContribution({
        id: "todos-dialog",
        component: TodoDialogOverlay,
      }),
      clientCommandContribution({
        id: "todos-dialog",
        title: "Todos",
        description: "View and manage todos",
        category: "Todos",
        keybind: "ctrl+shift+t",
        slash: "todos",
        onSelect: () => shell.openOverlay("todos-dialog"),
      }),
      borderLabelContribution({
        position: "bottom-left",
        priority: 50,
        produce: () => {
          const count = runningCount()
          if (count === 0) return []
          return [{ text: `${count} todo${count > 1 ? "s" : ""} ↓`, color: "info" }]
        },
      }),
    )
  }),
})

export default builtinTodos
