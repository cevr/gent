import { Effect, Option, Schema, Stream, type Duration, type PlatformError } from "effect"
import { ChildProcess, type ChildProcessSpawner } from "effect/unstable/process"
import { causeMessage } from "../domain/guards.js"

export class ProcessError extends Schema.TaggedError<ProcessError>()("ProcessError", {
  command: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
  timedOut: Schema.optional(Schema.Boolean),
}) {}

interface ProcessResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
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

const decodeUtf8 = (chunks: Iterable<Uint8Array>): string => {
  const decoder = new TextDecoder()
  let out = ""
  for (const chunk of chunks) out += decoder.decode(chunk)
  return out
}

/**
 * Run a child process to completion and collect its output.
 *
 * A free function over `ChildProcessSpawner`, not a service: there is one
 * implementation and nothing swaps it. Every caller already names the spawner
 * in its requirement union, so a deployment that forgets the platform stack
 * still fails to compile.
 */
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
          message: `${command} failed: ${causeMessage(e)}`,
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
