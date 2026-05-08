import { findCorePublicExportFindings } from "./core-public-exports"

const packageJson = await Bun.file("packages/core/package.json").json()
const tsconfigJson = await Bun.file("tsconfig.json").json()
const coreInternalPackageJson = await Bun.file("packages/core-internal/package.json").json()
const findings = findCorePublicExportFindings(packageJson, tsconfigJson, coreInternalPackageJson)

if (findings.length > 0) {
  console.error("Core public export guard failed:")
  for (const finding of findings) {
    console.error(`  ${finding.path}: ${finding.message}`)
  }
  process.exit(1)
}
