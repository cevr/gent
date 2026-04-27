import { Effect, Schema, Stream, type Duration } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process"
import { ChildProcess } from "effect/unstable/process"

export class ProcessError extends Schema.TaggedErrorClass<ProcessError>()("ProcessError", {
  command: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
  timedOut: Schema.optional(Schema.Boolean),
}) {}

export interface ProcessResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export interface RunProcessOptions {
  readonly cwd?: string
  readonly env?: Record<string, string | undefined>
  readonly timeout?: Duration.Duration
  readonly stdout?: "pipe" | "ignore"
  readonly stderr?: "pipe" | "ignore"
}

const decodeUtf8 = (chunks: Iterable<Uint8Array>): string => {
  const decoder = new TextDecoder()
  let out = ""
  for (const chunk of chunks) out += decoder.decode(chunk)
  return out
}

export const runProcess = (
  command: string,
  args: ReadonlyArray<string>,
  options: RunProcessOptions = {},
): Effect.Effect<ProcessResult, ProcessError, ChildProcessSpawner.ChildProcessSpawner> => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const spawn = ChildProcess.make(command, [...args], {
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
        stdout: options.stdout ?? "pipe",
        stderr: options.stderr ?? "pipe",
      })
      const handle = yield* spawn
      const [exitCode, stdoutChunks, stderrChunks] = yield* Effect.all(
        [handle.exitCode, Stream.runCollect(handle.stdout), Stream.runCollect(handle.stderr)],
        { concurrency: "unbounded" },
      )
      return {
        exitCode: Number(exitCode),
        stdout: decodeUtf8(stdoutChunks),
        stderr: decodeUtf8(stderrChunks),
      } satisfies ProcessResult
    }),
  ).pipe(
    Effect.mapError(
      (e) =>
        new ProcessError({
          command,
          message: `${command} failed: ${e instanceof Error ? e.message : String(e)}`,
          cause: e,
        }),
    ),
  )

  return options.timeout !== undefined
    ? program.pipe(
        Effect.timeoutOrElse({
          duration: options.timeout,
          orElse: () =>
            Effect.fail(
              new ProcessError({
                command,
                message: `${command} timed out`,
                timedOut: true,
              }),
            ),
        }),
      )
    : program
}
