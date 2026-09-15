/** @jsxImportSource @opentui/solid */
import { describe, it, expect } from "effect-bun-test"
import { createEffect, onMount } from "solid-js"
import { Effect, Option, Predicate } from "effect"
import { BranchId, SessionId, dateFromMillis } from "@gent/core/protocol"
import { CommandPalette } from "../../src/components/command-palette"
import { useCommand } from "../../src/command/context"
import { useClient } from "../../src/client"
import type { ClientContextValue } from "../../src/client/context"
import { createMockClient, renderFrame, renderWithProviders } from "../render-harness-boundary"
import { waitForRenderedFrame } from "../helpers-boundary"

const absent = Option.getOrUndefined(Option.none())

function OpenPaletteOnMount() {
  const command = useCommand()
  createEffect(() => {
    command.openPalette()
  })
  return <CommandPalette />
}

function ClientProbe(props: { readonly onReady: (client: ClientContextValue) => void }) {
  const client = useClient()
  onMount(() => {
    props.onReady(client)
  })
  return <box />
}

describe("CommandPalette renderer", () => {
  it.live("opens the theme submenu through keyboard navigation and activation", () =>
    Effect.gen(function* () {
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <OpenPaletteOnMount />, {
          width: 90,
          height: 28,
        }),
      )
      expect(renderFrame(setup)).toContain("Commands")
      setup.mockInput.pressArrow("down")
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressKey("RETURN")
      yield* Effect.promise(() => setup.renderOnce())
      // The theme level enumerates the catalog; Dark/Light is the Mode level.
      const frame = renderFrame(setup)
      expect(frame).toContain("System")
      expect(frame).toContain("fx")
      expect(frame).toContain("opencode")
    }),
  )

  it.live("wraps the cursor at both ends through the shared list", () =>
    Effect.gen(function* () {
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <OpenPaletteOnMount />, { width: 90, height: 28 }),
      )
      yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (frame) => frame.includes("Commands") && frame.includes("Branches"),
          "commands root",
        ),
      )
      // Up from the first row lands on the last: Branches, whose level shows
      // "Back" in the footer where the root shows "Close".
      setup.mockInput.pressArrow("up")
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("Esc Back"), "branches level"),
      )
      setup.mockInput.pressEscape()
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("Esc Close"), "root again"),
      )
      // Down from the last row lands on the first: Sessions.
      setup.mockInput.pressArrow("up")
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressArrow("down")
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("+ New Session"), "sessions level"),
      )
    }),
  )

  it.live("switches sessions through the sessions palette", () =>
    Effect.gen(function* () {
      let ctx: Option.Option<ClientContextValue> = Option.none()
      const alphaSessionId = SessionId.make("session-alpha")
      const alphaBranchId = BranchId.make("branch-alpha")
      const betaSessionId = SessionId.make("session-beta")
      const betaBranchId = BranchId.make("branch-beta")
      const client = createMockClient({
        session: {
          list: () =>
            Effect.succeed([
              {
                id: alphaSessionId,
                activeBranchId: alphaBranchId,
                name: "Alpha",
                createdAt: dateFromMillis(0),
                updatedAt: dateFromMillis(1),
              },
              {
                id: betaSessionId,
                activeBranchId: betaBranchId,
                name: "Beta",
                createdAt: dateFromMillis(1),
                updatedAt: dateFromMillis(2),
              },
            ]),
        },
      })
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <OpenPaletteOnMount />
              <ClientProbe onReady={(value) => (ctx = Option.some(value))} />
            </>
          ),
          {
            client,
            initialSession: {
              id: alphaSessionId,
              activeBranchId: alphaBranchId,
              name: "Alpha",
              createdAt: dateFromMillis(0),
              updatedAt: dateFromMillis(1),
            },
            width: 90,
            height: 28,
          },
        ),
      )
      if (Option.isNone(ctx)) return yield* Effect.die("client context not ready")
      yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (frame) => frame.includes("Commands") && frame.includes("Sessions"),
          "commands root",
        ),
      )
      setup.mockInput.pressEnter()
      yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (frame) => frame.includes("Sessions") && frame.includes("Beta"),
          "sessions level",
        ),
      )
      setup.mockInput.pressArrow("down")
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (frame) => !frame.includes("Sessions"),
          "sessions palette closed",
        ),
      )
      expect(ctx.value.session()).toEqual({
        sessionId: betaSessionId,
        branchId: betaBranchId,
        name: "Beta",
        modelId: absent,
        reasoningLevel: absent,
      })
    }),
  )

  it.live("creates palette sessions with workspace cwd", () =>
    Effect.gen(function* () {
      let ctx: Option.Option<ClientContextValue> = Option.none()
      const createdSessionId = SessionId.make("session-created")
      const createdBranchId = BranchId.make("branch-created")
      const createInputs: Array<{
        cwd?: string
        requestId?: string
      }> = []
      const workspaceCwd = process.cwd()
      const client = createMockClient({
        session: {
          create: (input: { cwd?: string; requestId?: string }) =>
            Effect.sync(() => {
              createInputs.push(input)
              return {
                sessionId: createdSessionId,
                branchId: createdBranchId,
                name: "Created",
              }
            }),
        },
      })
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <OpenPaletteOnMount />
              <ClientProbe onReady={(value) => (ctx = Option.some(value))} />
            </>
          ),
          {
            client,
            cwd: workspaceCwd,
            width: 90,
            height: 28,
          },
        ),
      )
      yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (frame) => frame.includes("Commands") && frame.includes("Sessions"),
          "commands root",
        ),
      )
      if (Option.isNone(ctx)) return yield* Effect.die("client context not ready")
      setup.mockInput.pressEnter()
      yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (frame) => frame.includes("Sessions") && frame.includes("+ New Session"),
          "sessions level",
        ),
      )
      setup.mockInput.pressEnter()
      yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (frame) => !frame.includes("Sessions"),
          "palette closed after create",
        ),
      )
      expect(createInputs).toHaveLength(1)
      const firstInput = Option.fromNullishOr(createInputs[0])
      if (Option.isNone(firstInput)) return yield* Effect.die("session create was not called")
      expect(firstInput.value.cwd).toBe(workspaceCwd)
      expect(Predicate.isString(firstInput.value.requestId)).toBe(true)
      // The created session becomes the active one; the shell mounts what the
      // client says, so there is no second place a navigation could go wrong.
      expect(ctx.value.session()).toEqual({
        sessionId: createdSessionId,
        branchId: createdBranchId,
        name: "Created",
        modelId: absent,
        reasoningLevel: absent,
      })
    }),
  )
})
