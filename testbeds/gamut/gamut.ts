#!/usr/bin/env bun
/**
 * One-command live testbed for the gent TUI.
 *
 *   bun run gamut up <preset> [--prompt <file|text>] [--no-build]
 *   bun run gamut send "<text>"
 *   bun run gamut interrupt
 *   bun run gamut read [lines]
 *   bun run gamut wait [seconds]
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
 * A plain Bun script: it is a driver for a terminal program, not part of the
 * shipped runtime, and it builds no Effect layer. The pure parts it exports
 * are covered by `testbeds/gamut/tests/gamut.test.ts`.
 *
 * @module
 */

import { $ } from "bun"
import { Database } from "bun:sqlite"
import { mkdirSync, cpSync, renameSync, existsSync, rmSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import { Schema } from "effect"

const HERE = dirname(fileURLToPath(import.meta.url))
const CHECKOUT = resolve(HERE, "../..")
const FIXTURE = join(HERE, "fixture")
const BINARY = join(CHECKOUT, "apps/tui/bin/gent")

// ── Presets ─────────────────────────────────────────────────────────────

/** One model choice: which model, at which reasoning effort. */
interface Slot {
  readonly modelId: string
  readonly reasoningEffort: string
}

/**
 * A preset pins three roles. The orchestrator is agent `main` and the worker
 * is agent `delegate` in `.gent/config.json`: the pairing every child runs
 * under with no override. The reviewer reaches the orchestrator through the
 * roster block in `AGENTS.md`, which tells it what `overrides` to pass on a
 * `delegate.start` call that wants the second opinion.
 */
interface Preset {
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

/** `.gent/config.json` for a preset: the orchestrator as agent `main`, the worker as agent `delegate`. */
export const presetConfigJson = (preset: Preset): string =>
  `${JSON.stringify({ agents: { main: preset.orchestrator, delegate: preset.worker } }, null, 2)}\n`

const ROSTER_START = "<!-- roster -->"
const ROSTER_END = "<!-- /roster -->"

/** The roster block body for a preset, markers included. */
export const rosterBlock = (preset: Preset): string =>
  [
    ROSTER_START,
    `- Worker (fix or feature): the \`delegate\` agent, paired in \`.gent/config.json\` as \`${preset.worker.modelId}\` at \`${preset.worker.reasoningEffort}\`. Pass no model override.`,
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
  /**
   * The newest event id when `send` last typed a message (zero until then).
   * `wait` counts only a turn newer than it, so the turn the previous prompt
   * finished cannot pass for the one just sent.
   */
  readonly sendMark: number
  /**
   * Whether the last thing typed starts a turn. A prompt does; a slash
   * command (`/model …`, `/goal status`) runs in the client and may start
   * none, so `wait` takes any event stored after the send as proof it was
   * handled, or a quiet period when it stores nothing (`waitStep`).
   */
  readonly awaitsTurn: boolean
}

export const encodeState = (state: GamutState): string => `${JSON.stringify(state, null, 2)}\n`

/**
 * The state file as written. `sendMark` and `awaitsTurn` are absent in a file
 * an older `up` wrote.
 */
const StateFile = Schema.fromJsonString(
  Schema.Struct({
    root: Schema.String,
    work: Schema.String,
    data: Schema.String,
    pane: Schema.String,
    binary: Schema.String,
    preset: Schema.String,
    sendMark: Schema.optional(Schema.Finite),
    awaitsTurn: Schema.optional(Schema.Boolean),
  }),
)

export const decodeState = (text: string): GamutState => {
  const state = Schema.decodeSync(StateFile)(text)
  return { ...state, sendMark: state.sendMark ?? 0, awaitsTurn: state.awaitsTurn ?? true }
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
const SplitReply = Schema.fromJsonString(
  Schema.Struct({ result: Schema.Struct({ pane: Schema.Struct({ pane_id: Schema.String }) }) }),
)

export const paneIdFromSplit = (stdout: string): string => {
  const reply = Schema.decodeOption(SplitReply)(stdout)
  if (reply._tag === "None") throw new Error(`herdr pane split gave no pane id: ${stdout}`)
  return reply.value.result.pane.pane_id
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

/**
 * The one line to show for a failed command. herdr answers a failed CLI call
 * with `{"error":{"message":...}}`; other commands say why on
 * stderr, so its last non-empty line wins, then stdout's.
 */
/** A herdr JSON error reply. */
const ErrorReply = Schema.fromJsonString(
  Schema.Struct({ error: Schema.Struct({ message: Schema.String }) }),
)

export const failureText = (stdout: string, stderr: string): string => {
  for (const text of [stdout, stderr]) {
    const reply = Schema.decodeOption(ErrorReply)(text.trim())
    if (reply._tag === "Some") return reply.value.error.message
  }
  const lastLine = (text: string) =>
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .at(-1)
  return lastLine(stderr) ?? lastLine(stdout) ?? "no output"
}

/**
 * Fail before any copy or build when there is no herdr pane to split. `up`
 * splits the current pane, so the check is the same question herdr answers
 * for `--current`: is a server running, and is this shell inside one of its
 * panes.
 */
const requireHerdrPane = async (): Promise<void> => {
  const probe = await $`herdr pane current`.quiet().nothrow()
  if (probe.exitCode === 0) return
  const reason = failureText(probe.stdout.toString(), probe.stderr.toString())
  throw new Error(`herdr has no current pane (${reason}); start herdr, then rerun from a pane`)
}

/** Ctrl-C as the raw byte. `send-keys` does not deliver Ctrl chords. */
const CTRL_C = "\x03"

/**
 * The `pgrep -f` pattern for a process running `binary` itself: the command
 * line starts with the path and the path ends there. An unanchored path also
 * matches its `gent-cell` sibling (`bin/gent` is a prefix of `bin/gent-cell`).
 */
export const binaryProcessPattern = (binary: string): string => {
  const literal = binary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return `^${literal}( |$)`
}

const binaryRunning = async (binary: string): Promise<boolean> =>
  (await $`pgrep -f ${binaryProcessPattern(binary)}`.quiet().nothrow()).exitCode === 0

/** Poll until no process is running the binary, so a relaunch gets a shell. */
const waitForBinaryGone = async (binary: string): Promise<void> => {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (!(await binaryRunning(binary))) return
    await Bun.sleep(500)
  }
  throw new Error(`${binary} is still running after 15s; kill it before relaunching`)
}

/**
 * Ctrl-C presses that reach exit from the deepest state: each press peels one
 * layer (an expanded transcript, a draft in the composer, a running turn),
 * and the last one exits.
 */
const QUIT_PRESSES = 4

/**
 * Quit the TUI: Ctrl-C until the binary is gone, at most `QUIT_PRESSES`,
 * then wait for the process to release the PTY. `pkill` returns before the
 * process is gone, and herdr writes into whatever is attached at that moment.
 */
const quitTui = async (state: GamutState): Promise<void> => {
  // A press sent after the TUI exited lands at an idle shell prompt: `restart` relaunches only after this returns.
  for (let press = 0; press < QUIT_PRESSES; press += 1) {
    await $`herdr pane send-text ${state.pane} ${CTRL_C}`.quiet().nothrow()
    await Bun.sleep(300)
    if (!(await binaryRunning(state.binary))) return
  }
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
  await requireHerdrPane()

  const root = join(tmpdir(), `gent-gamut-${Date.now()}`)
  // Until the state file names `root`, `down` cannot find it: a failed `up`
  // removes it here instead.
  try {
    await prepareAndLaunch(presetName, preset, promptArg, build, root)
  } catch (error) {
    if (!existsSync(STATE_FILE)) await removeTree(root)
    throw error
  }
}

/** `trash` is this machine's guardrail for deletes; fall back when absent. */
const removeTree = async (path: string): Promise<void> => {
  const trashed = await $`trash ${path}`.quiet().nothrow()
  if (trashed.exitCode !== 0) rmSync(path, { recursive: true, force: true })
}

const prepareAndLaunch = async (
  presetName: string,
  preset: Preset,
  promptArg: string | undefined,
  build: boolean,
  root: string,
) => {
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
    // Build from THIS checkout. `gent` and its `gent-cell` worker are compiled
    // binaries: source edits show nothing until a rebuild, and `~/.bun/bin/gent`
    // may be another build. The root build is turbo's, so an unchanged checkout
    // is a cache hit. The build never claims the global name; only
    // `bun run install:global` does.
    console.log("building gent from this checkout…")
    await $`bun run build`.cwd(CHECKOUT).quiet()
  }
  if (!existsSync(BINARY)) throw new Error(`no binary at ${BINARY}; run without --no-build`)

  const prompt = promptArg === undefined ? DEFAULT_PROMPT : await resolvePrompt(promptArg)

  // GENT_DATA_DIR redirects `data.db`. Auth does NOT follow it: the auth store
  // resolves from `${home}/.gent/auth` (server/server.ts), so the real
  // provider credentials keep working while the database stays isolated.
  // Split down, not right: a right split of an already split pane leaves the
  // TUI about 55 columns wide and the status line drops its leading items.
  const split =
    await $`herdr pane split --current --direction down --cwd ${work} --env GENT_DATA_DIR=${data}`.text()
  const pane = paneIdFromSplit(split)

  const state: GamutState = {
    root,
    work,
    data,
    pane,
    binary: BINARY,
    preset: presetName,
    sendMark: 0,
    awaitsTurn: true,
  }
  await Bun.write(STATE_FILE, encodeState(state))

  await $`herdr pane run ${pane} ${shellQuote(BINARY)} -p ${shellQuote(prompt)}`.quiet()
  console.log(`pane  ${pane}`)
  console.log(`state ${STATE_FILE}`)
}

// ── status ──────────────────────────────────────────────────────────────

const SessionRow = Schema.Struct({
  id: Schema.String,
  name: Schema.NullOr(Schema.String),
  parent_session_id: Schema.NullOr(Schema.String),
})
type SessionRow = typeof SessionRow.Type

/** SQLite rows are untyped: each read decodes the shape its query selects. */
const decodeRows = <S extends Schema.Decoder<unknown>>(
  schema: S,
  rows: unknown,
): ReadonlyArray<S["Type"]> => Schema.decodeUnknownSync(Schema.Array(schema))(rows)

const decodeRow = <S extends Schema.Decoder<unknown>>(
  schema: S,
  row: unknown,
): S["Type"] | undefined => (row === null ? undefined : Schema.decodeSync(schema)(row))

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

/**
 * Stored `ExtensionStateChanged` events per extension id, most first: how
 * often each extension told its client widgets to refetch during the run.
 */
export const extensionPulses = (
  db: Database,
): ReadonlyArray<{ readonly extension: string; readonly count: number }> =>
  decodeRows(
    Schema.Struct({ extension: Schema.String, count: Schema.Finite }),
    db
      .query(
        `SELECT json_extract(event_json, '$.extensionId') AS extension, COUNT(*) AS count
         FROM events WHERE event_tag = 'ExtensionStateChanged'
         GROUP BY extension ORDER BY count DESC, extension`,
      )
      .all(),
  )

const status = async () => {
  const state = await readState()
  const dbPath = join(state.data, "data.db")
  if (!existsSync(dbPath)) {
    console.log(`no database yet at ${dbPath} — the run has not stored a turn`)
    return
  }
  const db = new Database(dbPath, { readonly: true })

  const sessions = decodeRows(
    SessionRow,
    db.query(`SELECT id, name, parent_session_id FROM sessions ORDER BY created_at`).all(),
  )

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
    const model = decodeRow(
      Schema.Struct({ model: Schema.NullOr(Schema.String) }),
      modelOf.get(row.id),
    )
    const tools = decodeRow(Schema.Struct({ n: Schema.Finite }), toolCallsOf.get(row.id))
    const indent = "  ".repeat(depth + 1)
    console.log(
      `${indent}${row.id}  ${row.name ?? "(unnamed)"}  model=${model?.model ?? "-"}  toolCalls=${tools?.n ?? 0}`,
    )
  }

  // A user message's text lives in the chunk parts, one row per part.
  const userMessageRows = db
    .query(
      `SELECT m.session_id AS session_id, json_extract(cc.part_json, '$.text') AS text
       FROM messages m
       JOIN message_chunks mc ON mc.message_id = m.id
       JOIN content_chunks cc ON cc.id = mc.chunk_id
       WHERE m.role = 'user' AND json_extract(cc.part_json, '$.type') = 'text'
       ORDER BY m.created_at, mc.ordinal`,
    )
    .all()
  const userMessages = decodeRows(
    Schema.Struct({ session_id: Schema.String, text: Schema.NullOr(Schema.String) }),
    userMessageRows,
  )
  console.log(`\nuser messages (${userMessages.length}):`)
  for (const message of userMessages) {
    console.log(`  [${message.session_id.slice(-8)}] ${JSON.stringify(message.text)}`)
  }

  const pulses = extensionPulses(db)
  console.log(`\nextension pulses (stored ExtensionStateChanged, ${pulses.length} extensions):`)
  for (const { extension, count } of pulses) console.log(`  ${extension}  ${count}`)
  db.close()

  console.log("\nbun test in the work dir:")
  const tests = await $`bun test`.cwd(state.work).quiet().nothrow()
  console.log(`  ${testSummary(tests.stderr.toString() + tests.stdout.toString())}`)
}

/**
 * `17 pass, 0 fail` from a `bun test` run. Bun colours its summary even when
 * piped (`\x1b[0m\x1b[32m 17 pass`), so the colour is stripped before reading.
 */
export const testSummary = (output: string): string => {
  const plain = Bun.stripANSI(output)
  const pass = /^\s*(\d+) pass/m.exec(plain)?.[1] ?? "?"
  const fail = /^\s*(\d+) fail/m.exec(plain)?.[1] ?? "?"
  return `${pass} pass, ${fail} fail`
}

// ── the rest ────────────────────────────────────────────────────────────

/** A prompt starts a turn; a slash command runs in the client and may start none. */
export const sendAwaitsTurn = (text: string): boolean => !text.trimStart().startsWith("/")

const send = async (text: string) => {
  const state = await readState()
  // Mark before typing: the message is stored after this id.
  await Bun.write(
    STATE_FILE,
    encodeState({
      ...state,
      sendMark: latestEventIn(state.data),
      awaitsTurn: sendAwaitsTurn(text),
    }),
  )
  // The pane is running the TUI, not a shell: the text goes into the composer
  // verbatim and Enter submits it. No shell quoting — that would be typed too.
  await $`herdr pane send-text ${state.pane} ${text}`.quiet()
  await $`herdr pane send-keys ${state.pane} Enter`.quiet()
}

const interrupt = async () => {
  const state = await readState()
  await $`herdr pane send-text ${state.pane} ${CTRL_C}`.quiet()
}

const read = async (lines: number) => {
  const state = await readState()
  console.log(await $`herdr pane read ${state.pane} --lines ${lines}`.text())
}

/**
 * What the run's own events say: whether any turn has started, and which
 * sessions have a turn that has not ended. A turn starts with a user-role
 * `MessageReceived` (a prompt, a wake, a child's completion) or a
 * `StreamStarted`. It ends with `TurnCompleted`, or with `ErrorOccurred` when
 * it fails. The pane shows the agents tray only while it is on screen, so a
 * child still working can be invisible there; the events are the record.
 */
export interface RunRecord {
  readonly started: boolean
  readonly open: ReadonlyArray<string>
  /**
   * Whether any event was stored after the send mark: the trace a handled
   * slash command leaves (its own record, a note, a queued prompt).
   */
  readonly stored: boolean
}

/**
 * The events that start a turn. An assistant or tool `MessageReceived` is
 * stored inside a turn, or outside one when a command presents a note
 * (`/goal status` stores a hidden assistant message), so it starts nothing.
 */
const TURN_START = `(event_tag = 'StreamStarted'
  OR (event_tag = 'MessageReceived' AND json_extract(event_json, '$.message.role') = 'user'))`

export const openTurnSessions = (db: Database): ReadonlyArray<string> =>
  decodeRows(
    Schema.Struct({ session_id: Schema.String }),
    db
      .query(
        `SELECT session_id FROM events GROUP BY session_id
         HAVING MAX(CASE WHEN ${TURN_START} THEN id END)
           > COALESCE(MAX(CASE WHEN event_tag IN ('TurnCompleted', 'ErrorOccurred') THEN id END), 0)`,
      )
      .all(),
  ).map((row) => row.session_id)

/** A turn has started after `sendMark` (an event id), which turns are open, and whether anything was stored since. */
export const runRecord = (db: Database, sendMark: number): RunRecord => ({
  started:
    db.query(`SELECT 1 FROM events WHERE ${TURN_START} AND id > ? LIMIT 1`).get(sendMark) !== null,
  open: openTurnSessions(db),
  stored: db.query(`SELECT 1 FROM events WHERE id > ? LIMIT 1`).get(sendMark) !== null,
})

/** The newest event id, zero before any event. */
export const latestEventId = (db: Database): number =>
  Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Finite }))(
    db.query(`SELECT COALESCE(MAX(id), 0) AS id FROM events`).get(),
  ).id

