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

const publicCoreExports = new Set(["./extensions/api", "./extensions/api.js"])
const forbiddenPublicExportPrefixes = [
  "./debug",
  "./domain",
  "./providers",
  "./runtime",
  "./server",
  "./storage",
  "./test-utils",
  "./utils",
] as const

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

const isForbiddenExport = (key: string): boolean =>
  forbiddenPublicExportPrefixes.some(
    (prefix) => key === prefix || key === `${prefix}.js` || key.startsWith(`${prefix}/`),
  )

const isForbiddenCorePath = (key: string): boolean =>
  forbiddenCorePathPrefixes.some((prefix) => key === prefix || key.startsWith(`${prefix}/`))

export const findCorePublicExportFindings = (
  packageJson: PackageJson,
  tsconfigJson: TsConfigJson,
  coreInternalPackageJson?: PackageJson,
): ReadonlyArray<CorePublicSurfaceFinding> => {
  const findings: CorePublicSurfaceFinding[] = []
  const exportsMap = packageJson.exports ?? {}
  for (const [key, value] of Object.entries(exportsMap)) {
    if (publicCoreExports.has(key)) continue
    if (isForbiddenExport(key) && value === null) continue
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
