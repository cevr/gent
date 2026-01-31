import { mkdirSync, lstatSync, unlinkSync, symlinkSync } from "fs"
import { dirname, join } from "path"
import { fileURLToPath } from "url"
import solidTransformPlugin from "@opentui/solid/bun-plugin"
import { Config, Effect, Option } from "effect"
import * as os from "node:os"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const rootDir = join(__dirname, "..")

console.log("Building gent...")

const binDir = join(rootDir, "bin")
mkdirSync(binDir, { recursive: true })

console.log("Transforming Solid JSX, bundling, and compiling to binary...")

const buildResult = await Bun.build({
  entrypoints: [join(rootDir, "src/main.tsx")],
  target: "bun",
  plugins: [solidTransformPlugin],
  minify: false,
  compile: {
    target: "bun-darwin-arm64",
    outfile: join(binDir, "gent"),
    autoloadBunfig: false,
  },
})

if (!buildResult.success) {
  console.error("Build failed:")
  for (const log of buildResult.logs) {
    console.error(log)
  }
  process.exit(1)
}

console.log(`✅ Binary built: ${join(binDir, "gent")}`)

// Symlink to global bun bin
const home = Effect.runSync(
  Config.option(Config.string("HOME")).pipe(
    Effect.catchAll(() => Effect.succeed(Option.none())),
    Effect.map(Option.getOrElse(() => os.homedir())),
  ),
)
const bunBin = join(home, ".bun", "bin", "gent")
try {
  try {
    lstatSync(bunBin)
    unlinkSync(bunBin)
  } catch {
    // doesn't exist
  }
  symlinkSync(join(binDir, "gent"), bunBin)
  console.log(`✅ Symlinked to: ${bunBin}`)
} catch (e) {
  console.log(`⚠️  Could not symlink to ${bunBin}: ${e}`)
}
