import { copyFileSync, existsSync, mkdirSync } from "fs"
import { dirname, join } from "path"
import { fileURLToPath } from "url"
import { randomUUID } from "node:crypto"
import solidTransformPlugin from "@opentui/solid/bun-plugin"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const rootDir = join(__dirname, "..")

console.log("Building gent...")

const binDir = join(rootDir, "bin")
mkdirSync(binDir, { recursive: true })

console.log("Transforming Solid JSX, bundling, and compiling to binary...")

// Turbo builds the declared extensions dependency before packaging this app;
// the cell ships as a sibling binary the runtime resolves by name. Run this
// script through the root build (`bun run build`), or it packages whatever
// worker the last turbo build left.
const cellWorker = join(rootDir, "../../packages/extensions/dist/gent-cell")
if (!existsSync(cellWorker)) {
  console.error(
    `No cell worker at ${cellWorker}. Run \`bun run build\` from the repo root: turbo builds @gent/extensions first.`,
  )
  process.exit(1)
}
copyFileSync(cellWorker, join(binDir, "gent-cell"))

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
