import { Option } from "effect"

/**
 * Per-model Anthropic configuration — beta flags, ccVersion, and
 * model-specific overrides. Counsel  — ports
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
export const getModelOverride = (modelId: string): Option.Option<ModelOverride> => {
  const lower = modelId.toLowerCase()
  for (const [pattern, override] of Object.entries(MODEL_CONFIG.modelOverrides)) {
    if (lower.includes(pattern)) return Option.some(override)
  }
  return Option.none()
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
  const match = Option.fromNullishOr(versionMatch)
  if (Option.isNone(match)) return false
  const major = parseInt(
    Option.getOrElse(Option.fromNullishOr(match.value[2]), () => "0"),
    10,
  )
  const minor = parseInt(
    Option.getOrElse(Option.fromNullishOr(match.value[3]), () => "0"),
    10,
  )
  // Date suffixes like 20250514 are not minor versions — treat as x.0
  let effectiveMinor = minor
  if (minor > 99) effectiveMinor = 0
  return major > 4 || (major === 4 && effectiveMinor >= 6)
}

const applyModelOverride = (betas: Array<string>, override: Option.Option<ModelOverride>): void => {
  if (Option.isNone(override)) return
  const excludedBetas = Option.fromNullishOr(override.value.exclude)
  if (Option.isSome(excludedBetas)) {
    for (const excludedBeta of excludedBetas.value) {
      const index = betas.indexOf(excludedBeta)
      if (index !== -1) betas.splice(index, 1)
    }
  }
  const addedBetas = Option.fromNullishOr(override.value.add)
  if (Option.isSome(addedBetas)) {
    for (const addedBeta of addedBetas.value) {
      if (!betas.includes(addedBeta)) betas.push(addedBeta)
    }
  }
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
  envBaseBetas: Option.Option<string>,
  excluded: Option.Option<ReadonlySet<string>> = Option.none(),
): ReadonlyArray<string> => {
  const baseRaw = Option.getOrElse(envBaseBetas, () => MODEL_CONFIG.baseBetas.join(","))
  const betas = baseRaw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  if (supports1mContext(modelId)) {
    const longContext = MODEL_CONFIG.longContextBetas[0]
    const longContextOption = Option.fromNullishOr(longContext)
    if (Option.isSome(longContextOption)) betas.push(longContextOption.value)
  }

  applyModelOverride(betas, getModelOverride(modelId))

  if (Option.isSome(excluded) && excluded.value.size > 0) {
    return betas.filter((beta) => !excluded.value.has(beta))
  }
  return betas
}
