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
console.log(`[test-budget] wall ${elapsedMs.toFixed(0)}ms / budget ${budgetMs.toFixed(0)}ms`)

if (elapsedMs > budgetMs) {
  process.stdout.write(stdout)
  process.stderr.write(stderr)
  console.error(
    `[test-budget] exceeded budget by ${(elapsedMs - budgetMs).toFixed(0)}ms; move slow coverage to test:e2e or reduce test cost`,
  )
  process.exit(1)
}
