import {
  Context,
  Effect,
  Layer,
  Option,
  Predicate,
  Schema,
  Stream,
  type Duration,
  type PlatformError,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

export class ProcessError extends Schema.TaggedError<ProcessError>()("ProcessError", {
  command: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
  timedOut: Schema.optional(Schema.Boolean),
}) {}

export interface ProcessResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export interface ProcessRunnerService {
  readonly run: (
    command: string,
    args: ReadonlyArray<string>,
    options?: RunProcessOptions,
  ) => Effect.Effect<ProcessResult, ProcessError>
}

export interface RunProcessOptions {
  readonly cwd?: string
  // oxlint-disable-next-line effect/noNullish -- Child-process environments use undefined to remove inherited variables.
  readonly env?: Record<string, string | undefined>
  readonly timeout?: Duration.Duration
  readonly stdin?: "pipe" | "ignore" | "inherit"
  readonly stdout?: "pipe" | "ignore" | "inherit"
  readonly stderr?: "pipe" | "ignore" | "inherit"
}

export const ProcessRunner: Context.Reference<ProcessRunnerService> =
  Context.Reference<ProcessRunnerService>("@gent/core/src/utils/run-process/ProcessRunner", {
    defaultValue: () => ({
      run: (command) => Effect.die(new Error(`ProcessRunner unavailable for command: ${command}`)),
    }),
  })

const decodeUtf8 = (chunks: Iterable<Uint8Array>): string => {
  const decoder = new TextDecoder()
  let out = ""
  for (const chunk of chunks) out += decoder.decode(chunk)
  return out
}

const processErrorMessage = (error: PlatformError.PlatformError): string => {
  if (Predicate.isError(error)) return error.message
  return String(error)
}

export const runProcess = (
  command: string,
  args: ReadonlyArray<string>,
  options: RunProcessOptions = {},
): Effect.Effect<ProcessResult, ProcessError, ChildProcessSpawner.ChildProcessSpawner> => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const stdoutMode = options.stdout ?? "pipe"
      const stderrMode = options.stderr ?? "pipe"
      const spawn = ChildProcess.make(command, [...args], {
        cwd: options.cwd,
        env: options.env,
        stdin: options.stdin,
        stdout: stdoutMode,
        stderr: stderrMode,
      })
      const handle = yield* spawn
      let collectStdout: Effect.Effect<
        Option.Option<ReadonlyArray<Uint8Array>>,
        PlatformError.PlatformError
      > = Effect.succeedNone
      if (stdoutMode === "pipe") {
        collectStdout = Stream.runCollect(handle.stdout).pipe(Effect.asSome)
      }
      let collectStderr: Effect.Effect<
        Option.Option<ReadonlyArray<Uint8Array>>,
        PlatformError.PlatformError
      > = Effect.succeedNone
      if (stderrMode === "pipe") {
        collectStderr = Stream.runCollect(handle.stderr).pipe(Effect.asSome)
      }
      const [exitCode, stdoutChunks, stderrChunks] = yield* Effect.all(
        [handle.exitCode, collectStdout, collectStderr],
        { concurrency: "unbounded" },
      )
      return {
        exitCode: Number(exitCode),
        stdout: Option.match(stdoutChunks, {
          onNone: () => "",
          onSome: decodeUtf8,
        }),
        stderr: Option.match(stderrChunks, {
          onNone: () => "",
          onSome: decodeUtf8,
        }),
      } satisfies ProcessResult
    }),
  ).pipe(
    Effect.mapError(
      (e) =>
        new ProcessError({
          command,
          message: `${command} failed: ${processErrorMessage(e)}`,
          cause: e,
        }),
    ),
  )

  return Option.fromUndefinedOr(options.timeout).pipe(
    Option.match({
      onNone: () => program,
      onSome: (timeout) =>
        program.pipe(
          Effect.timeoutOrElse({
            duration: timeout,
            orElse: () =>
              Effect.fail(
                new ProcessError({
                  command,
                  message: `${command} timed out`,
                  timedOut: true,
                }),
              ),
          }),
        ),
    }),
  )
}

export const makeProcessRunner: Effect.Effect<
  ProcessRunnerService,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  return {
    run: (command, args, options) =>
      runProcess(command, args, options).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
  }
})

export const ProcessRunnerLive = Layer.effect(ProcessRunner, makeProcessRunner)
