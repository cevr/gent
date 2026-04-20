/**
 * Per-model Anthropic configuration — beta flags, ccVersion, and
 * model-specific overrides. Counsel C8 — ports
 * `griffinmartin/opencode-claude-auth/src/model-config.ts` so beta
 * derivation lives in one place instead of being scattered across
 * `oauth.ts` (`DEFAULT_BETA_FLAGS`, `LONG_CONTEXT_BETAS`,
 * `getModelBetas` haiku/long-context heuristics) and `signing.ts`
 * (hard-coded `"2.1.80"`).
 *
 * The override table is matched first-match-wins by `String.includes`
 * against the lowercased model id — list more specific keys before
 * broader ones (e.g. `"opus-4-6"` before `"opus"`).
 *
 * @module
 */

export interface ModelOverride {
  /** Beta flags to remove from the base list for this model. */
  readonly exclude?: ReadonlyArray<string>
  /** Beta flags to add for this model on top of the base list. */
  readonly add?: ReadonlyArray<string>
  /** Whether the model rejects the `output_config.effort` /
   *  `thinking.effort` knobs. */
  readonly disableEffort?: boolean
}

export interface ModelConfig {
  readonly ccVersion: string
  readonly baseBetas: ReadonlyArray<string>
  readonly longContextBetas: ReadonlyArray<string>
  readonly modelOverrides: Record<string, ModelOverride>
}

/**
 * Single source of truth for Anthropic model billing / beta config.
 * Keep aligned with Claude Code's currently-advertised version + beta
 * set; reference at
 * `~/.cache/repo/griffinmartin/opencode-claude-auth/src/model-config.ts`.
 */
export const MODEL_CONFIG: ModelConfig = {
  ccVersion: "2.1.90",
  baseBetas: [
    "claude-code-20250219",
    "oauth-2025-04-20",
    "interleaved-thinking-2025-05-14",
    "prompt-caching-scope-2026-01-05",
    "context-management-2025-06-27",
  ],
  longContextBetas: ["context-1m-2025-08-07", "interleaved-thinking-2025-05-14"],
  modelOverrides: {
    haiku: {
      exclude: ["interleaved-thinking-2025-05-14"],
      disableEffort: true,
    },
    "4-6": {
      add: ["effort-2025-11-24"],
    },
    "4-7": {
      add: ["effort-2025-11-24"],
    },
  },
}

/**
 * First-match-wins lookup against the override table. Keys match by
 * `String.includes` against the lowercased model id; list more
 * specific keys before broader ones (e.g. `"opus-4-6"` before
 * `"opus"`) so the right override wins.
 */
export const getModelOverride = (modelId: string): ModelOverride | undefined => {
  const lower = modelId.toLowerCase()
  for (const [pattern, override] of Object.entries(MODEL_CONFIG.modelOverrides)) {
    if (lower.includes(pattern)) return override
  }
  return undefined
}

/** Currently-advertised Claude Code CLI version, used by the billing
 *  signature. Override via `ANTHROPIC_CLI_VERSION` env var at the call
 *  site (kept here as the default for the helper). */
export const getCcVersion = (): string => MODEL_CONFIG.ccVersion

/**
 * Heuristic — does this model id look like opus/sonnet 4.6+ (the
 * versions where 1M-context is default)? Lifted from the opencode
 * reference; broader than a pure version bump because date-suffix
 * model ids (`-20250514`) get treated as `x.0`.
 */
export const supports1mContext = (modelId: string): boolean => {
  const lower = modelId.toLowerCase()
  if (!lower.includes("opus") && !lower.includes("sonnet")) return false
  const versionMatch = lower.match(/(opus|sonnet)-(\d+)-(\d+)/)
  if (versionMatch === null) return false
  const major = parseInt(versionMatch[2] ?? "0", 10)
  const minor = parseInt(versionMatch[3] ?? "0", 10)
  // Date suffixes like 20250514 are not minor versions — treat as x.0
  const effectiveMinor = minor > 99 ? 0 : minor
  return major > 4 || (major === 4 && effectiveMinor >= 6)
}

/**
 * Compose the beta list to send for a given model. Layered:
 *   1. base = `MODEL_CONFIG.baseBetas` (or env-override), comma-split.
 *   2. + first long-context beta when `supports1mContext(modelId)` is
 *      true (matches Claude CLI behavior — opt-in via the model id
 *      version, not a separate flag).
 *   3. apply per-model `exclude` / `add` from `getModelOverride`.
 *   4. drop anything in the optional `excluded` set (used by the
 *      long-context backoff path that retries with successive
 *      long-context betas removed).
 */
export const getModelBetas = (
  modelId: string,
  envBaseBetas: string | undefined,
  excluded?: ReadonlySet<string>,
): ReadonlyArray<string> => {
  const baseRaw = envBaseBetas ?? MODEL_CONFIG.baseBetas.join(",")
  const betas = baseRaw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  if (supports1mContext(modelId)) {
    const longContext = MODEL_CONFIG.longContextBetas[0]
    if (longContext !== undefined) betas.push(longContext)
  }

  const override = getModelOverride(modelId)
  if (override !== undefined) {
    if (override.exclude !== undefined) {
      for (const ex of override.exclude) {
        const idx = betas.indexOf(ex)
        if (idx !== -1) betas.splice(idx, 1)
      }
    }
    if (override.add !== undefined) {
      for (const add of override.add) {
        if (!betas.includes(add)) betas.push(add)
      }
    }
  }

  if (excluded !== undefined && excluded.size > 0) {
    return betas.filter((beta) => !excluded.has(beta))
  }
  return betas
}
