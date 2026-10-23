/**
 * Keep one program on a live pty for other processes:
 * `bun packages/e2e/src/pty-host.ts <config.json>`.
 *
 * The config (`HostConfig`) names the program, its directory, its whole
 * environment, the size and the Unix socket to listen on. The host reads it,
 * removes it (it may hold proxy values), starts the program and answers the
 * `HostRpcs` calls on the socket until a `down` call. A program that exits by
 * itself leaves its last screen to read. `hostCall` is the client: gamut's
 * `send`, `keys`, `read`, `wait`, `restart` and `down` go through it.
 *
 * @module
 */
import { BunRuntime, BunServices, BunSocket, BunSocketServer } from "@effect/platform-bun"
import {
  Array as Arr,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Ref,
  Schema,
  Scope,
} from "effect"
import { Rpc, RpcClient, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc"
import type { RpcClientError } from "effect/rpc/RpcClientError"
import type { SocketError } from "effect/socket/Socket"
import { type HostedTerminal, keys, openHostedTerminal } from "./pty-fixture"

// ── Wire ──

export const HostConfig = Schema.Struct({
  socket: Schema.String,
  cwd: Schema.String,
  command: Schema.NonEmptyArray(Schema.String),
  env: Schema.Record(Schema.String, Schema.String),
  cols: Schema.Int,
  rows: Schema.Int,
})
export type HostConfig = typeof HostConfig.Type

class UnknownKey extends Schema.TaggedError<UnknownKey, { readonly brand: unique symbol }>()(
  "@gent/e2e/UnknownKey",
  { key: Schema.String },
) {
  override get message() {
    return `no key named ${this.key}; keys: ${Object.keys(keys).join(", ")}`
  }
}

class ProgramExited extends Schema.TaggedError<ProgramExited, { readonly brand: unique symbol }>()(
  "@gent/e2e/ProgramExited",
  { code: Schema.Int },
) {
  override get message() {
    return `the program exited ${this.code}`
  }
}

class QuitTimeout extends Schema.TaggedError<QuitTimeout, { readonly brand: unique symbol }>()(
  "@gent/e2e/QuitTimeout",
  {},
) {
  override get message() {
    return `the program has not exited ${QUIT_WITHIN} after ctrl+c; inspect it with read --full`
  }
}

/** What a read saw: the rows, and the exit code once the program has exited. */
export const HostScreen = Schema.Struct({
  rows: Schema.Array(Schema.String),
  /** How many rows of the last read are no longer on the screen or in the scrollback. */
  gone: Schema.Int,
  exited: Schema.optionalKey(Schema.Int),
})
export type HostScreen = typeof HostScreen.Type

class HostRpcs extends RpcGroup.make(
  Rpc.make("type", { payload: { text: Schema.String }, error: ProgramExited }),
  Rpc.make("keys", {
    payload: { names: Schema.Array(Schema.String) },
    error: Schema.Union([UnknownKey, ProgramExited]),
  }),
  /**
   * `changes`: the rows added since the last `changes` or `full` read, from
   * the scrollback and the screen; the first read has every row. `full`: the
   * screen. Both move the mark. `screen`: the screen, the mark left alone.
   */
  Rpc.make("read", {
    payload: { scope: Schema.Literals(["changes", "full", "screen"]) },
    success: HostScreen,
  }),
  Rpc.make("restart", {
    payload: { command: Schema.NonEmptyArray(Schema.String) },
    error: QuitTimeout,
  }),
  /** Quit the program, killing it after `QUIT_WITHIN`, then stop the host. */
  Rpc.make("down", { success: Schema.Struct({ killed: Schema.Boolean }) }),
) {}

// ── Rows since the last read ──

/**
 * The rows of `after` that `before` does not hold in the same order (a
 * longest common subsequence), and how many rows of `before` are gone. A
 * row that moved, as the live area does when the scrollback grows, is not
 * new. Past `LCS_CELLS` the whole middle counts as changed.
 */
export interface RowsSince {
  readonly added: ReadonlyArray<string>
  readonly gone: number
}

export const rowsSince = (
  before: ReadonlyArray<string>,
  after: ReadonlyArray<string>,
): RowsSince => {
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let endBefore = before.length
  let endAfter = after.length
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--
    endAfter--
  }
  const old = before.slice(start, endBefore)
  const next = after.slice(start, endAfter)
  if (old.length * next.length > LCS_CELLS) return { added: next, gone: old.length }
  // `common(i, j)`: the longest common subsequence of `old` from `i` and `next` from `j`.
  const width = next.length + 1
  const table = new Int32Array((old.length + 1) * width)
  const common = (i: number, j: number) => table[i * width + j] ?? 0
  for (let i = old.length - 1; i >= 0; i--) {
    for (let j = next.length - 1; j >= 0; j--) {
      if (old[i] === next[j]) table[i * width + j] = common(i + 1, j + 1) + 1
      else table[i * width + j] = Math.max(common(i + 1, j), common(i, j + 1))
    }
  }
  const added: string[] = []
  let i = 0
  for (const [j, row] of next.entries()) {
    while (i < old.length && old[i] !== row && common(i + 1, j) >= common(i, j + 1)) i++
    if (i < old.length && old[i] === row) i++
    else added.push(row)
  }
  return { added, gone: old.length - common(0, 0) }
}

const LCS_CELLS = 4_000_000

// ── Host ──

/** How long `restart` and `down` press ctrl+c, every `QUIT_EVERY`, for the program to exit. */
const QUIT_WITHIN = "15 seconds"
const QUIT_EVERY = "300 millis"

interface Program {
  readonly terminal: HostedTerminal
  readonly scope: Scope.Closeable
}

const nonBlank = (rows: ReadonlyArray<string>) => rows.filter((row) => row.length > 0)

