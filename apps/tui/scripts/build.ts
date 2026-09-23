import { copyFileSync, mkdirSync, lstatSync, unlinkSync, symlinkSync } from "fs"
import { dirname, join } from "path"
import { fileURLToPath } from "url"
import { randomUUID } from "node:crypto"
import solidTransformPlugin from "@opentui/solid/bun-plugin"
import * as os from "node:os"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const rootDir = join(__dirname, "..")

console.log("Building gent...")

const binDir = join(rootDir, "bin")
mkdirSync(binDir, { recursive: true })

console.log("Transforming Solid JSX, bundling, and compiling to binary...")

// Turbo builds the declared extensions dependency before packaging this app;
// the cell ships as a sibling binary the runtime resolves by name.
copyFileSync(join(rootDir, "../../packages/extensions/dist/gent-cell"), join(binDir, "gent-cell"))

const buildResult = await Bun.build({
  entrypoints: [join(rootDir, "src/main.tsx")],
  target: "bun",
  plugins: [solidTransformPlugin],
  minify: false,
  define: {
    __GENT_COMPILED__: "true",
    __GENT_BUILTIN_ARTIFACT_ID__: JSON.stringify(`build:${randomUUID()}`),
  },
  compile: {
    target: "bun-darwin-arm64",
    outfile: join(binDir, "gent"),
    autoloadBunfig: false,
    // An extension resolves only the entries the loaders bind. Without this,
    // an unbound package (`@gent/core/host`, a typo) is fetched from the npm
    // registry at import time.
    execArgv: ["--no-install"],
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

// Symlink to global bun bin.
//
// This is opt-in. `~/.bun/bin/gent` is a single global name, and every
// checkout builds the same binary path, so an unconditional symlink hands the
// user's `gent` to whichever checkout built last. A build in an isolated
// worktree — or the one the pre-commit hook runs — would silently repoint the
// binary another session is using. Set GENT_LINK=1 to claim the name.
if (process.env["GENT_LINK"] === "1") {
  const home = process.env["HOME"] ?? os.homedir()
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
} else {
  console.log("↷ Skipped global symlink. Set GENT_LINK=1 to point ~/.bun/bin/gent here.")
}
