import { Effect } from "effect"
import { AuthApi } from "../../domain/auth-store.js"
import { ProviderAuthError } from "../../domain/driver.js"
import { SessionId } from "../../domain/ids.js"
import { NotFoundError } from "../errors.js"
import { DriverInfo, DriverListResult } from "../transport-contract.js"
import type {
  AuthorizeAuthInput,
  CallbackAuthInput,
  ClearDriverOverrideInput,
  DeleteAuthKeyInput,
  DeletePermissionRuleInput,
  ListAuthProvidersInput,
  SetAuthKeyInput,
  SetDriverOverrideInput,
} from "../transport-contract.js"
import type { RpcHandlerDeps } from "./shared.js"
import { invalidateExternalDriversFor } from "./shared.js"

const authPersistenceError = (
  action: "set" | "delete",
  provider: string,
  cause: unknown,
): ProviderAuthError =>
  new ProviderAuthError({
    message: `Failed to ${action} auth for provider "${provider}"`,
    cause,
  })

export const buildConfigRpcHandlers = (deps: RpcHandlerDeps) => ({
  "permission.listRules": () => deps.configService.getPermissionRules(),

  "permission.deleteRule": ({ tool, pattern }: DeletePermissionRuleInput) =>
    deps.configService.removePermissionRule(tool, pattern),

  "model.list": () => deps.modelRegistry.list(),

  "driver.list": () =>
    Effect.gen(function* () {
      const config = yield* deps.configService.get()
      const models = yield* deps.driverRegistry.listModels()
      const externals = yield* deps.driverRegistry.listExternal()
      const drivers = [
        ...models.map((driver) =>
          DriverInfo.Model.make({
            id: driver.id,
            ...(driver.name !== undefined ? { description: driver.name } : {}),
          }),
        ),
        ...externals.map((driver) =>
          DriverInfo.External.make({
            id: driver.id,
          }),
        ),
      ]
      return new DriverListResult({
        drivers,
        overrides: config.driverOverrides ?? {},
      })
    }),

  "driver.set": ({ agentName, driver }: SetDriverOverrideInput) =>
    Effect.gen(function* () {
      if (driver._tag === "model" && driver.id !== undefined) {
        const found = yield* deps.driverRegistry.getModel(driver.id)
        if (found === undefined) {
          return yield* new NotFoundError({
            entity: "driver",
            message: `Unknown model driver "${driver.id}"`,
          })
        }
      }
      if (driver._tag === "external") {
        const found = yield* deps.driverRegistry.getExternal(driver.id)
        if (found === undefined) {
          return yield* new NotFoundError({
            entity: "driver",
            message: `Unknown external driver "${driver.id}"`,
          })
        }
      }

      const prevConfig = yield* deps.configService.get()
      const prevOverride = prevConfig.driverOverrides?.[agentName]
      yield* deps.configService.setDriverOverride(agentName, driver)
      yield* invalidateExternalDriversFor(deps.driverRegistry, prevOverride, driver)
    }),

  "driver.clear": ({ agentName }: ClearDriverOverrideInput) =>
    Effect.gen(function* () {
      const prevConfig = yield* deps.configService.get()
      const prevOverride = prevConfig.driverOverrides?.[agentName]
      yield* deps.configService.clearDriverOverride(agentName)
      yield* invalidateExternalDriversFor(deps.driverRegistry, prevOverride, undefined)
    }),

  "auth.listProviders": ({ agentName, sessionId }: ListAuthProvidersInput) =>
    Effect.gen(function* () {
      let cwd: string | undefined
      if (sessionId !== undefined && deps.storage !== undefined) {
        const session = yield* deps.storage
          .getSession(SessionId.make(sessionId))
          .pipe(Effect.orElseSucceed(() => undefined))
        cwd = session?.cwd
      }
      const config = yield* deps.configService.get(cwd)
      return yield* deps.authGuard.listProviders({
        ...(agentName !== undefined ? { agentName } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(config.driverOverrides !== undefined
          ? { driverOverrides: config.driverOverrides }
          : {}),
      })
    }),

  "auth.setKey": ({ provider, key }: SetAuthKeyInput) =>
    deps.authStore
      .set(provider, new AuthApi({ type: "api", key }))
      .pipe(Effect.mapError((error) => authPersistenceError("set", provider, error))),

  "auth.deleteKey": ({ provider }: DeleteAuthKeyInput) =>
    deps.authStore
      .remove(provider)
      .pipe(Effect.mapError((error) => authPersistenceError("delete", provider, error))),

  "auth.listMethods": () => deps.providerAuth.listMethods(),

  "auth.authorize": ({ sessionId, provider, method }: AuthorizeAuthInput) =>
    deps.providerAuth
      .authorize(sessionId, provider, method)
      .pipe(Effect.map((result) => result ?? null)),

  "auth.callback": ({ sessionId, provider, method, authorizationId, code }: CallbackAuthInput) =>
    deps.providerAuth.callback(sessionId, provider, method, authorizationId, code),
})
