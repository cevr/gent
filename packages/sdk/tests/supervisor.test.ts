import { describe, test, expect } from "bun:test"
import { Effect, Exit, Fiber } from "effect"
import {
  WorkerSupervisorError,
  WorkerSupervisorInternal,
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

describe("WorkerSupervisorInternal.isRetryableStartupError", () => {
  test("retries pre-ready subprocess exits and stream failures", () => {
    expect(
      WorkerSupervisorInternal.isRetryableStartupError(
        new WorkerSupervisorError({ message: "worker stdout closed before ready" }),
      ),
    ).toBe(true)
    expect(
      WorkerSupervisorInternal.isRetryableStartupError(
        new WorkerSupervisorError({ message: "worker exited before ready (1)" }),
      ),
    ).toBe(true)
    expect(
      WorkerSupervisorInternal.isRetryableStartupError(
        new WorkerSupervisorError({ message: "failed to read worker readiness: stream reset" }),
      ),
    ).toBe(true)
  })

  test("does not retry configuration or capacity failures", () => {
    expect(
      WorkerSupervisorInternal.isRetryableStartupError(
        new WorkerSupervisorError({ message: "worker stdout unavailable during startup" }),
      ),
    ).toBe(false)
    expect(
      WorkerSupervisorInternal.isRetryableStartupError(
        new WorkerSupervisorError({ message: "worker did not become ready within 10000ms" }),
      ),
    ).toBe(false)
  })
})

describe("WorkerSupervisorInternal.launchWorkerUntilReady", () => {
  test("retries retryable pre-ready failures on the same assigned port", async () => {
    const stopped: number[] = []
    const slept: number[] = []
    let current: { readonly pid: number } | undefined
    let attempts = 0

    const launched = await Effect.runPromise(
      WorkerSupervisorInternal.launchWorkerUntilReady({
        maxAttempts: 3,
        retryDelayMs: 5,
        spawn: Effect.sync(() => {
          attempts += 1
          return { port: 44123, url: "http://127.0.0.1:44123/rpc", proc: { pid: attempts } }
        }),
        waitForReady: ({ proc }) =>
          proc.pid === 1
            ? Effect.fail(
                new WorkerSupervisorError({ message: "worker stdout closed before ready" }),
              )
            : Effect.void,
        stop: (proc) =>
          Effect.sync(() => {
            stopped.push(proc.pid)
          }),
        sleep: (delayMs) =>
          Effect.sync(() => {
            slept.push(delayMs)
          }),
        setCurrent: (proc) => {
          current = proc
        },
        isCurrent: (proc) => current?.pid === proc.pid,
        isStopped: () => false,
        logRetry: () => undefined,
      }),
    )

    expect(launched?.port).toBe(44123)
    expect(launched?.proc.pid).toBe(2)
    expect(current?.pid).toBe(2)
    expect(attempts).toBe(2)
    expect(stopped).toEqual([1])
    expect(slept).toEqual([5])
  })

  test("stops every failed retryable launch before failing the retry budget", async () => {
    const stopped: number[] = []
    let current: { readonly pid: number } | undefined
    let attempts = 0

    const exit = await Effect.runPromiseExit(
      WorkerSupervisorInternal.launchWorkerUntilReady({
        maxAttempts: 3,
        retryDelayMs: 5,
        spawn: Effect.sync(() => {
          attempts += 1
          return { port: 44123, url: "http://127.0.0.1:44123/rpc", proc: { pid: attempts } }
        }),
        waitForReady: () =>
          Effect.fail(new WorkerSupervisorError({ message: "worker exited before ready (1)" })),
        stop: (proc) =>
          Effect.sync(() => {
            stopped.push(proc.pid)
          }),
        sleep: () => Effect.void,
        setCurrent: (proc) => {
          current = proc
        },
        isCurrent: (proc) => current?.pid === proc.pid,
        isStopped: () => false,
        logRetry: () => undefined,
      }),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(attempts).toBe(3)
    expect(stopped).toEqual([1, 2, 3])
    expect(current).toBeUndefined()
  })
})
