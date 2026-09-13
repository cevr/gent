import { DateTime, Effect, FileSystem, Path } from "effect"

const OUTPUT_DIR = "/tmp/gent/outputs"

/**
 * Save full output to /tmp/gent/outputs/ and return the path.
 */
export const saveFullOutput = (output: string, label: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* fs.makeDirectory(OUTPUT_DIR, { recursive: true })

    const now = yield* DateTime.nowAsDate
    const timestamp = now.toISOString().replace(/[:.]/g, "-")
    const safeName = label.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40)
    const filename = `${safeName}_${timestamp}.txt`
    const filepath = path.join(OUTPUT_DIR, filename)

    const header = `# Label: ${label}\n# Timestamp: ${now.toISOString()}\n\n`
    yield* fs.writeFileString(filepath, header + output)

    return filepath
  })
