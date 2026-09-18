#!/usr/bin/env bun
/**
 * One-command live testbed for the gent TUI.
 *
 *   bun run gamut up <preset> [--prompt <file|text>] [--no-build]
 *   bun run gamut send "<text>"
 *   bun run gamut interrupt
 *   bun run gamut read [lines]
 *   bun run gamut status
 *   bun run gamut restart
 *   bun run gamut down
 *   bun run gamut list
 *
 * `up` copies `fixture/` (the ledgerline app in its red state) to a fresh
 * scratch directory, pins the preset's models, launches this checkout's
 * `apps/tui/bin/gent` in a herdr pane, and records the run in a state file.
 * Nothing it does reaches the real `~/.gent/data.db`.
 *
 * A plain Bun script, like `apps/tui/scripts/build.ts`: it is a driver for a
 * terminal program, not part of the shipped runtime, and it runs before any
 * Effect layer exists. The pure parts it exports are covered by
 * `testbeds/gamut/tests/gamut.test.ts`.
 *
 * @module
 */

import { $ } from "bun"
import { Database } from "bun:sqlite"
import { mkdirSync, cpSync, renameSync, existsSync, rmSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"

const HERE = dirname(fileURLToPath(import.meta.url))
const CHECKOUT = resolve(HERE, "../..")
const FIXTURE = join(HERE, "fixture")
const BINARY = join(CHECKOUT, "apps/tui/bin/gent")

// ── Presets ─────────────────────────────────────────────────────────────

/** One model choice: which model, at which reasoning effort. */
export interface Slot {
  readonly modelId: string
  readonly reasoningEffort: string
}

/**
 * A preset pins three roles. The orchestrator is agent `main` in
 * `.gent/config.json`; the worker and reviewer reach the orchestrator through
 * the roster block in `AGENTS.md`, which tells it what `overrides` to pass on
 * each `delegate` call.
 */
export interface Preset {
  readonly orchestrator: Slot
  readonly worker: Slot
  readonly reviewer: Slot
}

const slot = (modelId: string, reasoningEffort: string): Slot => ({ modelId, reasoningEffort })

export const PRESETS: Record<string, Preset> = {
  "sol-luna": {
    orchestrator: slot("openai/gpt-5.6-sol", "medium"),
    worker: slot("openai/gpt-5.6-luna", "max"),
    reviewer: slot("openai/gpt-5.6-sol", "high"),
  },
  "opus-sonnet": {
    orchestrator: slot("anthropic/claude-opus-5", "medium"),
    worker: slot("anthropic/claude-sonnet-5", "high"),
    reviewer: slot("anthropic/claude-opus-5", "high"),
  },
  "sonnet-sonnet": {
    orchestrator: slot("anthropic/claude-sonnet-5", "medium"),
    worker: slot("anthropic/claude-sonnet-5", "max"),
    reviewer: slot("anthropic/claude-sonnet-5", "high"),
  },
  mixed: {
    orchestrator: slot("openai/gpt-5.6-sol", "medium"),
    worker: slot("anthropic/claude-sonnet-5", "max"),
    reviewer: slot("anthropic/claude-opus-5", "high"),
  },
  "opus-luna": {
    orchestrator: slot("anthropic/claude-opus-5", "low"),
    worker: slot("openai/gpt-5.6-luna", "max"),
    reviewer: slot("anthropic/claude-opus-5", "high"),
  },
}

// ── Pure transforms ─────────────────────────────────────────────────────

/** `.gent/config.json` for a preset: the orchestrator, as agent `main`. */
export const presetConfigJson = (preset: Preset): string =>
  `${JSON.stringify({ agents: { main: preset.orchestrator } }, null, 2)}\n`

const ROSTER_START = "<!-- roster -->"
const ROSTER_END = "<!-- /roster -->"

/** The roster block body for a preset, markers included. */
export const rosterBlock = (preset: Preset): string =>
  [
    ROSTER_START,
    `- Worker (fix or feature): \`overrides.modelId\` = \`${preset.worker.modelId}\`, \`overrides.reasoningEffort\` = \`${preset.worker.reasoningEffort}\``,
    `- Reviewer (second opinion on a diff): \`overrides.modelId\` = \`${preset.reviewer.modelId}\`, \`overrides.reasoningEffort\` = \`${preset.reviewer.reasoningEffort}\``,
    ROSTER_END,
  ].join("\n")

/**
 * Replace the roster block in an `AGENTS.md` body. The markers are the
 * contract: text outside them is the orchestration prose the agent reads, and
 * it survives every preset switch.
 */
export const rewriteRoster = (agentsMd: string, preset: Preset): string => {
  const start = agentsMd.indexOf(ROSTER_START)
  const end = agentsMd.indexOf(ROSTER_END)
  if (start < 0 || end < 0) throw new Error("AGENTS.md has no roster block")
  return agentsMd.slice(0, start) + rosterBlock(preset) + agentsMd.slice(end + ROSTER_END.length)
}

/** What `up` records so every later subcommand can find the run. */
export interface GamutState {
  readonly root: string
  readonly work: string
  readonly data: string
  readonly pane: string
  readonly binary: string
  readonly preset: string
}

export const encodeState = (state: GamutState): string => `${JSON.stringify(state, null, 2)}\n`

export const decodeState = (text: string): GamutState => {
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== "object" || parsed === null) throw new Error("state file is not an object")
  const record = parsed as Record<string, unknown>
  const field = (name: keyof GamutState): string => {
    const value = record[name]
    if (typeof value !== "string") throw new Error(`state file field ${name} is not a string`)
    return value
  }
  return {
    root: field("root"),
    work: field("work"),
    data: field("data"),
    pane: field("pane"),
    binary: field("binary"),
    preset: field("preset"),
  }
}

