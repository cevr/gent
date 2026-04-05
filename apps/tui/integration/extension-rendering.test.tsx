/** @jsxImportSource @opentui/solid */

import { describe, expect, test } from "bun:test"
import { onMount } from "solid-js"
import type { BranchId, SessionId } from "@gent/core/domain/ids"
import { Session } from "../src/routes/session"
import { Route } from "../src/router"
import { useExtensionUI, type ExtensionSnapshot } from "../src/extensions/context"
import { destroyRenderSetup, renderWithProviders } from "../tests/render-harness"
import { waitForRenderedFrame } from "../tests/helpers"

const SESSION_ID = "test-session" as SessionId
const BRANCH_ID = "test-branch" as BranchId

function SnapshotProbe(props: {
  readonly onReady: (update: (snapshot: ExtensionSnapshot) => void) => void
}) {
  const ext = useExtensionUI()
  onMount(() => props.onReady(ext.updateSnapshot))
  return <box />
}

const snap = (extensionId: string, model: unknown, epoch = 1): ExtensionSnapshot => ({
  sessionId: SESSION_ID,
  branchId: BRANCH_ID,
  extensionId,
  epoch,
  model,
})

describe("extension snapshot rendering", () => {
  test("plan border label renders plan mode", async () => {
    let inject: ((s: ExtensionSnapshot) => void) | undefined
    const setup = await renderWithProviders(
      () => (
        <>
          <SnapshotProbe onReady={(fn) => (inject = fn)} />
          <Session sessionId={SESSION_ID} branchId={BRANCH_ID} />
        </>
      ),
      {
        initialSession: {
          id: SESSION_ID,
          branchId: BRANCH_ID,
          name: "Test",
          createdAt: 0,
          updatedAt: 0,
        },
        initialRoute: Route.session(SESSION_ID, BRANCH_ID),
        width: 100,
        height: 24,
      },
    )

    inject?.(snap("@gent/plan", { mode: "plan", steps: [{ text: "step 1", done: false }] }))

    const frame = await waitForRenderedFrame(setup, (f) => f.includes("plan"), "plan label")
    expect(frame).toContain("plan")
    destroyRenderSetup(setup)
  })

  test("plan border label renders execution progress", async () => {
    let inject: ((s: ExtensionSnapshot) => void) | undefined
    const setup = await renderWithProviders(
      () => (
        <>
          <SnapshotProbe onReady={(fn) => (inject = fn)} />
          <Session sessionId={SESSION_ID} branchId={BRANCH_ID} />
        </>
      ),
      {
        initialSession: {
          id: SESSION_ID,
          branchId: BRANCH_ID,
          name: "Test",
          createdAt: 0,
          updatedAt: 0,
        },
        initialRoute: Route.session(SESSION_ID, BRANCH_ID),
        width: 100,
        height: 24,
      },
    )

    inject?.(
      snap("@gent/plan", {
        mode: "executing",
        progress: { total: 5, completed: 2, inProgress: 1 },
      }),
    )

    const frame = await waitForRenderedFrame(setup, (f) => f.includes("exec"), "exec label")
    expect(frame).toContain("exec")
    expect(frame).toContain("2/5")
    destroyRenderSetup(setup)
  })

  test("auto border label renders iteration count", async () => {
    let inject: ((s: ExtensionSnapshot) => void) | undefined
    const setup = await renderWithProviders(
      () => (
        <>
          <SnapshotProbe onReady={(fn) => (inject = fn)} />
          <Session sessionId={SESSION_ID} branchId={BRANCH_ID} />
        </>
      ),
      {
        initialSession: {
          id: SESSION_ID,
          branchId: BRANCH_ID,
          name: "Test",
          createdAt: 0,
          updatedAt: 0,
        },
        initialRoute: Route.session(SESSION_ID, BRANCH_ID),
        width: 100,
        height: 24,
      },
    )

    inject?.(
      snap("@gent/auto", {
        active: true,
        phase: "working",
        iteration: 3,
        maxIterations: 10,
      }),
    )

    const frame = await waitForRenderedFrame(setup, (f) => f.includes("auto"), "auto label")
    expect(frame).toContain("auto")
    expect(frame).toContain("3/10")
    destroyRenderSetup(setup)
  })

  test("auto counsel phase renders counsel label", async () => {
    let inject: ((s: ExtensionSnapshot) => void) | undefined
    const setup = await renderWithProviders(
      () => (
        <>
          <SnapshotProbe onReady={(fn) => (inject = fn)} />
          <Session sessionId={SESSION_ID} branchId={BRANCH_ID} />
        </>
      ),
      {
        initialSession: {
          id: SESSION_ID,
          branchId: BRANCH_ID,
          name: "Test",
          createdAt: 0,
          updatedAt: 0,
        },
        initialRoute: Route.session(SESSION_ID, BRANCH_ID),
        width: 100,
        height: 24,
      },
    )

    inject?.(
      snap("@gent/auto", {
        active: true,
        phase: "awaiting-counsel",
        iteration: 2,
        maxIterations: 10,
      }),
    )

    const frame = await waitForRenderedFrame(setup, (f) => f.includes("counsel"), "counsel label")
    expect(frame).toContain("counsel")
    expect(frame).toContain("2/10")
    destroyRenderSetup(setup)
  })

  test("task border label renders running count", async () => {
    let inject: ((s: ExtensionSnapshot) => void) | undefined
    const setup = await renderWithProviders(
      () => (
        <>
          <SnapshotProbe onReady={(fn) => (inject = fn)} />
          <Session sessionId={SESSION_ID} branchId={BRANCH_ID} />
        </>
      ),
      {
        initialSession: {
          id: SESSION_ID,
          branchId: BRANCH_ID,
          name: "Test",
          createdAt: 0,
          updatedAt: 0,
        },
        initialRoute: Route.session(SESSION_ID, BRANCH_ID),
        width: 100,
        height: 24,
      },
    )

    inject?.(
      snap("@gent/task-tools", {
        tasks: [
          { id: "t1", subject: "build", status: "in_progress", createdAt: 0 },
          { id: "t2", subject: "test", status: "completed", createdAt: 0 },
        ],
      }),
    )

    const frame = await waitForRenderedFrame(setup, (f) => f.includes("task"), "task label")
    expect(frame).toContain("1 task")
    destroyRenderSetup(setup)
  })
})
