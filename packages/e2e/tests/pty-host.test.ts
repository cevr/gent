/**
 * The terminal host keeps one program on a live pty and answers other
 * processes on a Unix socket: each test serves a real shell program and
 * calls the host through the same client gamut uses.
 */
import { describe, expect, it } from "effect-bun-test"
import { test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { runProcess } from "@gent/core/extensions/api"
import { makeTempDirectoryScoped } from "@gent/core/test-utils"
import { Effect, Fiber, FileSystem, Schedule } from "effect"
import type { RpcClientError } from "effect/rpc/RpcClientError"
import type { SocketError } from "effect/socket/Socket"
import { type HostClient, hostCall, rowsSince, serve } from "../src/pty-host"

describe("rows since the last read", () => {
  test("an unchanged screen adds nothing", () => {
    expect(rowsSince(["a", "b"], ["a", "b"])).toEqual({ added: [], gone: 0 })
  })

  test("rows written below the last read are added", () => {
    expect(rowsSince(["a", "b"], ["a", "b", "c", "d"])).toEqual({ added: ["c", "d"], gone: 0 })
  })

  test("a row that moved as the scrollback grew is not new", () => {
    // The live row `> ` sits under the history; a new history row lands above it.
    expect(rowsSince(["one", "> "], ["one", "two", "> "])).toEqual({ added: ["two"], gone: 0 })
  })

  test("a row drawn over is added, and the row it replaced is gone", () => {
    expect(rowsSince(["a", "working 1s", "z"], ["a", "working 2s", "z"])).toEqual({
      added: ["working 2s"],
      gone: 1,
    })
  })

  test("the first read has every row", () => {
    expect(rowsSince([], ["a", "b"])).toEqual({ added: ["a", "b"], gone: 0 })
  })
})

const SIZE = { cols: 60, rows: 12 }

type Call = <A, E>(
  use: (host: HostClient) => Effect.Effect<A, E>,
) => Effect.Effect<A, E | RpcClientError | SocketError>

/** Serve `script` under `sh` for the test's scope; the host stops on `down` or with the scope. */
const hosted = (script: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* makeTempDirectoryScoped("gent-pty-host-")
    const socket = `${dir}/host.sock`
    const fiber = yield* serve({
      socket,
      cwd: dir,
      command: ["/bin/sh", "-c", script],
      // oxlint-disable-next-line effect/noGlobals -- the program needs the caller's PATH to find its tools
      env: { PATH: Bun.env["PATH"] ?? "/usr/bin:/bin" },
      ...SIZE,
    }).pipe(Effect.forkScoped)
    // The socket file appears once the server listens.
    yield* fs.exists(socket).pipe(
      Effect.repeat({ until: (listening) => listening, schedule: Schedule.spaced("20 millis") }),
      Effect.timeoutOrElse({
        duration: "5 seconds",
        orElse: () => Effect.die(new Error("the host never listened")),
      }),
    )
    const call: Call = (use) => hostCall(socket, use)
    return { call, fiber, dir }
  })

/** Whether process `pid` is alive. */
const alive = (pid: number) =>
  Effect.try(() => process.kill(pid, 0)).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  )

/** The ids a program script wrote to `<dir>/pids`, one per start. */
const startedPids = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    if (!(yield* fs.exists(`${dir}/pids`))) return []
    const text = yield* fs.readFileString(`${dir}/pids`)
    return text
      .split("\n")
      .filter((line) => line !== "")
      .map(Number)
  })

/** Wait until every program the script started has exited, failing loudly when one survives. */
const allExited = (dir: string) =>
  startedPids(dir).pipe(
    Effect.flatMap((pids) => Effect.forEach(pids, alive)),
    Effect.repeat({
      until: (states) => states.every((state) => !state),
      schedule: Schedule.spaced("50 millis"),
    }),
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () => Effect.die(new Error("a program outlived its host")),
    }),
  )

/** A program that records its id, then waits. */
const RECORDS_ITS_PID = `echo $$ >> pids; exec sleep 60`

/** Read the screen until `text` is on it, failing loudly when it never is. */
const screenShows = (call: Call, text: string) =>
  call((host) => host.read({ scope: "screen" })).pipe(
    Effect.repeat({
      until: (screen) => screen.rows.some((row) => row.includes(text)),
      schedule: Schedule.spaced("50 millis"),
    }),
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () => Effect.die(new Error(`the screen never showed ${text}`)),
    }),
  )

