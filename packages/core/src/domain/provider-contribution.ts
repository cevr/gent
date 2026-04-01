/**
 * Provider contribution types — what a provider extension registers.
 *
 * Extracted from extension.ts to reduce cognitive load on the main extension type file.
 * Re-exported from extension.ts for backwards compatibility.
 */
import type { Effect } from "effect"
import type { AuthMethod, AuthAuthorizationMethod } from "./auth-method"

// Provider Contribution — what a provider extension registers

export interface ProviderContribution {
  /** Provider identifier — e.g. "anthropic", "openai", "my-custom" */
  readonly id: string
  /** Display name */
  readonly name: string
  /** Resolve a model name to a LanguageModel instance (typed as unknown to avoid domain→ai dep).
   *  authInfo is the stored auth from AuthStore (api key or oauth tokens), if available. */
  readonly resolveModel: (modelName: string, authInfo?: ProviderAuthInfo) => unknown
  /** Filter/extend the model catalog for this provider. authInfo provided when stored auth exists. */
  readonly listModels?: (
    baseCatalog: ReadonlyArray<unknown>,
    authInfo?: ProviderAuthInfo,
  ) => ReadonlyArray<unknown>
  /** Auth configuration — methods + authorize/callback handlers */
  readonly auth?: ProviderAuthContribution
  /** Build provider-specific options for the AI SDK. Called during stream/generate setup.
   *  Receives the model ID, reasoning level, and existing options — returns merged options. */
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
