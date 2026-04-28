/* eslint-disable */
/** @jsxImportSource @opentui/solid */
import { describe, it, expect, test } from "effect-bun-test"
import { createEffect, onMount } from "solid-js"
import { Effect } from "effect"
import { BranchId, SessionId } from "@gent/core/domain/ids"
import { CommandPalette } from "../../src/components/command-palette"
import { useCommand } from "../../src/command"
import { Route, useRouter, type RouterContextValue } from "../../src/router"
import { useClient } from "../../src/client"
import type { ClientContextValue } from "../../src/client/context"
import {
  createMockClient,
  renderFrame,
  renderWithProviders,
} from "../../src/../tests/render-harness"
import { waitForRenderedFrame } from "../../src/../tests/helpers"
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
function RouterProbe(props: { readonly onReady: (router: RouterContextValue) => void }) {
  const router = useRouter()
  onMount(() => {
    props.onReady(router)
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
      const frame = renderFrame(setup)
      expect(frame).toContain("System")
      expect(frame).toContain("Dark")
      expect(frame).toContain("Light")
    }),
  )
  it.live("switches sessions through the sessions palette", () =>
    Effect.gen(function* () {
      let ctx: ClientContextValue | undefined
      let router: RouterContextValue | undefined
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
                branchId: alphaBranchId,
                name: "Alpha",
                createdAt: 0,
                updatedAt: 1,
              },
              {
                id: betaSessionId,
                branchId: betaBranchId,
                name: "Beta",
                createdAt: 1,
                updatedAt: 2,
              },
            ]),
        },
      })
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <OpenPaletteOnMount />
              <ClientProbe onReady={(value) => (ctx = value)} />
              <RouterProbe onReady={(value) => (router = value)} />
            </>
          ),
          {
            client,
            initialSession: {
              id: alphaSessionId,
              branchId: alphaBranchId,
              name: "Alpha",
              createdAt: 0,
              updatedAt: 1,
            },
            initialRoute: Route.session(alphaSessionId, alphaBranchId),
            width: 90,
            height: 28,
          },
        ),
      )
      if (ctx === undefined || router === undefined) {
        throw new Error("client or router context not ready")
      }
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
      expect(router.route()).toEqual(Route.session(betaSessionId, betaBranchId))
      expect(ctx.session()).toEqual({
        sessionId: betaSessionId,
        branchId: betaBranchId,
        name: "Beta",
        reasoningLevel: undefined,
      })
    }),
  )
  it.live("creates palette sessions with workspace cwd", () =>
    Effect.gen(function* () {
      let router: RouterContextValue | undefined
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
              <RouterProbe onReady={(value) => (router = value)} />
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
      if (router === undefined) throw new Error("router context not ready")
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
      expect(createInputs[0]?.cwd).toBe(workspaceCwd)
      expect(typeof createInputs[0]?.requestId).toBe("string")
      expect(router.route()).toEqual(Route.session(createdSessionId, createdBranchId))
    }),
  )
})