/** Keep `config.command` on a pty and answer `HostRpcs` on `config.socket` until a `down` call. */
export const serve = Effect.fn("PtyHost.serve")(function* (config: HostConfig) {
  const start = Effect.fn("PtyHost.start")(function* (command: HostConfig["command"]) {
    const scope = yield* Scope.make()
    const terminal = yield* openHostedTerminal({
      command: command[0],
      args: command.slice(1),
      cwd: config.cwd,
      env: config.env,
      size: { cols: config.cols, rows: config.rows },
    }).pipe(Scope.provide(scope))
    return { terminal, scope } satisfies Program
  })

  const program = yield* Ref.make(yield* start(config.command))
  const mark = yield* Ref.make<ReadonlyArray<string>>([])
  const stopped = yield* Deferred.make<void>()

  const exited = (terminal: HostedTerminal) => terminal.exitedWithin("10 millis")

  const write = Effect.fn("PtyHost.write")(function* (bytes: string) {
    const { terminal } = yield* Ref.get(program)
    const code = yield* exited(terminal)
    if (Option.isSome(code)) return yield* new ProgramExited({ code: code.value })
    yield* terminal.write(bytes)
  })

  /** Press ctrl+c until the program exits. */
  const quit = Effect.fn("PtyHost.quit")(function* ({ terminal }: Program) {
    const ended = yield* terminal
      .write(keys["ctrl+c"])
      .pipe(
        Effect.andThen(terminal.exitedWithin(QUIT_EVERY)),
        Effect.repeat({ until: Option.isSome }),
        Effect.timeoutOption(QUIT_WITHIN),
      )
    return Option.isSome(ended)
  })

  const handlers = HostRpcs.toLayer({
    type: ({ text }) => write(text),
    keys: ({ names }) =>
      Effect.forEach(
        names,
        (name): Effect.Effect<void, UnknownKey | ProgramExited> =>
          Option.match(
            Arr.findFirst(Object.entries(keys), ([key]) => key === name),
            {
              onNone: () => Effect.fail(new UnknownKey({ key: name })),
              onSome: ([, bytes]) => write(bytes),
            },
          ),
        { discard: true },
      ),
    read: ({ scope }) =>
      Effect.gen(function* () {
        const { terminal } = yield* Ref.get(program)
        const code = yield* exited(terminal)
        const exit = Option.match(code, {
          onNone: () => ({}),
          onSome: (value) => ({ exited: value }),
        })
        if (scope === "screen") {
          return { rows: yield* terminal.rows("viewport"), gone: 0, ...exit }
        }
        const all = nonBlank(yield* terminal.rows("all"))
        const before = yield* Ref.getAndSet(mark, all)
        if (scope === "full") return { rows: yield* terminal.rows("viewport"), gone: 0, ...exit }
        const { added, gone } = rowsSince(before, all)
        return { rows: added, gone, ...exit }
      }),
    restart: ({ command }) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(program)
        if (!(yield* quit(current))) return yield* new QuitTimeout()
        yield* Scope.close(current.scope, Exit.void)
        yield* Ref.set(program, yield* start(command))
        yield* Ref.set(mark, [])
      }),
    down: () =>
      Effect.gen(function* () {
        const current = yield* Ref.get(program)
        const clean = yield* quit(current)
        yield* Scope.close(current.scope, Exit.void)
        // The reply leaves before the host stops.
        yield* Deferred.done(stopped, Exit.void).pipe(Effect.delay("200 millis"), Effect.forkDetach)
        return { killed: !clean }
      }),
  })

  yield* Layer.launch(
    RpcServer.layer(HostRpcs).pipe(
      Layer.provide(handlers),
      Layer.provide(RpcServer.layerProtocolSocketServer),
      Layer.provide(RpcSerialization.layerNdjson),
      Layer.provide(BunSocketServer.layer({ path: config.socket })),
    ),
  ).pipe(Effect.raceFirst(Deferred.await(stopped)))
  const last = yield* Ref.get(program)
  yield* Scope.close(last.scope, Exit.void)
})

// ── Client ──

export type HostClient = RpcClient.FromGroup<typeof HostRpcs, RpcClientError>

/** Call the host on `socket`. A host that is gone fails with a `SocketError`. */
export const hostCall = <A, E>(
  socket: string,
  use: (host: HostClient) => Effect.Effect<A, E>,
): Effect.Effect<A, E | RpcClientError | SocketError> =>
  Effect.scoped(
    Layer.build(
      RpcClient.layerProtocolSocket({ retryTransientErrors: false }).pipe(
        Layer.provide(BunSocket.layerNet({ path: socket })),
        Layer.provide(RpcSerialization.layerNdjson),
      ),
    ).pipe(
      Effect.flatMap((protocol) => RpcClient.make(HostRpcs).pipe(Effect.provideContext(protocol))),
      Effect.flatMap(use),
    ),
  )

// ── Entry ──

class HostUsageError extends Schema.TaggedError<
  HostUsageError,
  { readonly brand: unique symbol }
>()("@gent/e2e/HostUsageError", { message: Schema.String }) {}

const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(HostConfig))

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const file = Bun.argv[2]
  if (Predicate.isUndefined(file)) {
    return yield* new HostUsageError({ message: "usage: bun pty-host.ts <config.json>" })
  }
  const config = yield* decodeConfig(yield* fs.readFileString(file))
  yield* fs.remove(file)
  yield* Effect.addFinalizer(() => fs.remove(config.socket).pipe(Effect.ignore))
  yield* serve(config)
})

// The layer runs the host once as it is built; the scope closes after it.
if (import.meta.main) {
  BunRuntime.runMain(
    Effect.scoped(Layer.build(Layer.effectDiscard(main).pipe(Layer.provide(BunServices.layer)))),
  )
}