// ── State file ──────────────────────────────────────────────────────────

/**
 * One run per checkout. Two rifts run the gamut at the same time, so the
 * state file carries the checkout name; a shared file let one rift's `down`
 * close the other rift's pane.
 */
export const stateFileFor = (checkoutRoot: string): string =>
  join(tmpdir(), `gent-gamut-${basename(checkoutRoot)}.json`)

const STATE_FILE = stateFileFor(resolve(import.meta.dir, "../.."))

const readState = async (): Promise<GamutState> => {
  const file = Bun.file(STATE_FILE)
  if (!(await file.exists())) {
    throw new Error(`no gamut run is up (${STATE_FILE} is missing). Run: bun run gamut up <preset>`)
  }
  return decodeState(await file.text())
}

// ── The default prompt ──────────────────────────────────────────────────

/**
 * Written the way a person asks, not as a checklist: the run is meant to
 * exercise how the orchestrator plans and splits work on its own.
 */
const DEFAULT_PROMPT =
  "Can you work through the open tasks in the README? AGENTS.md says how to " +
  "split them up. Run the tests and typecheck when you're done and tell me " +
  "how each one went."

/** `--prompt` takes a file path or the prompt text itself. */
const resolvePrompt = async (value: string): Promise<string> => {
  const file = Bun.file(value)
  if (await file.exists()) return (await file.text()).trim()
  return value
}

// ── herdr pane ──────────────────────────────────────────────────────────

/** The `pane_id` out of a `herdr pane split` reply. */
export const paneIdFromSplit = (stdout: string): string => {
  const parsed: unknown = JSON.parse(stdout)
  const result = (parsed as { result?: { pane?: { pane_id?: unknown } } }).result
  const paneId = result?.pane?.pane_id
  if (typeof paneId !== "string") throw new Error(`herdr pane split gave no pane id: ${stdout}`)
  return paneId
}

/**
 * Single-quote one argument for the pane's shell.
 *
 * `herdr pane run` joins its command words into a line the pane's shell then
 * splits again, so a prompt with spaces arrives as several positional
 * arguments and gent rejects it. Quoting here is what survives that round
 * trip; the embedded-quote form closes the quote, escapes the `'`, reopens.
 */
