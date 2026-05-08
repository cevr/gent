interface PackageJson {
  readonly private?: boolean
  readonly exports?: Record<string, unknown>
}

interface TsConfigJson {
  readonly compilerOptions?: {
    readonly paths?: Record<string, unknown>
  }
}

export interface CorePublicSurfaceFinding {
  readonly path: string
  readonly message: string
}

export interface ExtensionsPublicSurfaceFinding {
  readonly path: string
  readonly message: string
}

const publicCoreExports = new Set(["./extensions/api", "./extensions/api.js"])
const forbiddenCorePathPrefixes = [
  "@gent/core/debug",
  "@gent/core/domain",
  "@gent/core/providers",
  "@gent/core/runtime",
  "@gent/core/server",
  "@gent/core/storage",
  "@gent/core/test-utils",
  "@gent/core/utils",
] as const

const isForbiddenCorePath = (key: string): boolean =>
  forbiddenCorePathPrefixes.some((prefix) => key === prefix || key.startsWith(`${prefix}/`))

export const findCorePublicExportFindings = (
  packageJson: PackageJson,
  tsconfigJson: TsConfigJson,
  coreInternalPackageJson?: PackageJson,
): ReadonlyArray<CorePublicSurfaceFinding> => {
  const findings: CorePublicSurfaceFinding[] = []
  const exportsMap = packageJson.exports ?? {}
  for (const key of Object.keys(exportsMap)) {
    if (publicCoreExports.has(key)) continue
    findings.push({
      path: `packages/core/package.json exports["${key}"]`,
      message:
        "Only @gent/core/extensions/api is public; workspace internals must use @gent/core-internal/*",
    })
  }

  const paths = tsconfigJson.compilerOptions?.paths ?? {}
  for (const key of Object.keys(paths)) {
    if (key === "@gent/core/extensions/api" || key === "@gent/core/extensions/api.js") continue
    if (key.startsWith("@gent/core-internal/")) continue
    if (!isForbiddenCorePath(key)) continue
    findings.push({
      path: `tsconfig.json compilerOptions.paths["${key}"]`,
      message: "Do not give TypeScript a public-looking @gent/core/* path for internal modules",
    })
  }

  if (coreInternalPackageJson !== undefined) {
    if (coreInternalPackageJson.private !== true) {
      findings.push({
        path: "packages/core-internal/package.json private",
        message: "@gent/core-internal must stay private; it is not an extension author API",
      })
    }

    const internalExports = coreInternalPackageJson.exports ?? {}
    if (internalExports["./*.js"] !== "./src/*.ts" || internalExports["./*"] !== "./src/*.ts") {
      findings.push({
        path: "packages/core-internal/package.json exports",
        message:
          "@gent/core-internal should only mirror core source through the private wildcard lane",
      })
    }
  }

  return findings
}

const publicExtensionsExports = new Set([".", "./index.js", "./client", "./client.js"])
const publicExtensionsPaths = new Set([
  "@gent/extensions",
  "@gent/extensions/index.js",
  "@gent/extensions/client",
  "@gent/extensions/client.js",
])

export const findExtensionsPublicExportFindings = (
  packageJson: PackageJson,
  tsconfigJson: TsConfigJson,
): ReadonlyArray<ExtensionsPublicSurfaceFinding> => {
  const findings: ExtensionsPublicSurfaceFinding[] = []

  if (packageJson.private !== true) {
    findings.push({
      path: "packages/extensions/package.json private",
      message:
        "@gent/extensions is the builtin composition package; publish only root/client contracts",
    })
  }

  const exportsMap = packageJson.exports ?? {}
  for (const key of Object.keys(exportsMap)) {
    if (publicExtensionsExports.has(key)) continue
    findings.push({
      path: `packages/extensions/package.json exports["${key}"]`,
      message:
        "@gent/extensions may only expose root composition and ./client; use relative source imports for internal extension tests",
    })
  }

  const paths = tsconfigJson.compilerOptions?.paths ?? {}
  for (const key of Object.keys(paths)) {
    if (!key.startsWith("@gent/extensions/")) continue
    if (publicExtensionsPaths.has(key)) continue
    findings.push({
      path: `tsconfig.json compilerOptions.paths["${key}"]`,
      message:
        "Do not create public-looking @gent/extensions/* aliases for extension implementation internals",
    })
  }

  return findings
}
