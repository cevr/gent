import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { extname, join, resolve as pathResolve } from "node:path"

const ROOT = pathResolve(import.meta.dir, "..", "..", "..")
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"])
const SOURCE_ROOTS = [
  "packages/core/src",
  "packages/extensions/src",
  "packages/sdk/src",
  "apps/server/src",
  "apps/tui/src",
] as const

const walkFiles = (dir: string): ReadonlyArray<string> => {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") continue
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walkFiles(fullPath))
      continue
    }
    if (!SOURCE_EXTENSIONS.has(extname(entry.name))) continue
    out.push(fullPath)
  }
  return out
}

const collectSourceFiles = (): ReadonlyArray<string> =>
  SOURCE_ROOTS.flatMap((dir) => walkFiles(pathResolve(ROOT, dir)))

const sourceLines = (file: string): ReadonlyArray<{ line: number; text: string }> =>
  readFileSync(file, "utf8")
    .split("\n")
    .map((text, index) => ({ line: index + 1, text }))

const isCommentLine = (text: string) => {
  const trimmed = text.trim()
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("*/")
  )
}

describe("architecture policy", () => {
  test("owned source shapes do not reintroduce `_kind` discriminators", () => {
    const violations = collectSourceFiles().flatMap((file) =>
      sourceLines(file)
        .filter(({ text }) => !isCommentLine(text))
        .filter(
          ({ text }) => /(?:readonly\s+)?_kind\s*:/.test(text) || /["']_kind["']\s*:/.test(text),
        )
        .map(({ line, text }) => `${file.slice(ROOT.length + 1)}:${line} ${text.trim()}`),
    )

    expect(violations).toEqual([])
  })

  test("production source does not use placeholder ToolContext casts", () => {
    const violations = collectSourceFiles().flatMap((file) =>
      sourceLines(file)
        .filter(({ text }) =>
          /as(?:\s+unknown)?\s+as\s+ToolContext\b|as\s+ToolContext\b/.test(text),
        )
        .map(({ line, text }) => `${file.slice(ROOT.length + 1)}:${line} ${text.trim()}`),
    )

    expect(violations).toEqual([])
  })

  test("turn-control, if still present, does not leak mutable public handles", () => {
    const file = pathResolve(ROOT, "packages/core/src/runtime/extensions/turn-control.ts")
    if (!existsSync(file)) {
      expect(true).toBe(true)
      return
    }
    const source = readFileSync(file, "utf8")
    const serviceMatch = source.match(
      /export interface ExtensionTurnControlService \{([\s\S]*?)\n\}/,
    )

    expect(serviceMatch).not.toBeNull()

    const body = serviceMatch?.[1] ?? ""
    expect(body).not.toMatch(/\breadonly\s+(queue|state|ref|set|offer|take|enqueue)\b/)
    expect(source).not.toMatch(/\bexport const\s+(Queue|MutableQueue|QueueRef|TurnControlRef)\b/)
  })

  test("SessionRuntime owns prompt execution directly", () => {
    const file = pathResolve(ROOT, "packages/core/src/runtime/session-runtime.ts")
    const source = readFileSync(file, "utf8")
    const serviceMatch = source.match(/export interface SessionRuntimeService \{([\s\S]*?)\n\}/)

    expect(serviceMatch).not.toBeNull()

    const body = serviceMatch?.[1] ?? ""
    expect(body).toMatch(/\brunPrompt\b/)
    expect(body).not.toMatch(/\brunOnce\b/)
  })

  test("runtime/agent barrel does not re-export the loop control plane", () => {
    const file = pathResolve(ROOT, "packages/core/src/runtime/agent/index.ts")
    const source = readFileSync(file, "utf8")

    expect(source).not.toMatch(/\bAgentLoop\b/)
    expect(source).not.toMatch(/\bAgentLoopError\b/)
    expect(source).not.toMatch(/\bSteerCommand\b/)
  })

  test("agent runner does not use AgentLoop as a direct runtime seam", () => {
    const file = pathResolve(ROOT, "packages/core/src/runtime/agent/agent-runner.ts")
    const source = readFileSync(file, "utf8")

    expect(source).not.toMatch(/yield\*\s+AgentLoop\b/)
    expect(source).not.toMatch(
      /\bagentLoop\.(runOnce|submit|run|steer|drainQueue|getQueue|getState|watchState)\b/,
    )
    expect(source).not.toMatch(/\bmakeRunPrompt\b/)
    expect(source).toMatch(/\bSessionRuntime\b/)
  })

  test("agent runner public layer depends on SessionRuntime, not AgentLoop", () => {
    const file = pathResolve(ROOT, "packages/core/src/runtime/agent/agent-runner.ts")
    const source = readFileSync(file, "utf8")

    expect(source).toMatch(/\|\s+SessionRuntime\b/)
    expect(source).not.toMatch(/\|\s+AgentLoop\b/)
  })

  test("runtime composer does not expose a raw AgentLoop override seam", () => {
    const file = pathResolve(ROOT, "packages/core/src/runtime/composer.ts")
    const source = readFileSync(file, "utf8")

    expect(source).not.toMatch(/\breadonly loop\?:/)
    expect(source).not.toMatch(/\baddOverride\("loop"\)/)
    expect(source).not.toMatch(/\bAgentLoop\b/)
  })

  test("session runtime does not export direct prompt-run helpers", () => {
    const file = pathResolve(ROOT, "packages/core/src/runtime/session-runtime.ts")
    const source = readFileSync(file, "utf8")

    expect(source).not.toMatch(/\bexport\s+(const|interface)\s+(makeRunPrompt|RunPromptInput)\b/)
    expect(source).not.toMatch(/\bstatic FromLoop\b/)
  })

  test("session runtime does not accept an ambient AgentLoop override seam", () => {
    const file = pathResolve(ROOT, "packages/core/src/runtime/session-runtime.ts")
    const source = readFileSync(file, "utf8")

    expect(source).not.toMatch(/\bserviceOption\(AgentLoop\)/)
    expect(source).not.toMatch(/\bLayer\.succeed\(AgentLoop,\s*/)
  })

  test("package exports do not expose agent-loop as a public subpath", () => {
    const file = pathResolve(ROOT, "packages/core/package.json")
    const source = readFileSync(file, "utf8")

    expect(source).toContain('"./runtime/agent/agent-loop": null')
    expect(source).toContain('"./runtime/agent/agent-loop.js": null')
    expect(source).toContain('"./runtime/agent/agent-loop.ts": null')
  })

  test("SessionProfileCache public surface does not expose speculative cache reads", () => {
    const file = pathResolve(ROOT, "packages/core/src/runtime/session-profile.ts")
    const source = readFileSync(file, "utf8")
    const serviceMatch = source.match(
      /export interface SessionProfileCacheService \{([\s\S]*?)\n\}/,
    )

    expect(serviceMatch).not.toBeNull()

    const body = serviceMatch?.[1] ?? ""
    expect(body).not.toMatch(/\bpeek\b/)
  })

  test("composition roots share the profile runtime helper", () => {
    const files = [
      pathResolve(ROOT, "packages/core/src/server/dependencies.ts"),
      pathResolve(ROOT, "packages/core/src/runtime/session-profile.ts"),
    ]

    for (const file of files) {
      const source = readFileSync(file, "utf8")
      expect(source).toMatch(/\bresolveProfileRuntime\b/)
      expect(source).not.toMatch(/\bresolveRuntimeProfile\b/)
      expect(source).not.toMatch(/\bbuildExtensionLayers\b/)
      expect(source).not.toMatch(/\bcompileBaseSections\b/)
    }
  })

  test("composition roots do not assemble AgentLoop separately from SessionRuntime", () => {
    const files = [
      pathResolve(ROOT, "packages/core/src/server/dependencies.ts"),
      pathResolve(ROOT, "packages/core/src/test-utils/in-process-layer.ts"),
      pathResolve(ROOT, "packages/core/src/test-utils/e2e-layer.ts"),
      pathResolve(ROOT, "packages/core/src/runtime/agent/agent-runner.ts"),
    ]

    for (const file of files) {
      const source = readFileSync(file, "utf8")
      expect(source).not.toMatch(/\bAgentLoop\.Live\(/)
    }
  })

  test("machine mailbox ownership is not exported as shared extension context", () => {
    const sharedSource = readFileSync(
      pathResolve(ROOT, "packages/core/src/runtime/extensions/extension-actor-shared.ts"),
      "utf8",
    )
    expect(sharedSource).not.toMatch(/\bCurrentMailboxSession\b/)

    const violations = collectSourceFiles()
      .filter(
        (file) =>
          !file.endsWith("packages/core/src/runtime/extensions/resource-host/machine-mailbox.ts"),
      )
      .flatMap((file) =>
        sourceLines(file)
          .filter(({ text }) => !isCommentLine(text))
          .filter(({ text }) => /\bCurrentMailboxSession\b/.test(text))
          .map(({ line, text }) => `${file.slice(ROOT.length + 1)}:${line} ${text.trim()}`),
      )

    expect(violations).toEqual([])
  })

  test("public extension api does not re-export runtime or server internals", () => {
    const source = readFileSync(pathResolve(ROOT, "packages/core/src/extensions/api.ts"), "utf8")
    const pkg = readFileSync(pathResolve(ROOT, "packages/core/package.json"), "utf8")
    const extensionsPkg = readFileSync(
      pathResolve(ROOT, "packages/extensions/package.json"),
      "utf8",
    )

    expect(source).not.toMatch(/\bMachineEngine\b/)
    expect(source).not.toMatch(/\bMachineExecute\b/)
    expect(source).not.toMatch(/\bToolRunner\b/)
    expect(source).not.toMatch(/\bInteractionPendingReader\b/)
    expect(source).not.toMatch(/\bEventPublisher\b/)
    expect(source).not.toMatch(/\.\.\/runtime\//)
    expect(source).not.toMatch(/\.\.\/server\//)
    expect(pkg).not.toMatch(/"\.\/extensions\/internal"/)
    expect(extensionsPkg).toMatch(/"\.\/core-internal": null/)
    expect(extensionsPkg).toMatch(/"\.\/core-internal\.js": null/)
  })

  test("runtime modules do not import server prompt internals", () => {
    const serverPromptImport =
      /(?:@gent\/core\/server\/system-prompt|(?:\.\.\/)+server\/system-prompt)/
    const violations = collectSourceFiles()
      .filter((file) => file.includes("/packages/core/src/runtime/"))
      .flatMap((file) =>
        sourceLines(file)
          .filter(({ text }) => !isCommentLine(text))
          .filter(({ text }) => serverPromptImport.test(text))
          .map(({ line, text }) => `${file.slice(ROOT.length + 1)}:${line} ${text.trim()}`),
      )

    expect(violations).toEqual([])
  })

  test("production TUI shell does not import app runtime wiring directly", () => {
    const mainSource = readFileSync(pathResolve(ROOT, "apps/tui/src/main.tsx"), "utf8")

    expect(mainSource).not.toContain("@gent/core/server/dependencies.js")
    expect(mainSource).not.toContain("@gent/core/server/index.js")
    expect(mainSource).not.toContain("@gent/core/debug/session.js")
    expect(mainSource).not.toContain("makeDirectGentClient")
    expect(mainSource).not.toContain("run-debug-app")
    expect(mainSource).not.toContain("Gent.spawn")
    expect(mainSource).not.toContain("Gent.local")
    expect(mainSource).toContain("Gent.server")
    expect(mainSource).toContain("Gent.client")
    expect(mainSource).toContain("Gent.state")
    expect(mainSource).toContain("Gent.provider")
    expect(mainSource).toContain('Flag.string("connect")')
  })

  test("builtin extensions have exactly one core-internal bridge", () => {
    const bridgeImport = "../../core/src/extensions/internal.js"
    const violations = collectSourceFiles()
      .filter((file) => file.includes("/packages/extensions/src/"))
      .filter((file) => !file.endsWith("/packages/extensions/src/core-internal.ts"))
      .flatMap((file) =>
        sourceLines(file)
          .filter(({ text }) => !isCommentLine(text))
          .filter(({ text }) => text.includes(bridgeImport))
          .map(({ line, text }) => `${file.slice(ROOT.length + 1)}:${line} ${text.trim()}`),
      )

    expect(violations).toEqual([])
  })
})
