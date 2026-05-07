const slowPrefix = "--slow-ms="

const slowArg = Bun.argv.find((arg) => arg.startsWith(slowPrefix))
const separatorIndex = Bun.argv.indexOf("--")
const slowMs = slowArg === undefined ? 5_000 : Number(slowArg.slice(slowPrefix.length))
const command = separatorIndex === -1 ? [] : Bun.argv.slice(separatorIndex + 1)

if (!Number.isFinite(slowMs) || slowMs <= 0) {
  console.error(`[test-diagnose] invalid slow threshold: ${slowArg}`)
  process.exit(1)
}

if (command.length === 0) {
  console.error("[test-diagnose] missing command after --")
  process.exit(1)
}

const started = performance.now()
const proc = Bun.spawn(command, {
  env: { ...Bun.env, FORCE_COLOR: undefined, NO_COLOR: "1" },
  stderr: "pipe",
  stdout: "pipe",
})

const [exitCode, stdout, stderr] = await Promise.all([
  proc.exited,
  new Response(proc.stdout).text(),
  new Response(proc.stderr).text(),
])
const elapsedMs = performance.now() - started

const durationMs = (value: string): number | undefined => {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m)$/)
  if (match === null) return undefined
  const amount = Number(match[1])
  if (!Number.isFinite(amount)) return undefined
  switch (match[2]) {
    case "ms":
      return amount
    case "s":
      return amount * 1_000
    case "m":
      return amount * 60_000
  }
}

const formatMs = (ms: number): string => `${Math.round(ms)}ms`

const testOutput = `${stdout}\n${stderr}`

const bunRuns = [
  ...testOutput.matchAll(/^(?:(?<packageName>@[^:]+):test:\s*)?Ran .* \[(?<time>[^\]]+)\]$/gm),
]
  .map((match) => {
    const ms = durationMs(match.groups?.["time"] ?? "")
    if (ms === undefined) return undefined
    return {
      label: match.groups?.["packageName"] ?? "test",
      ms,
      raw: match.groups?.["time"] ?? "",
    }
  })
  .filter(
    (entry): entry is { readonly label: string; readonly ms: number; readonly raw: string } =>
      entry !== undefined,
  )
  .sort((a, b) => b.ms - a.ms)

if (exitCode !== 0) {
  process.stdout.write(stdout)
  process.stderr.write(stderr)
  console.error(`[test-diagnose] command failed after ${elapsedMs.toFixed(0)}ms`)
  process.exit(exitCode)
}

const packageTimes = [...stdout.matchAll(/^\s*Time:\s+(.+)$/gm)].map((match) => match[1])
if (packageTimes.length > 0) {
  console.log(`[test-diagnose] workspace runner reported ${packageTimes.at(-1)}`)
}
if (bunRuns.length > 0) {
  const slowest = bunRuns
    .slice(0, 5)
    .map((run) => `${run.label} ${formatMs(run.ms)}`)
    .join(", ")
  console.log(`[test-diagnose] slowest bun test chunks: ${slowest}`)
}
console.log(
  `[test-diagnose] wall ${elapsedMs.toFixed(0)}ms / slow threshold ${slowMs.toFixed(0)}ms`,
)

if (elapsedMs > slowMs) {
  console.log(
    `[test-diagnose] exceeded slow threshold by ${(elapsedMs - slowMs).toFixed(0)}ms; inspect the reported chunks and reduce test cost without changing the test taxonomy`,
  )
}