describe("terminal host", () => {
  it.live(
    "typed text and keys reach the program, and a read has only the rows added since the last",
    () =>
      Effect.gen(function* () {
        const { call } = yield* hosted(
          `printf 'hello\\n'; while read line; do echo "got $line"; done`,
        )
        yield* screenShows(call, "hello")
        expect((yield* call((host) => host.read({ scope: "changes" }))).rows).toEqual(["hello"])
        yield* call((host) =>
          host.type({ text: "abc" }).pipe(Effect.andThen(host.keys({ names: ["enter"] }))),
        )
        yield* screenShows(call, "got abc")
        // The pty echoes the typed line, then the program answers it.
        expect((yield* call((host) => host.read({ scope: "changes" }))).rows).toEqual([
          "abc",
          "got abc",
        ])
        expect((yield* call((host) => host.read({ scope: "changes" }))).rows).toEqual([])
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("15 seconds")),
  )

  it.live("an unknown key is refused by name, and nothing is written", () =>
    Effect.gen(function* () {
      const { call } = yield* hosted(`while read line; do echo "got $line"; done`)
      const refused = yield* call((host) => host.keys({ names: ["enter", "nope"] })).pipe(
        Effect.flip,
      )
      expect(refused._tag).toBe("@gent/e2e/UnknownKey")
      expect(refused.message).toContain("no key named nope")
      // Had the refused call written its enter, the program would answer an empty line first.
      yield* call((host) =>
        host.type({ text: "abc" }).pipe(Effect.andThen(host.keys({ names: ["enter"] }))),
      )
      yield* screenShows(call, "got abc")
      expect((yield* call((host) => host.read({ scope: "changes" }))).rows).toEqual([
        "abc",
        "got abc",
      ])
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("15 seconds")),
  )

  it.live("a program that exits leaves its last screen and its code, and takes no more input", () =>
    Effect.gen(function* () {
      const { call } = yield* hosted(`echo bye; exit 3`)
      yield* screenShows(call, "bye")
      const screen = yield* call((host) => host.read({ scope: "full" })).pipe(
        Effect.repeat({
          until: (read) => "exited" in read,
          schedule: Schedule.spaced("50 millis"),
        }),
        Effect.timeout("5 seconds"),
      )
      expect(screen.exited).toBe(3)
      const refused = yield* call((host) => host.type({ text: "x" })).pipe(Effect.flip)
      expect(refused._tag).toBe("@gent/e2e/ProgramExited")
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("15 seconds")),
  )

  it.live("restart quits the program with ctrl+c and starts the new one on a fresh mark", () =>
    Effect.gen(function* () {
      const { call } = yield* hosted(`printf 'first\\n'; exec sleep 60`)
      yield* screenShows(call, "first")
      yield* call((host) => host.read({ scope: "changes" }))
      yield* call((host) =>
        host.restart({ command: ["/bin/sh", "-c", "printf 'second\\n'; exec sleep 60"] }),
      )
      yield* screenShows(call, "second")
      const rows = (yield* call((host) => host.read({ scope: "changes" }))).rows
      expect(rows).toContain("second")
      expect(rows).not.toContain("first")
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("20 seconds")),
  )

  it.live("two restarts at once leave one program running", () =>
    Effect.gen(function* () {
      const { call, dir } = yield* hosted(RECORDS_ITS_PID)
      yield* startedPids(dir).pipe(
        Effect.repeat({
          until: (pids) => pids.length === 1,
          schedule: Schedule.spaced("20 millis"),
        }),
        Effect.timeout("5 seconds"),
      )
      // Each restart's program carries `marker` as its shell's `$0`, so the
      // process table counts them: a program the other restart quit may
      // never have run a line.
      const marker = `${dir}/restarted`
      const again = ["/bin/sh", "-c", "sleep 60; :", marker] as const
      yield* Effect.all(
        [
          call((host) => host.restart({ command: again })),
          call((host) => host.restart({ command: again })),
        ],
        { concurrency: "unbounded" },
      )
      // A restart returns once its program has started and the one before
      // it has exited, so the count is final here.
      const ps = yield* runProcess("ps", ["-axo", "args="])
      expect(ps.stdout.split("\n").filter((line) => line.includes(marker))).toHaveLength(1)
      expect(yield* Effect.forEach(yield* startedPids(dir), alive)).toEqual([false])
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("20 seconds")),
  )

  it.live("an interrupted host closes its program", () =>
    Effect.gen(function* () {
      const { fiber, dir } = yield* hosted(RECORDS_ITS_PID)
      yield* startedPids(dir).pipe(
        Effect.repeat({
          until: (pids) => pids.length === 1,
          schedule: Schedule.spaced("20 millis"),
        }),
        Effect.timeout("5 seconds"),
      )
      yield* Fiber.interrupt(fiber)
      yield* allExited(dir)
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("15 seconds")),
  )

  it.live("a host whose socket will not bind fails and closes its program", () =>
    Effect.gen(function* () {
      const dir = yield* makeTempDirectoryScoped("gent-pty-host-")
      // The bind fails before the program could write its id, so the program
      // is found by its directory, which its shell carries as `$0`.
      const served = yield* serve({
        // No such directory, so the server cannot listen.
        socket: `${dir}/missing/host.sock`,
        cwd: dir,
        command: ["/bin/sh", "-c", "sleep 60; :", dir],
        // oxlint-disable-next-line effect/noGlobals -- the program needs the caller's PATH to find its tools
        env: { PATH: Bun.env["PATH"] ?? "/usr/bin:/bin" },
        ...SIZE,
      }).pipe(Effect.exit, Effect.timeout("10 seconds"))
      expect(served._tag).toBe("Failure")
      yield* runProcess("ps", ["-axo", "args="]).pipe(
        Effect.repeat({
          until: (ps) => !ps.stdout.includes(dir),
          schedule: Schedule.spaced("50 millis"),
        }),
        Effect.timeoutOrElse({
          duration: "5 seconds",
          orElse: () => Effect.die(new Error("the program outlived its host")),
        }),
      )
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("15 seconds")),
  )

  it.live("down quits the program and stops the host", () =>
    Effect.gen(function* () {
      const { call, fiber } = yield* hosted(`printf 'up\\n'; exec sleep 60`)
      yield* screenShows(call, "up")
      expect(yield* call((host) => host.down())).toEqual({ killed: false })
      yield* Fiber.join(fiber).pipe(Effect.timeout("5 seconds"))
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("15 seconds")),
  )

  it.live(
    "down kills a program that ignores ctrl+c once the quit deadline passes",
    () =>
      Effect.gen(function* () {
        const { call, fiber } = yield* hosted(
          `trap '' INT; printf 'stubborn\\n'; while :; do sleep 1; done`,
        )
        yield* screenShows(call, "stubborn")
        expect(yield* call((host) => host.down())).toEqual({ killed: true })
        yield* Fiber.join(fiber).pipe(Effect.timeout("5 seconds"))
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("25 seconds")),
    30_000,
  )
})
