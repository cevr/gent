export interface PlatformDuplicationFinding {
  readonly file: string
  readonly line: number
  readonly message: string
}

interface BannedPattern {
  readonly pattern: RegExp
  readonly message: string
}

const activeSourceFile = (file: string): boolean =>
  /^(?:packages|apps)\//.test(file) &&
  /\.(?:[cm]?[jt]sx?)$/.test(file) &&
  file !== "packages/tooling/src/platform-duplication-guards.ts" &&
  !file.includes("/tests/") &&
  !file.includes("/fixtures/") &&
  !file.includes("/dist/")

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
    pattern: /\bprocess\.(?:platform|pid|execPath)\b/,
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
      /\b(?:SqliteStorage\.MemoryWithSql|SingleRunner\.layer|SessionRuntime\.LiveWithEntity|ResourceManagerLive|buildExtensionLayers|PromptPresenterLive|EventStoreLive)\b/,
    message: "AgentRunner must use the ephemeral child root preset",
  },
]

const hostFactPatternSources = new Set([
  "\\bprocess\\.(?:platform|pid|execPath)\\b",
  "\\bos\\.(?:hostname|homedir|release)\\s*\\(",
])

const serverRootConsumerFiles = new Set(["apps/server/src/main.ts", "packages/sdk/src/server.ts"])
const platformProviderRootFiles = new Set([
  "packages/core/src/runtime/gent-platform.ts",
  "packages/core/src/runtime/gent-platform-bun.ts",
  "packages/core/src/server/server-root.ts",
  "packages/core/src/test-utils/extension-harness.ts",
  "apps/server/src/main.ts",
  "apps/tui/src/main.tsx",
  "packages/sdk/src/server.ts",
])

const bannedServerRootConsumerPatterns: ReadonlyArray<BannedPattern> = [
  {
    pattern:
      /@gent\/core-internal\/server\/(?:dependencies|index|connection-tracker|server-identity|server-routes)\.js/,
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
            pattern.source === "\\bprocess\\.(?:platform|pid|execPath)\\b" ||
            pattern.source === "\\bos\\.(?:hostname|homedir|release)\\s*\\(")) ||
        (file === "packages/core/src/test-utils/language-model.ts" &&
          pattern.source === "\\bProvider\\.(?:Sequence|Signal|Debug|Failing)\\b") ||
        (platformProviderRootFiles.has(file) &&
          pattern.source === "\\b(?:BunPlatformLive|BunGentPlatformLive|BunCronRuntimeLive)\\b")
      ),
  ),
  ...(serverRootConsumerFiles.has(file) ? bannedServerRootConsumerPatterns : []),
  ...(file === "packages/core/src/server/transport-contract.ts"
    ? bannedTransportContractPatterns
    : []),
  ...(file === "packages/core/src/runtime/agent/agent-runner.ts"
    ? bannedAgentRunnerCompositionPatterns
    : []),
]

export const findPlatformDuplicationViolations = (
  file: string,
  text: string,
): ReadonlyArray<PlatformDuplicationFinding> => {
  const findings: PlatformDuplicationFinding[] = []

  if (!activeSourceFile(file)) return findings

  for (const pathPattern of bannedPathPatterns) {
    if (pathPattern.pattern.test(file)) {
      findings.push({ file, line: 1, message: pathPattern.message })
    }
  }

  const patterns = patternsForFile(file)
  const lines = text.split("\n")
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ""
    for (const { pattern, message } of patterns) {
      if (pattern.test(line)) {
        findings.push({ file, line: index + 1, message })
      }
    }
  }

  return findings
}