const readRunDb = <A>(dataDir: string, absent: A, read: (db: Database) => A): A => {
  const dbPath = join(dataDir, "data.db")
  if (!existsSync(dbPath)) return absent
  const db = new Database(dbPath, { readonly: true })
  try {
    return read(db)
  } finally {
    db.close()
  }
}

const runRecordIn = (dataDir: string, sendMark: number): RunRecord =>
  readRunDb(dataDir, { started: false, open: [], stored: false }, (db) => runRecord(db, sendMark))

const latestEventIn = (dataDir: string): number => readRunDb(dataDir, 0, latestEventId)

/**
 * Whether the pane and the record are idle: every turn has ended and the pane
 * shows no busy row. The footer is only a hint: its first slot shows `idle`,
 * `ready`, a held error or an extension notice (`apps/tui/src/app.tsx`,
 * `phaseLabels`), and the error and notice texts are free text, so the footer
 * cannot say idle on its own. The prompt text is echoed in the transcript, so
 * matching on a word the reply should contain proves nothing either.
 */
const isIdle = (paneText: string, record: RunRecord): boolean => {
  const lines = paneText.split("\n").map((line) => line.trim())
  const busy = lines.some((line) => / working · /.test(line) || /^Generating\b/.test(line))
  return record.open.length === 0 && !busy
}

