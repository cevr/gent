const packages = [
  { name: "@gent/core", cwd: "packages/core" },
  { name: "@gent/extensions", cwd: "packages/extensions" },
  { name: "@gent/tooling", cwd: "packages/tooling" },
  { name: "@gent/sdk", cwd: "packages/sdk" },
  { name: "@gent/tui", cwd: "apps/tui" },
]

const prefixStream = async (
  stream: ReadableStream<Uint8Array>,
  write: (chunk: string) => void,
  prefix: string,
) => {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let buffered = ""

  const pump = async (): Promise<void> => {
    const read = await reader.read()
    if (read.done) return

    buffered += decoder.decode(read.value, { stream: true })
    const lines = buffered.split("\n")
    buffered = lines.pop() ?? ""
    for (const line of lines) write(`${prefix}${line}\n`)

    return pump()
  }

  await pump()

  buffered += decoder.decode()
  if (buffered.length > 0) write(`${prefix}${buffered}\n`)
}

const runPackage = async ({ name, cwd }: (typeof packages)[number]) => {
  const prefix = `${name}:test: `
  const proc = Bun.spawn(["bun", "run", "--cwd", cwd, "test"], {
    env: { ...Bun.env, FORCE_COLOR: undefined, NO_COLOR: "1" },
    stderr: "pipe",
    stdout: "pipe",
  })

  const stdout = prefixStream(proc.stdout, (chunk) => process.stdout.write(chunk), prefix)
  const stderr = prefixStream(proc.stderr, (chunk) => process.stderr.write(chunk), prefix)
  const exitCode = await proc.exited
  await Promise.all([stdout, stderr])
  return exitCode
}

const started = performance.now()
const results = await Promise.all(packages.map((pkg) => runPackage(pkg)))
const elapsedMs = performance.now() - started
console.log(`  Time:    ${(elapsedMs / 1_000).toFixed(3)}s `)

process.exit(results.find((code) => code !== 0) ?? 0)
