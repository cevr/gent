import { BunRuntime } from "@effect/platform-bun"
import { Clock, Console, Effect, Option } from "effect"

interface WorkspacePackage {
  readonly name: string
  readonly cwd: string
}

const packages: ReadonlyArray<WorkspacePackage> = [
  { name: "@gent/core", cwd: "packages/core" },
  { name: "@gent/extensions", cwd: "packages/extensions" },
  { name: "@gent/tooling", cwd: "packages/tooling" },
  { name: "@gent/sdk", cwd: "packages/sdk" },
  { name: "@gent/tui", cwd: "apps/tui" },
]

const prefixStream = Effect.fn("Tooling.prefixStream")(function* (
  stream: ReadableStream<Uint8Array>,
  write: (chunk: string) => void,
  prefix: string,
) {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let buffered = ""

  while (true) {
    const read = yield* Effect.promise(() => reader.read())
    if (read.done) break

    buffered += decoder.decode(read.value, { stream: true })
    const lines = buffered.split("\n")
    buffered = Option.getOrElse(Option.fromNullishOr(lines.pop()), () => "")
    for (const line of lines) write(`${prefix}${line}\n`)
  }

  buffered += decoder.decode()
  if (buffered.length > 0) write(`${prefix}${buffered}\n`)
})

const runPackage = Effect.fn("Tooling.runPackage")(function* ({ name, cwd }: WorkspacePackage) {
  const prefix = `${name}:test: `
  const env = { ...Bun.env, NO_COLOR: "1" }
  delete env.FORCE_COLOR
  const proc = Bun.spawn(["bun", "run", "--cwd", cwd, "test"], {
    env,
    stderr: "pipe",
    stdout: "pipe",
  })

  const stdout = prefixStream(proc.stdout, (chunk) => process.stdout.write(chunk), prefix)
  const stderr = prefixStream(proc.stderr, (chunk) => process.stderr.write(chunk), prefix)
  const [exitCode] = yield* Effect.all([Effect.promise(() => proc.exited), stdout, stderr], {
    concurrency: 3,
  })
  return exitCode
})

const program = Effect.gen(function* () {
  const started = yield* Clock.currentTimeMillis
  const results = yield* Effect.all(packages.map(runPackage), { concurrency: packages.length })
  const elapsedMs = (yield* Clock.currentTimeMillis) - started
  yield* Console.log(`  Time:    ${(elapsedMs / 1_000).toFixed(3)}s `)

  const failedExitCode = Option.fromNullishOr(results.find((code) => code !== 0))
  if (Option.isSome(failedExitCode)) return yield* Effect.fail(failedExitCode.value)
})

BunRuntime.runMain(program)
