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
]

const bannedPathPatterns: ReadonlyArray<BannedPattern> = [
  {
    pattern: /^packages\/core\/src\/server\/rpcs\/actor\.ts$/,
    message: "Public actor RPC surface is deleted; use product RPCs",
  },
]

const bannedTransportContractPatterns: ReadonlyArray<BannedPattern> = [
  {
    pattern: /\b(?:SessionInfo|BranchInfo)\b/,
    message: "Transport session DTOs mirror domain types",
  },
]

const patternsForFile = (file: string): ReadonlyArray<BannedPattern> => [
  ...bannedActiveSourcePatterns,
  ...(file === "packages/core/src/server/transport-contract.ts"
    ? bannedTransportContractPatterns
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