/** Where a wait stands: idle reads in a row with and without proof the send was handled. */
interface WaitProgress {
  readonly settledReads: number
  readonly quietReads: number
}

export const WAIT_START: WaitProgress = { settledReads: 0, quietReads: 0 }

/**
 * Idle reads in a row (3 s apart) after which a slash command that stored
 * nothing is taken as handled. A command that queues a turn (`/plan`,
 * `/review`) stores its prompt well inside this window.
 */
export const QUIET_READS = 5

/**
 * Fold one pane read into the wait. An idle read counts only with proof the
 * send was handled: a turn started after it for a prompt, any stored event
 * after it for a slash command (its record, a note, a queued prompt). Two such
 * reads in a row settle: a background child's result starts a new turn by
 * itself. A slash command that leaves no trace settles after `QUIET_READS`
 * idle reads. A busy read starts the count again.
 */
export const waitStep = (
  progress: WaitProgress,
  paneText: string,
  record: RunRecord,
  awaitsTurn: boolean,
): WaitProgress => {
  if (!isIdle(paneText, record)) return WAIT_START
  const handled = awaitsTurn ? record.started : record.stored
  if (handled) return { settledReads: progress.settledReads + 1, quietReads: 0 }
  if (awaitsTurn) return WAIT_START
  return { settledReads: 0, quietReads: progress.quietReads + 1 }
}

