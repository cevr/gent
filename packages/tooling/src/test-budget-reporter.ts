const budgetPrefix = "--budget-ms="

const budgetArg = Bun.argv.find((arg) => arg.startsWith(budgetPrefix))
const separatorIndex = Bun.argv.indexOf("--")
const budgetMs = budgetArg === undefined ? 5_000 : Number(budgetArg.slice(budgetPrefix.length))
const command = separatorIndex === -1 ? [] : Bun.argv.slice(separatorIndex + 1)

if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
  console.error(`[test-budget] invalid budget: ${budgetArg}`)
  process.exit(1)
}

if (command.length === 0) {
  console.error("[test-budget] missing command after --")
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
  console.error(`[test-budget] command failed after ${elapsedMs.toFixed(0)}ms`)
  process.exit(exitCode)
}

const packageTimes = [...stdout.matchAll(/^\s*Time:\s+(.+)$/gm)].map((match) => match[1])
if (packageTimes.length > 0) {
  console.log(`[test-budget] turbo reported ${packageTimes.at(-1)}`)
}
if (bunRuns.length > 0) {
  const slowest = bunRuns
    .slice(0, 5)
    .map((run) => `${run.label} ${formatMs(run.ms)}`)
    .join(", ")
  console.log(`[test-budget] slowest bun test chunks: ${slowest}`)
}
console.log(`[test-budget] wall ${elapsedMs.toFixed(0)}ms / budget ${budgetMs.toFixed(0)}ms`)

if (elapsedMs > budgetMs) {
  process.stdout.write(stdout)
  process.stderr.write(stderr)
  console.error(
    `[test-budget] exceeded budget by ${(elapsedMs - budgetMs).toFixed(0)}ms; inspect the reported chunks and reduce test cost without changing the test taxonomy`,
  )
  process.exit(1)
}
