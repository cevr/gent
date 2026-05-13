export interface PlatformDuplicationFinding {
  readonly file: string
  readonly line: number
  readonly message: string
}

interface BannedPattern {
  readonly pattern: RegExp
  readonly message: string
}

const sourceFile = (file: string): boolean =>
  /^(?:packages|apps|examples\/extensions)\//.test(file) &&
  /\.(?:[cm]?[jt]sx?)$/.test(file) &&
  file !== "packages/tooling/src/platform-duplication-guards.ts" &&
  !file.includes("/tests/") &&
  !file.includes("/fixtures/") &&
  !file.includes("/dist/")

const activeSourceFile = (file: string): boolean =>
  /^(?:packages|apps)\//.test(file) && sourceFile(file)

const referenceExtensionFile = (file: string): boolean =>
  file.startsWith("examples/extensions/") && sourceFile(file)

const bannedActiveSourcePatterns: ReadonlyArray<BannedPattern> = [
  {
    pattern: /\bExtensionRuntime\b/,
    message: "ExtensionRuntime marker service is deleted; use explicit services",
  },
  {
    pattern: /\bExtensionTurnControl\b/,
    message: "ExtensionTurnControl mailbox is deleted; use the session runtime protocol",
  },
  {
    pattern: /\bTurnEvent(?:Usage)?\b/,
    message: "TurnEvent duplicates Effect AI response parts",
  },
  {
    pattern: /\bsubTagLayers\s*\(/,
    message: "Storage subtag adapter is deleted; use SqliteStorage composition roots",
  },
  {
    pattern: /\bctx\.extension\b/,
    message: "In-process extension RPC is deleted; yield services or use public transport",
  },
  {
    pattern: /\btyped RPC helpers\b/,
    message: "Host contexts no longer expose typed RPC helpers",
  },
  {
    pattern: /\bGentSpan\b/,
    message: "GentSpan tracer is deleted; use @effect/opentelemetry via Tracer service",
  },
  {
    pattern: /\bresetIncompatibleStorageSchema\b/,
    message: "Destructive schema reset is deleted; use SqliteMigrator migrations",
  },
  {
    pattern: /\bLiveFile\b/,
    message: "LiveFile JSON KV pattern is deleted; use KeyValueStore.layerFileSystem",
  },
  {
    pattern: /\bEventStore\.Live\s*=\s*EventStore\.Memory\b/,
    message:
      "EventStore.Live = EventStore.Memory alias is deleted; resolve EventStore explicitly per persistence mode",
  },
  {
    pattern: /\b(?:loopsRef|mutationSemaphoresRef|LoopDriverEvent|LoopHandle)\b/,
    message: "Legacy agent-loop dispatch infrastructure is deleted; use AgentLoop actor state",
  },
  {
    pattern:
      /\b(?:eraseLayer|restoreErasedLayer|ServerProfile|CwdProfile|EphemeralProfile|ServerProfileService)\b/,
    message: "Legacy runtime composer scope brands are deleted; compose layers at the owner",
  },
  {
    pattern: /\bProvider\.(?:Sequence|Signal|Debug|Failing)\b/,
    message:
      "Provider test statics are deleted outside language-model test utilities; use LanguageModelLayers",
  },
  {
    pattern: /\b(?:findOpenPort|WORKER_HOST)\b/,
    message: "Worker port preallocation is deleted; use server-selected ports",
  },
  {
    pattern: /\bBun\.Glob\b/,
    message: "Bun.Glob fallback is deleted; use the FileIndex service",
  },
  {
    pattern: /\bWorkerLifecycleState\b/,
    message: "WorkerLifecycleState is deleted; use the server lifecycle contract",
  },
  {
    pattern: /\bBun\.randomUUIDv7\b/,
    message: "Bun.randomUUIDv7 is adapter-only; use GentPlatform.randomId",
  },
  {
    pattern: /\bprocess\.(?:platform|pid|execPath|kill)\b/,
    message: "Host process facts are adapter-only; use GentPlatform",
  },
  {
    pattern: /\bos\.(?:hostname|homedir|release)\s*\(/,
    message: "Host OS facts are adapter-only; use GentPlatform",
  },
  {
    pattern: /\b(?:BunPlatformLive|BunGentPlatformLive|BunCronRuntimeLive)\b/,
    message: "Bun platform layers may only be provided by platform roots",
  },
]

const bannedPathPatterns: ReadonlyArray<BannedPattern> = [
  {
    pattern: /^packages\/core\/src\/server\/rpcs\/actor\.ts$/,
    message: "Public actor RPC surface is deleted; use product RPCs",
  },
  {
    pattern: /^packages\/core\/src\/domain\/auth-(?:storage|store|method)\.ts$/,
    message: "Legacy auth domain module is deleted; use domain/auth",
  },
  {
    pattern: /^packages\/core\/src\/runtime\/(?:composer|scope-brands)\.ts$/,
    message: "Legacy runtime composer modules are deleted; use owner-local layer composition",
  },
  {
    pattern: /^packages\/sdk\/src\/(?:server-registry|worker-http)\.ts$/,
    message: "SDK worker registry/http split is deleted; use server lock and server entrypoints",
  },
]

const bannedTransportContractPatterns: ReadonlyArray<BannedPattern> = [
  {
    pattern: /\b(?:SessionInfo|BranchInfo)\b/,
    message: "Transport session DTOs mirror domain types",
  },
]

const bannedAgentRunnerCompositionPatterns: ReadonlyArray<BannedPattern> = [
  {
    pattern:
      /\b(?:SqliteStorage\.MemoryWithSql|SingleRunner\.layer|SessionRuntime\.Live|ResourceManagerLive|buildExtensionLayers|PromptPresenterLive|EventStoreLive)\b/,
    message: "AgentRunner must use the ephemeral child root preset",
  },
]

const bannedReferenceExtensionPatterns: ReadonlyArray<BannedPattern> = [
  {
    pattern: /@gent\/core-internal\//,
    message: "Reference extensions must use @gent/core/extensions/api, not core internals",
  },
  {
    pattern: /@gent\/core\/src\//,
    message: "Reference extensions must import the public extension API, not core source files",
  },
  {
    pattern: /@gent\/extensions\/src\//,
    message:
      "Reference extensions must stand alone instead of importing shipped extension internals",
  },
  {
    pattern: /(?:^|\s)from\s+["'](?:\.\.\/){2,}/,
    message: "Reference extensions must not reach out of examples/extensions with relative imports",
  },
]

const withEffectWrapperDefinitionPattern = /\b(?:export\s+)?const\s+with[A-Z][A-Za-z0-9_]*\b/
const effectWrapperArgumentPattern = /:\s*Effect\.Effect\b/
const withEffectWrapperMessage =
  "`withX(effect, ...)` wrapper helpers are banned; expose a pipeable provider and call it from `.pipe(...)`"
const withFunctionInvocationPattern = /(?<![.\w$])with[A-Z][A-Za-z0-9_]*\s*\(/g
const callbackArgumentPattern =
  /(?:^|,)\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][A-Za-z0-9_$]*\s*=>)/
const callbackParameterPattern = /:\s*\([^)]*\)\s*=>/
const wrappedFunctionInvocationPattern =
  /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*\s*\(/
const withFunctionInvocationMessage =
  "`withX(fn(...))` invocation style is banned; call the inner effect and pipe the wrapper (`fn(...).pipe(withX)`)."
const withCallbackWrapperMessage =
  "`withX(callback)` wrapper style is banned; expose an Effect value/provider and continue with `.pipe(...)`."

const hostFactPatternSources = new Set([
  "\\bprocess\\.(?:platform|pid|execPath|kill)\\b",
  "\\bos\\.(?:hostname|homedir|release)\\s*\\(",
])

const bannedProtectedHostFactPatterns: ReadonlyArray<BannedPattern> = [
  {
    pattern: /\b(?:globalThis\.)?process\.cwd\s*\(/,
    message:
      "Host working directory facts are adapter-only; use RuntimeEnvironment or GentPlatform",
  },
  {
    pattern: /\bfrom\s+["'](?:node:)?os["']/,
    message: "Host OS module imports are adapter-only; use GentPlatform",
  },
  {
    pattern: /\bfrom\s+["']bun["']/,
    message:
      "Direct `bun` package imports are adapter-only; use ExtensionContext.Process or Effect platform services",
  },
  {
    // Cover every acquisition form for the crypto specifier:
    //   `from "node:crypto"`        — static `import … from`
    //   `import "node:crypto"`      — bare side-effect import
    //   `import("node:crypto")`     — dynamic import
    //   `require("node:crypto")`    — CJS require
    // The shared prefix is `from`/`import`/`require` followed by the quoted
    // specifier (with optional `(` for the call forms). Plain string usage
    // of `"crypto"` as data (param names, identifiers) does not trip.
    pattern: /(?:\bfrom\s+|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'](?:node:)?crypto["']/,
    message:
      "Host crypto module imports are adapter-only; yield GentPlatform and call platform.hash(...) or platform.randomBytes(...)",
  },
  {
    pattern: /(?:\bfrom\s+|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'](?:node:)?url["']/,
    message:
      "Host url module imports are adapter-only; yield GentPlatform and call platform.fileURLToPath(...)",
  },
  {
    pattern: /(?<![.\w])createHash\s*\(/,
    message:
      "Direct createHash() is adapter-only; yield GentPlatform and call platform.hash(algorithm, input)",
  },
  {
    pattern: /(?<![.\w])randomBytes\s*\(/,
    message:
      "Direct randomBytes() is adapter-only; yield GentPlatform and call platform.randomBytes(n) (or use the Web Crypto global `crypto.getRandomValues` if you need a sync Uint8Array)",
  },
  {
    pattern: /(?<![.\w])fileURLToPath\s*\(/,
    message:
      "Direct fileURLToPath() is adapter-only; yield GentPlatform and call platform.fileURLToPath(url)",
  },
  {
    // Bare `new URL(import.meta.url).pathname` (or `.href`) is a hand-rolled
    // fileURLToPath that bypasses the platform adapter and breaks under
    // Windows file URLs (extra leading slash on drive paths).
    pattern: /new\s+URL\s*\(\s*import\.meta\.url\s*\)/,
    message:
      "Bare `new URL(import.meta.url)` is a hand-rolled fileURLToPath; yield GentPlatform and call platform.fileURLToPath(import.meta.url)",
  },
]

const serverRootConsumerFiles = new Set(["apps/server/src/main.ts", "packages/sdk/src/server.ts"])
const platformProviderRootFiles = new Set([
  "packages/core/src/runtime/gent-platform.ts",
  "packages/core/src/runtime/gent-platform-bun.ts",
  "packages/core/src/server/server-root.ts",
  "packages/core/src/test-utils/extension-harness.ts",
  // The Anthropic extension wires a keychain-aware AnthropicClient layer that
  // needs the live Bun platform to satisfy `GentPlatform` inside the
  // request-signing transform. It's a shipped builtin, not a user extension.
  "packages/extensions/src/anthropic/index.ts",
  "apps/server/src/main.ts",
  "apps/tui/src/main.tsx",
  "packages/sdk/src/server.ts",
])

const protectedHostFactFile = (file: string): boolean =>
  (file.startsWith("packages/core/src/") || file.startsWith("packages/extensions/src/")) &&
  !file.includes("/test-utils/") &&
  file !== "packages/core/src/runtime/gent-platform-bun.ts" &&
  file !== "packages/core/src/runtime/gent-platform.ts"

const bannedServerRootConsumerPatterns: ReadonlyArray<BannedPattern> = [
  {
    pattern:
      /@gent\/core-internal\/server\/(?:dependencies|connection-tracker|server-identity|server-routes)\.js/,
    message: "Server entrypoints must use server-root instead of hand-composing app services",
  },
]

const patternsForFile = (file: string): ReadonlyArray<BannedPattern> => [
  ...bannedActiveSourcePatterns.filter(
    ({ pattern }) =>
      !(
        hostFactPatternSources.has(pattern.source) &&
        !file.startsWith("apps/server/") &&
        !file.startsWith("packages/sdk/")
      ) &&
      !(
        (file === "packages/core/src/runtime/gent-platform-bun.ts" &&
          (pattern.source === "\\bBun\\.randomUUIDv7\\b" ||
            pattern.source === "\\bprocess\\.(?:platform|pid|execPath|kill)\\b" ||
            pattern.source === "\\bos\\.(?:hostname|homedir|release)\\s*\\(")) ||
        (file === "packages/core/src/test-utils/language-model.ts" &&
          pattern.source === "\\bProvider\\.(?:Sequence|Signal|Debug|Failing)\\b") ||
        (platformProviderRootFiles.has(file) &&
          pattern.source === "\\b(?:BunPlatformLive|BunGentPlatformLive|BunCronRuntimeLive)\\b")
      ),
  ),
  ...(protectedHostFactFile(file) ? bannedProtectedHostFactPatterns : []),
  ...(serverRootConsumerFiles.has(file) ? bannedServerRootConsumerPatterns : []),
  ...(file === "packages/core/src/server/transport-contract.ts"
    ? bannedTransportContractPatterns
    : []),
  ...(file === "packages/core/src/runtime/agent/agent-runner.ts"
    ? bannedAgentRunnerCompositionPatterns
    : []),
]

const startsInsidePipeCall = (
  lines: ReadonlyArray<string>,
  index: number,
  column: number,
): boolean => {
  const prefixWindow = [...lines.slice(0, index), (lines[index] ?? "").slice(0, column)].join("\n")
  const pipeStart = prefixWindow.lastIndexOf(".pipe(")
  if (pipeStart === -1) return false

  let depth = 0
  for (const char of prefixWindow.slice(pipeStart + ".pipe".length)) {
    if (char === "(") depth++
    if (char === ")") depth--
  }

  return depth > 0
}

const startsByWrappingFunctionInvocation = (
  lines: ReadonlyArray<string>,
  index: number,
  column: number,
): boolean => {
  const firstArgumentWindow = [
    (lines[index] ?? "").slice(column),
    ...lines.slice(index + 1, index + 8),
  ].join("\n")

  return wrappedFunctionInvocationPattern.test(firstArgumentWindow.trimStart())
}

const startsWithCallbackArgument = (
  lines: ReadonlyArray<string>,
  index: number,
  column: number,
): boolean => {
  const callWindow = [(lines[index] ?? "").slice(column), ...lines.slice(index + 1, index + 8)]
    .join("\n")
    .trimStart()

  return callbackArgumentPattern.test(callWindow)
}

const declaresCallbackParameter = (declarationWindow: string): boolean => {
  const firstArrowIndex = declarationWindow.indexOf("=>")
  const signatureWindow =
    firstArrowIndex === -1 ? declarationWindow : declarationWindow.slice(0, firstArrowIndex + 2)
  return callbackParameterPattern.test(signatureWindow)
}

export const findPlatformDuplicationViolations = (
  file: string,
  text: string,
): ReadonlyArray<PlatformDuplicationFinding> => {
  const findings: PlatformDuplicationFinding[] = []

  if (!sourceFile(file)) return findings

  for (const pathPattern of bannedPathPatterns) {
    if (pathPattern.pattern.test(file)) {
      findings.push({ file, line: 1, message: pathPattern.message })
    }
  }

  const patterns = [
    ...(activeSourceFile(file) ? patternsForFile(file) : []),
    ...(referenceExtensionFile(file) ? bannedReferenceExtensionPatterns : []),
  ]
  const lines = text.split("\n")
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ""
    if (withEffectWrapperDefinitionPattern.test(line)) {
      const declarationWindow = lines.slice(index, index + 8).join("\n")
      if (effectWrapperArgumentPattern.test(declarationWindow)) {
        findings.push({ file, line: index + 1, message: withEffectWrapperMessage })
      }
      if (declaresCallbackParameter(declarationWindow)) {
        findings.push({ file, line: index + 1, message: withCallbackWrapperMessage })
      }
    }
    withFunctionInvocationPattern.lastIndex = 0
    let invocationMatch: RegExpExecArray | null
    while ((invocationMatch = withFunctionInvocationPattern.exec(line)) !== null) {
      const firstArgumentColumn = invocationMatch.index + invocationMatch[0].length
      if (
        startsByWrappingFunctionInvocation(lines, index, firstArgumentColumn) &&
        !startsInsidePipeCall(lines, index, invocationMatch.index)
      ) {
        findings.push({ file, line: index + 1, message: withFunctionInvocationMessage })
      }
      if (
        startsWithCallbackArgument(lines, index, firstArgumentColumn) &&
        !startsInsidePipeCall(lines, index, invocationMatch.index)
      ) {
        findings.push({ file, line: index + 1, message: withCallbackWrapperMessage })
      }
    }
    for (const { pattern, message } of patterns) {
      if (pattern.test(line)) {
        findings.push({ file, line: index + 1, message })
      }
    }
  }

  return findings
}