export const isSettled = (progress: WaitProgress): boolean =>
  progress.settledReads >= 2 || progress.quietReads >= QUIET_READS

/** A positive whole count (seconds, lines) from the command line; anything else is refused. */
export const parseCount = (name: string, value: string): number => {
  const count = Number(value)
  if (!/^\d+$/.test(value) || count <= 0) {
    throw new Error(`${name} must be a positive whole number, got ${JSON.stringify(value)}`)
  }
  return count
}

const wait = async (timeoutSeconds: number) => {
  const state = await readState()
  const deadline = Date.now() + timeoutSeconds * 1000
  let progress = WAIT_START
  let record: RunRecord = { started: false, open: [], stored: false }
  while (Date.now() < deadline) {
    const text = await $`herdr pane read ${state.pane} --lines 12`.text()
    record = runRecordIn(state.data, state.sendMark)
    progress = waitStep(progress, text, record, state.awaitsTurn)
    if (isSettled(progress)) return
    await Bun.sleep(3000)
  }
  const turns = record.started
    ? `open turns: ${record.open.join(", ") || "none"}`
    : "no turn started"
  console.error(`not settled after ${timeoutSeconds}s; ${turns}`)
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
  await removeTree(state.root)
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

/** `up`'s arguments. `--prompt` takes the next argument, which may not be a flag. */
export const parseUpArgs = (
  rest: ReadonlyArray<string>,
): { readonly preset: string; readonly prompt: string | undefined; readonly build: boolean } => {
  const promptIndex = rest.indexOf("--prompt")
  const prompt = promptIndex >= 0 ? rest[promptIndex + 1] : undefined
  if (promptIndex >= 0 && (prompt === undefined || prompt.startsWith("--"))) {
    throw new Error("--prompt needs a value: a file path or the prompt text")
  }
  const positional = rest.filter(
    (arg, index) => !arg.startsWith("--") && (promptIndex < 0 || index !== promptIndex + 1),
  )
  return { preset: positional[0] ?? "", prompt, build: !rest.includes("--no-build") }
}

const main = async (argv: ReadonlyArray<string>): Promise<void> => {
  const [command, ...rest] = argv
  switch (command) {
    case "up": {
      const args = parseUpArgs(rest)
      return up(args.preset, args.prompt, args.build)
    }
    case "send":
      return send(rest.join(" "))
    case "interrupt":
      return interrupt()
    case "read":
      return read(parseCount("read lines", rest[0] ?? "60"))
    case "wait":
      return wait(parseCount("wait seconds", rest[0] ?? "600"))
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

/**
 * One line per failure. A failed herdr, git or bun call throws a `ShellError`
 * whose default print is a source frame and a stack; the reader needs the
 * exit code and what the command said.
 */
const failureLine = (error: unknown): string => {
  if (error instanceof $.ShellError) {
    const said = failureText(error.stdout.toString(), error.stderr.toString())
    return `gamut: a command failed (exit ${error.exitCode}): ${said}`
  }
  return `gamut: ${error instanceof Error ? error.message : String(error)}`
}

if (import.meta.main) {
  await main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(failureLine(error))
    process.exitCode = 1
  })
}
