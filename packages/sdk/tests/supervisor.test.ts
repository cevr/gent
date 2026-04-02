import { describe, test, expect } from "bun:test"
import { Effect, Exit, Fiber } from "effect"
import {
  waitForWorkerRunning,
  type WorkerLifecycleState,
  type WorkerSupervisor,
} from "../src/supervisor"

/**
 * Minimal fake supervisor for testing waitForWorkerRunning.
 * Only implements getState + subscribe.
 */
function fakeSupervisor(initial: WorkerLifecycleState): Pick<
  WorkerSupervisor,
  "getState" | "subscribe"
> & {
  emit: (state: WorkerLifecycleState) => void
} {
  let current = initial
  const listeners = new Set<(state: WorkerLifecycleState) => void>()
  return {
    getState: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      listener(current)
      return () => {
        listeners.delete(listener)
      }
    },
    emit: (state) => {
      current = state
      for (const listener of listeners) listener(state)
    },
  }
}

const running: WorkerLifecycleState = { _tag: "running", port: 0, pid: 1, restartCount: 0 }
const starting: WorkerLifecycleState = { _tag: "starting", port: 0, restartCount: 0 }
const stopped: WorkerLifecycleState = { _tag: "stopped", port: 0, restartCount: 0 }
const failed: WorkerLifecycleState = {
  _tag: "failed",
  port: 0,
  restartCount: 0,
  message: "crash loop",
  exitCode: 1,
}

describe("waitForWorkerRunning", () => {
  test("resolves immediately when already running", async () => {
    const sup = fakeSupervisor(running)
    await Effect.runPromise(waitForWorkerRunning(sup))
  })

  test("resolves when supervisor transitions to running", async () => {
    const sup = fakeSupervisor(starting)
    const fiber = Effect.runFork(waitForWorkerRunning(sup))
    // Give the fiber a tick to register
    await Bun.sleep(10)
    sup.emit(running)
    const exit = await Fiber.await(fiber).pipe(Effect.runPromise)
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  test("fails when supervisor is already stopped", async () => {
    const sup = fakeSupervisor(stopped)
    const exit = await Effect.runPromiseExit(waitForWorkerRunning(sup))
    expect(Exit.isFailure(exit)).toBe(true)
  })

  test("fails when supervisor is already failed", async () => {
    const sup = fakeSupervisor(failed)
    const exit = await Effect.runPromiseExit(waitForWorkerRunning(sup))
    expect(Exit.isFailure(exit)).toBe(true)
  })

  test("fails when supervisor transitions to stopped", async () => {
    const sup = fakeSupervisor(starting)
    const fiber = Effect.runFork(waitForWorkerRunning(sup))
    await Bun.sleep(10)
    sup.emit(stopped)
    const exit = await Fiber.await(fiber).pipe(Effect.runPromise)
    expect(Exit.isFailure(exit)).toBe(true)
  })

  test("fails when supervisor transitions to failed", async () => {
    const sup = fakeSupervisor(starting)
    const fiber = Effect.runFork(waitForWorkerRunning(sup))
    await Bun.sleep(10)
    sup.emit(failed)
    const exit = await Fiber.await(fiber).pipe(Effect.runPromise)
    expect(Exit.isFailure(exit)).toBe(true)
  })

  test("cleans up subscription on interrupt", async () => {
    const sup = fakeSupervisor(starting)
    const fiber = Effect.runFork(waitForWorkerRunning(sup))
    await Bun.sleep(10)
    // Interrupt the fiber
    await Fiber.interrupt(fiber).pipe(Effect.runPromise)
    // After interrupt, emitting should not throw (listener was removed)
    sup.emit(running)
    // If we get here without error, cleanup worked
  })
})
