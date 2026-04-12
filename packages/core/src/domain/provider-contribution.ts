/**
 * Provider contribution types — what a provider extension registers.
 *
 * Extracted from extension.ts to reduce cognitive load on the main extension type file.
 * Re-exported from extension.ts for backwards compatibility.
 */
import type { Effect } from "effect"
import type { AuthMethod, AuthAuthorizationMethod } from "./auth-method"

// Provider Contribution — what a provider extension registers

/** Hints passed from ProviderRequest to resolveModel. Extensions bake these into their
 *  provider Config layer (e.g. AnthropicLanguageModel.Config.max_tokens). */
export interface ProviderHints {
  readonly reasoning?: string
  readonly maxTokens?: number
  readonly temperature?: number
}

export interface ProviderContribution {
  /** Provider identifier — e.g. "anthropic", "openai", "my-custom" */
  readonly id: string
  /** Display name */
  readonly name: string
  /** Resolve a model name to a ProviderResolution (typed as unknown to avoid domain→ai dep).
   *  The resolved value should be a `{ layer, keychainMode? }` object where `layer` is a
   *  `Layer<LanguageModel.LanguageModel>` with all config baked in.
   *  During migration, extensions may still return a vercel LanguageModel — provider.ts bridges them. */
  readonly resolveModel: (
    modelName: string,
    authInfo?: ProviderAuthInfo,
    hints?: ProviderHints,
  ) => unknown
  /** Filter/extend the model catalog for this provider. authInfo provided when stored auth exists. */
  readonly listModels?: (
    baseCatalog: ReadonlyArray<unknown>,
    authInfo?: ProviderAuthInfo,
  ) => ReadonlyArray<unknown>
  /** Auth configuration — methods + authorize/callback handlers */
  readonly auth?: ProviderAuthContribution
  /** @deprecated Use hints parameter on resolveModel instead. Kept for bridge compatibility. */
  readonly buildOptions?: (
    modelId: string,
    reasoning: string | undefined,
    existing: unknown,
  ) => unknown
}

/** Auth info passed to resolveModel — mirrors AuthStore entries */
export interface ProviderAuthInfo {
  readonly type: string
  readonly key?: string
  /** OAuth access token */
  readonly access?: string
  /** OAuth refresh token */
  readonly refresh?: string
  /** OAuth expiry timestamp (ms) */
  readonly expires?: number
  /** OAuth account ID */
  readonly accountId?: string
  /** Persist updated auth back to store (for token refresh) */
  readonly persist?: (updated: {
    access: string
    refresh: string
    expires: number
    accountId?: string
  }) => Promise<void>
}

/** Persist auth credentials — passed by ProviderAuth to extension auth handlers */
export type PersistAuth = (
  auth:
    | {
        readonly type: "api"
        readonly key: string
      }
    | {
        readonly type: "oauth"
        readonly access: string
        readonly refresh: string
        readonly expires: number
        readonly accountId?: string
      },
) => Effect.Effect<void>

export interface ProviderAuthorizeContext {
  readonly sessionId: string
  readonly methodIndex: number
  readonly authorizationId: string
  readonly persist: PersistAuth
}

export interface ProviderCallbackContext extends ProviderAuthorizeContext {
  readonly code?: string
}

export interface ProviderAuthContribution {
  readonly methods: ReadonlyArray<AuthMethod>
  readonly authorize?: (
    ctx: ProviderAuthorizeContext,
  ) => Effect.Effect<ProviderAuthorizationResult | undefined>
  readonly callback?: (ctx: ProviderCallbackContext) => Effect.Effect<void>
}

export interface ProviderAuthorizationResult {
  readonly url: string
  readonly method: AuthAuthorizationMethod
  readonly instructions?: string
}
