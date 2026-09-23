// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-bun-outside-adapter` fires
// Shipped extensions take host facts through services, as core does.
import os from "os"

export const cwd = process.cwd()
export const digest = createHash("sha256")
export const bytes = randomBytes(32)
export const file = fileURLToPath(url)
export const used = [os]
