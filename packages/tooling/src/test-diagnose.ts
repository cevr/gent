import { BunRuntime } from "@effect/platform-bun"
import { Array as Arr, Clock, Console, Effect, Option } from "effect"

const slowPrefix = "--slow-ms="

const durationMs = (value: string): Option.Option<number> => {
  const match = Option.fromNullishOr(value.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m)$/))
  if (Option.isNone(match)) return Option.none()
  const amount = Number(match.value[1])
  if (!Number.isFinite(amount)) return Option.none()
  switch (match.value[2]) {
    case "ms":
      return Option.some(amount)
    case "s":
      return Option.some(amount * 1_000)
    case "m":
      return Option.some(amount * 60_000)
    default:
      return Option.none()
  }
}

const formatMs = (ms: number): string => `${Math.round(ms)}ms`

const program = Effect.gen(function* () {
  const slowArg = Option.fromNullishOr(Bun.argv.find((arg) => arg.startsWith(slowPrefix)))
  const separatorIndex = Bun.argv.indexOf("--")
  const slowMs = Option.match(slowArg, {
    onNone: () => 5_000,
    onSome: (arg) => Number(arg.slice(slowPrefix.length)),
  })
  let command: ReadonlyArray<string> = []
  if (separatorIndex !== -1) command = Bun.argv.slice(separatorIndex + 1)

  if (!Number.isFinite(slowMs) || slowMs <= 0) {
    yield* Console.error(
      `[test-diagnose] invalid slow threshold: ${Option.getOrElse(slowArg, () => "missing")}`,
    )
    return yield* Effect.fail("invalid slow threshold")
  }

  if (command.length === 0) {
    yield* Console.error("[test-diagnose] missing command after --")
    return yield* Effect.fail("missing command")
  }

  const started = yield* Clock.currentTimeMillis
  const env = { ...Bun.env, NO_COLOR: "1" }
  delete env.FORCE_COLOR
  const proc = Bun.spawn(command, { env, stderr: "pipe", stdout: "pipe" })

  const [exitCode, stdout, stderr] = yield* Effect.all(
    [
      Effect.promise(() => proc.exited),
      Effect.promise(() => new Response(proc.stdout).text()),
      Effect.promise(() => new Response(proc.stderr).text()),
    ],
    { concurrency: 3 },
  )
  const elapsedMs = (yield* Clock.currentTimeMillis) - started
  const testOutput = `${stdout}\n${stderr}`

  const bunRuns = Arr.filterMap(
    [...testOutput.matchAll(/^(?:(@[^:]+):test:\s*)?Ran .* \[([^\]]+)\]$/gm)],
    (match) => {
      const raw = Option.getOrElse(Option.fromNullishOr(match[2]), () => "")
      return Option.map(durationMs(raw), (ms) => ({
        label: Option.getOrElse(Option.fromNullishOr(match[1]), () => "test"),
        ms,
        raw,
      }))
    },
  ).sort((a, b) => b.ms - a.ms)

  if (exitCode !== 0) {
    process.stdout.write(stdout)
    process.stderr.write(stderr)
    yield* Console.error(`[test-diagnose] command failed after ${elapsedMs.toFixed(0)}ms`)
    return yield* Effect.fail(exitCode)
  }

  const packageTimes = Arr.filterMap([...stdout.matchAll(/^\s*Time:\s+(.+)$/gm)], (match) =>
    Option.fromNullishOr(match[1]),
  )
  const lastPackageTime = Arr.last(packageTimes)
  if (Option.isSome(lastPackageTime)) {
    yield* Console.log(`[test-diagnose] workspace runner reported ${lastPackageTime.value}`)
  }
  if (bunRuns.length > 0) {
    const slowest = bunRuns
      .slice(0, 5)
      .map((run) => `${run.label} ${formatMs(run.ms)}`)
      .join(", ")
    yield* Console.log(`[test-diagnose] slowest bun test chunks: ${slowest}`)
  }
  yield* Console.log(
    `[test-diagnose] wall ${elapsedMs.toFixed(0)}ms / slow threshold ${slowMs.toFixed(0)}ms`,
  )

  if (elapsedMs > slowMs) {
    yield* Console.log(
      `[test-diagnose] exceeded slow threshold by ${(elapsedMs - slowMs).toFixed(0)}ms; inspect the reported chunks and reduce test cost without changing the test taxonomy`,
    )
  }
})

BunRuntime.runMain(program)
