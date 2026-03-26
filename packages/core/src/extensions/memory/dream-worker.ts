// @effect-diagnostics nodeBuiltinImport:off
/**
 * Dream worker — Bun.cron entry point for memory consolidation.
 *
 * Spawned by launchd (macOS) or crontab (Linux) as a fresh Bun process.
 * Shells out to gent headless mode with the appropriate memory agent.
 * Each run creates a fresh ephemeral session — no state bleed.
 */

import { $ } from "bun"
import * as Path from "node:path"
import * as Fs from "node:fs"
import { homedir } from "node:os"

const TUI_PATH = Path.resolve(import.meta.dir, "../../../../apps/tui")
const LOCK_PATH = Path.join(homedir(), ".gent", "memory", ".dream.lock")
const STATE_PATH = Path.join(homedir(), ".gent", "memory", ".dream-state.json")

interface DreamState {
  reflect?: { lastRun?: string }
  meditate?: { lastRun?: string }
}

const readState = (): DreamState => {
  try {
    return JSON.parse(Fs.readFileSync(STATE_PATH, "utf-8")) as DreamState
  } catch {
    return {}
  }
}

const writeState = (state: DreamState) => {
  const dir = Path.dirname(STATE_PATH)
  Fs.mkdirSync(dir, { recursive: true })
  const tmp = `${STATE_PATH}.tmp`
  Fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8")
  Fs.renameSync(tmp, STATE_PATH)
}

const acquireLock = (): boolean => {
  try {
    const dir = Path.dirname(LOCK_PATH)
    Fs.mkdirSync(dir, { recursive: true })
    Fs.writeFileSync(LOCK_PATH, String(process.pid), { flag: "wx" })
    return true
  } catch {
    // Lock exists — check if stale
    try {
      const pid = parseInt(Fs.readFileSync(LOCK_PATH, "utf-8").trim(), 10)
      process.kill(pid, 0) // Throws if process doesn't exist
      return false // Process is alive, lock is valid
    } catch {
      // Stale lock — remove and retry
      Fs.unlinkSync(LOCK_PATH)
      try {
        Fs.writeFileSync(LOCK_PATH, String(process.pid), { flag: "wx" })
        return true
      } catch {
        return false
      }
    }
  }
}

const releaseLock = () => {
  try {
    Fs.unlinkSync(LOCK_PATH)
  } catch {
    // Already removed
  }
}

const resolveJob = (cron: string): "reflect" | "meditate" => {
  // "0 21 * * 1-5" → reflect, "0 9 * * 0" → meditate
  if (cron.includes("21")) return "reflect"
  return "meditate"
}

export default {
  async scheduled(controller: { cron: string; scheduledTime: number }) {
    const job = resolveJob(controller.cron)

    if (!acquireLock()) {
      console.log(`[gent-memory] ${job}: skipped — another dream is running`)
      return
    }

    try {
      const agent = `memory:${job}`
      const prompt =
        job === "reflect"
          ? "Review today's sessions and extract memories worth keeping. Focus on corrections, preferences, decisions, and gotchas."
          : "Review all stored memories. Merge duplicates, prune noise, promote recurring project patterns to global principles."

      console.log(`[gent-memory] ${job}: starting`)

      await $`bun run --cwd ${TUI_PATH} dev -H -a ${agent} ${prompt}`.quiet()

      // Update state
      const state = readState()
      if (job === "reflect") {
        state.reflect = { ...state.reflect, lastRun: new Date().toISOString() }
      } else {
        state.meditate = { ...state.meditate, lastRun: new Date().toISOString() }
      }
      writeState(state)

      console.log(`[gent-memory] ${job}: done`)
    } catch (error) {
      console.error(`[gent-memory] ${job}: failed`, error)
    } finally {
      releaseLock()
    }
  },
}