export const shellQuote = (argument: string): string => `'${argument.replaceAll("'", `'\\''`)}'`

/** Ctrl-C as the raw byte. `send-keys` does not deliver Ctrl chords. */
const CTRL_C = "\x03"

/** Poll until no process is running the binary, so a relaunch gets a shell. */
const waitForBinaryGone = async (binary: string): Promise<void> => {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const alive = await $`pgrep -f ${binary}`.quiet().nothrow()
    if (alive.exitCode !== 0) return
    await Bun.sleep(500)
  }
  throw new Error(`${binary} is still running after 15s; kill it before relaunching`)
}

/**
 * Quit the TUI: two Ctrl-C (the first interrupts a turn, the second exits),
 * then wait for the process to release the PTY. `pkill` returns before the
 * process is gone, and herdr writes into whatever is attached at that moment.
 */
const quitTui = async (state: GamutState): Promise<void> => {
  await $`herdr pane send-text ${state.pane} ${CTRL_C}`.quiet().nothrow()
  await Bun.sleep(300)
  await $`herdr pane send-text ${state.pane} ${CTRL_C}`.quiet().nothrow()
  await waitForBinaryGone(state.binary)
}

// ── up ──────────────────────────────────────────────────────────────────

const up = async (presetName: string, promptArg: string | undefined, build: boolean) => {
  const preset = PRESETS[presetName]
  if (!preset) {
    throw new Error(`unknown preset: ${presetName}. Presets: ${Object.keys(PRESETS).join(", ")}`)
  }
  if (existsSync(STATE_FILE)) {
    throw new Error(`a gamut run is already up (${STATE_FILE}). Run: bun run gamut down`)
  }

  const root = join(tmpdir(), `gent-gamut-${Date.now()}`)
  const work = join(root, "work")
  const data = join(root, "data")
  mkdirSync(work, { recursive: true })
  mkdirSync(data, { recursive: true })

  // The fixture ships its ignore file under a neutral name so the repo's own
  // git does not apply it to the checked-in copy.
  cpSync(FIXTURE, work, { recursive: true })
  renameSync(join(work, ".gitignore.fixture"), join(work, ".gitignore"))

  await Bun.write(join(work, ".gent/config.json"), presetConfigJson(preset))
  const agentsPath = join(work, "AGENTS.md")
  await Bun.write(agentsPath, rewriteRoster(await Bun.file(agentsPath).text(), preset))

  console.log(`work  ${work}`)
  console.log(`data  ${data}`)
  console.log(`preset ${presetName}  orchestrator ${preset.orchestrator.modelId}`)

  console.log("installing…")
  await $`bun install --silent`.cwd(work).quiet()

  // A git repo so the agent can diff, and so a child's edits are recoverable.
  await $`git init -q`.cwd(work).quiet()
  await $`git add -A`.cwd(work).quiet()
  await $`git -c user.name=gamut -c user.email=gamut@local commit -q -m "ledgerline: red suite with six open tasks"`
    .cwd(work)
    .quiet()

  if (build) {
    // Build from THIS checkout. `gent` is a compiled binary: source edits show
    // nothing until a rebuild, and `~/.bun/bin/gent` may point elsewhere.
    // GENT_LINK stays unset so the build does not claim the global name.
    console.log("building gent from this checkout…")
    await $`bun run build`.cwd(join(CHECKOUT, "apps/tui")).quiet()
  }
  if (!existsSync(BINARY)) throw new Error(`no binary at ${BINARY}; run without --no-build`)

  const prompt = promptArg === undefined ? DEFAULT_PROMPT : await resolvePrompt(promptArg)

  // GENT_DATA_DIR redirects `data.db`. Auth does NOT follow it: the auth store
  // resolves from `${home}/.gent/auth` (server/dependencies.ts), so the real
  // provider credentials keep working while the database stays isolated.
  // Split down, not right: a right split of an already split pane leaves the
  // TUI about 55 columns wide, the status line drops its first item (the
  // `idle` word), and `wait` never settles.
  const split =
    await $`herdr pane split --current --direction down --cwd ${work} --env GENT_DATA_DIR=${data}`.text()
  const pane = paneIdFromSplit(split)

  const state: GamutState = { root, work, data, pane, binary: BINARY, preset: presetName }
  await Bun.write(STATE_FILE, encodeState(state))

  await $`herdr pane run ${pane} ${shellQuote(BINARY)} -p ${shellQuote(prompt)}`.quiet()
  console.log(`pane  ${pane}`)
  console.log(`state ${STATE_FILE}`)
}

// ── status ──────────────────────────────────────────────────────────────

interface SessionRow {
  readonly id: string
  readonly name: string | null
  readonly parent_session_id: string | null
}

/** Indent a session by its depth in the parent chain. */
const sessionTree = (
  rows: ReadonlyArray<SessionRow>,
): ReadonlyArray<{ row: SessionRow; depth: number }> => {
  const byParent = new Map<string | null, Array<SessionRow>>()
  for (const row of rows) {
    const key = row.parent_session_id
    const siblings = byParent.get(key) ?? []
    siblings.push(row)
    byParent.set(key, siblings)
  }
  const out: Array<{ row: SessionRow; depth: number }> = []
  const walk = (parent: string | null, depth: number): void => {
    for (const row of byParent.get(parent) ?? []) {
      out.push({ row, depth })
      walk(row.id, depth + 1)
    }
  }
  walk(null, 0)
  // A child whose parent is outside this database still has to appear.
  const seen = new Set(out.map((entry) => entry.row.id))
  for (const row of rows) if (!seen.has(row.id)) out.push({ row, depth: 0 })
  return out
}

const status = async () => {
  const state = await readState()
  const dbPath = join(state.data, "data.db")
  if (!existsSync(dbPath)) {
    console.log(`no database yet at ${dbPath} — the run has not stored a turn`)
    return
  }
  const db = new Database(dbPath, { readonly: true })

  const sessions = db
    .query(`SELECT id, name, parent_session_id FROM sessions ORDER BY created_at`)
    .all() as Array<SessionRow>

  // `StreamEnded.model` is where the model that produced a step is recorded.
  const modelOf = db.query(
    `SELECT json_extract(event_json, '$.model') AS model FROM events
     WHERE session_id = ? AND event_tag = 'StreamEnded'
       AND json_extract(event_json, '$.model') IS NOT NULL
     ORDER BY id DESC LIMIT 1`,
  )
  const toolCallsOf = db.query(
    `SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND event_tag = 'ToolCallStarted'`,
  )

  console.log("sessions:")
  for (const { row, depth } of sessionTree(sessions)) {
    const model = modelOf.get(row.id) as { model: string | null } | null
    const tools = toolCallsOf.get(row.id) as { n: number } | null
    const indent = "  ".repeat(depth + 1)
    console.log(
      `${indent}${row.id}  ${row.name ?? "(unnamed)"}  model=${model?.model ?? "-"}  toolCalls=${tools?.n ?? 0}`,
    )
  }

  // A user message's text lives in the chunk parts, one row per part.
  const userMessages = db
    .query(
      `SELECT m.session_id AS session_id, json_extract(cc.part_json, '$.text') AS text
       FROM messages m
       JOIN message_chunks mc ON mc.message_id = m.id
       JOIN content_chunks cc ON cc.id = mc.chunk_id
       WHERE m.role = 'user' AND json_extract(cc.part_json, '$.type') = 'text'
       ORDER BY m.created_at, mc.ordinal`,
    )
    .all() as Array<{ session_id: string; text: string | null }>
  console.log(`\nuser messages (${userMessages.length}):`)
  for (const message of userMessages) {
    console.log(`  [${message.session_id.slice(0, 8)}] ${JSON.stringify(message.text)}`)
  }
  db.close()

  console.log("\nbun test in the work dir:")
  const tests = await $`bun test`.cwd(state.work).quiet().nothrow()
  const output = tests.stderr.toString() + tests.stdout.toString()
  const pass = /^\s*(\d+) pass/m.exec(output)?.[1] ?? "?"
  const fail = /^\s*(\d+) fail/m.exec(output)?.[1] ?? "?"
  console.log(`  ${pass} pass, ${fail} fail`)
}

// ── the rest ────────────────────────────────────────────────────────────

const send = async (text: string) => {
  const state = await readState()
  // The pane is running the TUI, not a shell: the text goes into the composer
  // verbatim and Enter submits it. No shell quoting — that would be typed too.
  await $`herdr pane send-text ${state.pane} ${text}`.quiet()
  await $`herdr pane send-keys ${state.pane} Enter`.quiet()
}

const interrupt = async () => {
  const state = await readState()
  await $`herdr pane send-text ${state.pane} ${CTRL_C}`.quiet()
}

const read = async (lines: string) => {
  const state = await readState()
  console.log(await $`herdr pane read ${state.pane} --lines ${lines}`.text())
}

/**
 * Whether the pane shows a finished run: the status line reads idle and the
 * agents tray lists no working child. The prompt text is echoed in the
 * transcript, so matching on a word the reply should contain proves nothing.
 */
export const isSettled = (paneText: string): boolean => {
  const lines = paneText.split("\n").map((line) => line.trim())
  return (
    lines.some((line) => line.startsWith("idle ·")) &&
    !lines.some((line) => / working · /.test(line))
  )
}

const wait = async (timeoutSeconds: string) => {
  const state = await readState()
  const deadline = Date.now() + Number(timeoutSeconds) * 1000
  let settledReads = 0
  while (Date.now() < deadline) {
    const text = await $`herdr pane read ${state.pane} --lines 12`.text()
    settledReads = isSettled(text) ? settledReads + 1 : 0
    // Two reads in a row: a background child's result starts a new turn by itself.
    if (settledReads >= 2) return
    await Bun.sleep(3000)
  }
  console.error(`not settled after ${timeoutSeconds}s`)
  process.exitCode = 1
}

const restart = async () => {
  const state = await readState()
  await quitTui(state)
  await $`herdr pane run ${state.pane} ${shellQuote(state.binary)} resume`.quiet()
  console.log(`relaunched in ${state.pane}`)
}

const down = async () => {
  const state = await readState()
  await quitTui(state)
  await $`herdr pane close ${state.pane}`.quiet().nothrow()
  // `trash` is this machine's guardrail for deletes; fall back when absent.
  const trashed = await $`trash ${state.root}`.quiet().nothrow()
  if (trashed.exitCode !== 0) rmSync(state.root, { recursive: true, force: true })
  rmSync(STATE_FILE, { force: true })
  console.log(`closed ${state.pane}, removed ${state.root}`)
}

const list = () => {
  for (const [name, preset] of Object.entries(PRESETS)) {
    const format = (s: Slot) => `${s.modelId}:${s.reasoningEffort}`
    console.log(
      `${name.padEnd(14)} orchestrator ${format(preset.orchestrator).padEnd(34)} worker ${format(preset.worker).padEnd(34)} reviewer ${format(preset.reviewer)}`,
    )
  }
}

// ── entry ───────────────────────────────────────────────────────────────

const USAGE = `usage: bun run gamut <command>
  up <preset> [--prompt <file|text>] [--no-build]   fresh scratch run in a new pane
  send <text>                                       type text + Enter into the pane
  interrupt                                         send one Ctrl-C
  read [lines]                                      print the pane tail (default 60)
  wait [seconds]                                    block until the run is idle with no working child (default 600)
  status                                            sessions, models, prompts, tool calls, bun test
  restart                                           quit the TUI and resume the session
  down                                              quit, close the pane, remove the scratch dir
  list                                              presets`

const main = async (argv: ReadonlyArray<string>): Promise<void> => {
  const [command, ...rest] = argv
  switch (command) {
    case "up": {
      const positional = rest.filter((arg) => !arg.startsWith("--"))
      const promptIndex = rest.indexOf("--prompt")
      const prompt = promptIndex >= 0 ? rest[promptIndex + 1] : undefined
      const presetName = positional.find((arg) => arg !== prompt) ?? ""
      return up(presetName, prompt, !rest.includes("--no-build"))
    }
    case "send":
      return send(rest.join(" "))
    case "interrupt":
      return interrupt()
    case "read":
      return read(rest[0] ?? "60")
    case "wait":
      return wait(rest[0] ?? "600")
    case "status":
      return status()
    case "restart":
      return restart()
    case "down":
      return down()
    case "list":
      return list()
    default:
      console.log(USAGE)
  }
}

if (import.meta.main) await main(process.argv.slice(2))
