/** @jsxImportSource @opentui/solid */
/**
 * The docked pane box shared by the agents, thread, and settings panes.
 *
 * A Dock's height is its fixed body plus the chrome rows mounted inside it.
 * These prove the derived height matches what reaches the screen, and that
 * the three panes that use it agree on that arithmetic.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Option } from "effect"
import { createSignal } from "solid-js"
import { BranchId, Model, ModelId, ProviderId, SessionId } from "@gent/core/protocol"
import type { AgentRowEntry } from "@gent/extensions/client"
import { ChromePanel, DOCK_BODY_ROWS } from "../../src/components/chrome-panel"
import { modelRows, SettingsPicker } from "../../src/components/settings-picker"
import { AgentsPane } from "../../src/extensions/builtins/agents-view.client"
import { ThreadPane, type ThreadWindow } from "../../src/extensions/builtins/thread-view.client"
import { renderFrame, renderWithProviders } from "../render-harness-boundary"
import { waitForRenderedFrame } from "../helpers-boundary"

/** Rows the pane box occupies on screen: top border through bottom border. */
const renderedPaneRows = (frame: string): number => {
  const lines = frame.split("\n")
  const top = lines.findIndex((line) => line.includes("╭"))
  const bottom = lines.findIndex((line) => line.includes("╰"))
  expect(top).toBeGreaterThanOrEqual(0)
  expect(bottom).toBeGreaterThan(top)
  return bottom - top + 1
}

const BORDER_ROWS = 2

describe("ChromePanel.Dock", () => {
  it.live("its derived height is the body plus the chrome rows it actually mounts", () =>
    Effect.gen(function* () {
      const [error, setError] = createSignal(Option.none<string>())
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <ChromePanel.Dock title="Dock">
              <ChromePanel.Section>
                <text>query</text>
              </ChromePanel.Section>
              <ChromePanel.Body>
                <text>row</text>
              </ChromePanel.Body>
              <ChromePanel.Section>
                <text>detail</text>
              </ChromePanel.Section>
              <ChromePanel.Error error={Option.getOrUndefined(error())} />
              <ChromePanel.Footer>footer</ChromePanel.Footer>
            </ChromePanel.Dock>
          ),
          { width: 80, height: 40 },
        ),
      )
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("footer"), "dock"),
      )
      // Two sections and a footer: three chrome rows.
      expect(renderedPaneRows(renderFrame(setup))).toBe(BORDER_ROWS + DOCK_BODY_ROWS + 3)

      // An error row mounts: the pane grows by exactly that row.
      setError(Option.some("boom"))
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("boom"), "error row"),
      )
      expect(renderedPaneRows(renderFrame(setup))).toBe(BORDER_ROWS + DOCK_BODY_ROWS + 4)

      // It unmounts: the pane gives the row back.
      setError(Option.none())
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => !frame.includes("boom"), "error gone"),
      )
      expect(renderedPaneRows(renderFrame(setup))).toBe(BORDER_ROWS + DOCK_BODY_ROWS + 3)
    }),
  )

  it.live("a section outside a Dock counts nothing", () =>
    Effect.gen(function* () {
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <ChromePanel.Root title="Float" width={40} height={6} left={0} top={0}>
              <ChromePanel.Section>
                <text>float</text>
              </ChromePanel.Section>
              <ChromePanel.Footer>footer</ChromePanel.Footer>
            </ChromePanel.Root>
          ),
          { width: 80, height: 40 },
        ),
      )
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("footer"), "float"),
      )
      expect(renderedPaneRows(renderFrame(setup))).toBe(6)
    }),
  )
})

const sessionId = SessionId.make("s1")
const branchId = BranchId.make("s1-branch")

const agentRow: AgentRowEntry = {
  sessionId,
  branchId,
  section: "inactive",
  name: "Alpha",
  live: false,
  depth: 0,
}

const threadWindow: ThreadWindow = {
  sessionId,
  branchId,
  sessionName: "Session s1",
  index: 1,
  firstMessageId: "u1",
  lastMessageId: "a1",
  count: 2,
  summary: Option.none(),
  summarizedCount: 0,
  omittedCount: 0,
  preview: "first ask",
  updatedAt: 0,
}

describe("docked panes", () => {
  it.live(
    "agents, thread, and settings panes all keep the same body and count their own chrome",
    () =>
      Effect.gen(function* () {
        const agents = yield* Effect.promise(() =>
          renderWithProviders(
            () => (
              <AgentsPane
                open={true}
                controller={{
                  rows: () => [agentRow],
                  current: () => Option.none(),
                  error: () => Option.none(),
                  loading: () => false,
                  refresh: () => {},
                  detail: () => Option.none(),
                  select: () => {},
                  open: () => true,
                  setOpen: () => {},
                }}
                onSelect={() => {}}
                onToggle={() => {}}
                onDelete={() => {}}
                onClose={() => {}}
              />
            ),
            { width: 80, height: 40 },
          ),
        )
        yield* Effect.promise(() =>
          waitForRenderedFrame(agents, (frame) => frame.includes("^t hide"), "agents pane"),
        )
        // Border, query row, detail section, footer.
        expect(renderedPaneRows(renderFrame(agents))).toBe(BORDER_ROWS + DOCK_BODY_ROWS + 3)
        agents.renderer.destroy()

        const thread = yield* Effect.promise(() =>
          renderWithProviders(
            () => (
              <ThreadPane
                open={true}
                controller={{
                  windows: () => [threadWindow],
                  sessions: () => 1,
                  current: () => Option.some({ sessionId, branchId }),
                  error: () => Option.none(),
                  loading: () => false,
                  refresh: () => {},
                  open: () => true,
                  setOpen: () => {},
                }}
                onSelect={() => {}}
                onClose={() => {}}
              />
            ),
            { width: 80, height: 40 },
          ),
        )
        yield* Effect.promise(() =>
          waitForRenderedFrame(thread, (frame) => frame.includes("open session"), "thread pane"),
        )
        // Border, detail section, footer: no query row.
        expect(renderedPaneRows(renderFrame(thread))).toBe(BORDER_ROWS + DOCK_BODY_ROWS + 2)
        thread.renderer.destroy()

        const settings = yield* Effect.promise(() =>
          renderWithProviders(
            () => (
              <SettingsPicker
                open={true}
                title="Model"
                rows={modelRows([
                  new Model({
                    id: ModelId.make("anthropic/claude-sonnet-5"),
                    name: "Claude Sonnet 5",
                    provider: ProviderId.make("test"),
                  }),
                ])}
                current={Option.none()}
                onSelect={() => {}}
                onClose={() => {}}
              />
            ),
            { width: 80, height: 40 },
          ),
        )
        yield* Effect.promise(() =>
          waitForRenderedFrame(settings, (frame) => frame.includes("Model · 1"), "settings pane"),
        )
        // Border, query row, footer: no detail section.
        expect(renderedPaneRows(renderFrame(settings))).toBe(BORDER_ROWS + DOCK_BODY_ROWS + 2)
      }),
  )
})
