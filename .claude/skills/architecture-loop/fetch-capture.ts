// Process entry: the efficiency capture preload (`efficiency.md`,
// `safety.md` exception 1). Loaded with `bun --preload` into a headless gent
// run, it replaces `fetch`:
// - an Anthropic Messages request is saved to `$CAP_DIR/req-NNN.json` and
//   answered with the next scripted step of `$CAP_DIR/script.json` as SSE;
// - an OpenAI or ChatGPT request is saved to `$CAP_DIR/oai-req-NNN.json` and
//   answered 400;
// - the public model catalog read (`GET https://models.dev/api.json`) is
//   forwarded to the network, since it is free and the run needs the catalog;
// - every other request is answered 503 without leaving the box.
// So no request reaches a paid endpoint.
//
// The run must not read the owner's login: it refuses to start unless `HOME`,
// `GENT_AUTH_DIRECTORY` and `GENT_DATA_DIR` all name directories under
// `$CAP_DIR/..` (the capture's scratch directory). The Anthropic driver reads
// Claude Code credentials from the OS home, and an OAuth login changes the
// rendered request, so a capture under the owner's home would measure the
// owner's login state, not gent. The owner is the passwd home of the user
// (`~$(id -un)` in `sh`), which `HOME` cannot fake: Bun's `os.userInfo()` reads
// `HOME`. The check runs twice: on the
// written paths before anything is created, then on the real paths
// (symlinks followed) after each directory exists. It refuses:
// - a scratch directory that is the owner's home or above it;
// - a variable outside the scratch directory;
// - a variable at or under the owner's `~/.gent`.
import { execFileSync } from "node:child_process"
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs"
import { dirname, resolve, sep } from "node:path"

/** The variables the check reads; `CAP_DIR` names the scratch directory as its parent. */
const CHECKED_VARIABLES = ["CAP_DIR", "HOME", "GENT_AUTH_DIRECTORY", "GENT_DATA_DIR"] as const

const refuse = (reason: string): never => {
  throw new Error(`fetch-capture: ${reason}`)
}

/** Whether `path` is `root` or lies under it. */
const within = (path: string, root: string): boolean =>
  path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)

const written = new Map<string, string>()
for (const name of CHECKED_VARIABLES) {
  const value = process.env[name]
  if (value === undefined || value.length === 0) refuse(`${name} is unset`)
  else written.set(name, resolve(value))
}
const writtenCapture = written.get("CAP_DIR") ?? refuse("CAP_DIR is unset")

/** The check, over one reading of the paths: as written, or as real paths. */
const check = (paths: ReadonlyMap<string, string>, scratch: string, owner: string): void => {
  if (within(owner, scratch)) {
    refuse(
      `the scratch directory ${scratch} (the parent of CAP_DIR) is the owner's home or above it`,
    )
  }
  for (const [name, path] of paths) {
    if (path === scratch || !within(path, scratch)) {
      refuse(
        `${name} must name a directory under ${scratch} (the capture's scratch directory), got ${path}`,
      )
    }
    if (within(path, `${owner}${sep}.gent`)) refuse(`${name} names the owner's gent state: ${path}`)
  }
}

/** The passwd home of the user running the capture, read without `HOME`. */
const ownerHome = execFileSync("sh", ["-c", 'eval echo "~$(id -un)"'], {
  env: { PATH: process.env["PATH"] ?? "" },
  encoding: "utf8",
}).trim()
if (!ownerHome.startsWith(sep)) refuse(`cannot read the owner's passwd home, got "${ownerHome}"`)
check(written, dirname(writtenCapture), ownerHome)
for (const path of written.values()) mkdirSync(path, { recursive: true })
const real = new Map([...written].map(([name, path]) => [name, realpathSync(path)]))
const dir = real.get("CAP_DIR") ?? refuse("CAP_DIR is unset")
check(real, realpathSync(dirname(writtenCapture)), realpathSync(ownerHome))

/** The next index of a counter kept in `$CAP_DIR/<name>`, shared across the run's processes. */
const nextIndex = (name = "counter"): number => {
  const counterFile = `${dir}/${name}`
  const n = existsSync(counterFile) ? Number(readFileSync(counterFile, "utf8")) : 0
  writeFileSync(counterFile, String(n + 1))
  return n
}

type Step =
  | { readonly kind: "tool"; readonly name: string; readonly input: unknown }
  | {
      readonly kind: "tools"
      readonly calls: ReadonlyArray<{ readonly name: string; readonly input: unknown }>
    }
  | { readonly kind: "text"; readonly text: string }

const script = (): ReadonlyArray<Step> =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the script is the operator's own fixture file
  JSON.parse(readFileSync(`${dir}/script.json`, "utf8")) as ReadonlyArray<Step>

const sse = (events: ReadonlyArray<Record<string, unknown>>): string =>
  events
    .map((event) => `event: ${String(event["type"])}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("")

const usage = (input: number) => ({
  input_tokens: input,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation: null,
  inference_geo: null,
  service_tier: null,
})

const anthropicReply = (step: Step, index: number, inputChars: number): Response => {
  const events: Array<Record<string, unknown>> = [
    {
      type: "message_start",
      message: {
        id: `msg_${index}`,
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: usage(Math.ceil(inputChars / 4)),
      },
    },
  ]
  let stop = "end_turn"
  if (step.kind === "text") {
    events.push({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    })
    events.push({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: step.text },
    })
    events.push({ type: "content_block_stop", index: 0 })
  } else {
    const calls = step.kind === "tool" ? [{ name: step.name, input: step.input }] : step.calls
    calls.forEach((call, i) => {
      events.push({
        type: "content_block_start",
        index: i,
        content_block: { type: "tool_use", id: `toolu_${index}_${i}`, name: call.name, input: {} },
      })
      events.push({
        type: "content_block_delta",
        index: i,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) },
      })
      events.push({ type: "content_block_stop", index: i })
    })
    stop = "tool_use"
  }
  events.push({
    type: "message_delta",
    delta: { stop_reason: stop, stop_sequence: null },
    usage: {
      output_tokens: 20,
      input_tokens: Math.ceil(inputChars / 4),
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  })
  events.push({ type: "message_stop" })
  return new Response(sse(events), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

/** The first message of a request body, as text, for the child marker check. */
const firstMessageText = (body: string): string => {
  const parsed: unknown = JSON.parse(body)
  if (typeof parsed !== "object" || parsed === null || !("messages" in parsed)) return ""
  const messages = parsed.messages
  if (!Array.isArray(messages)) return ""
  return JSON.stringify(messages[0] ?? "")
}

const realFetch = globalThis.fetch

const capture = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  let url: string
  if (typeof input === "string") url = input
  else if (input instanceof URL) url = input.href
  else url = input.url
  const method = init?.method ?? (input instanceof Request ? input.method : "GET")
  let body = ""
  if (typeof init?.body === "string") body = init.body
  else if (init?.body instanceof Uint8Array) body = new TextDecoder().decode(init.body)
  else if (input instanceof Request) body = await input.clone().text()
  appendFileSync(
    `${dir}/fetch.log`,
    `${new Date().toISOString()} ${method} ${url} ${body.length}\n`,
  )
  if (url.startsWith("https://api.anthropic.com/v1/messages")) {
    const marker = process.env["CHILD_MARKER"]
    if (marker !== undefined && marker.length > 0 && firstMessageText(body).includes(marker)) {
      const index = nextIndex("child-counter")
      writeFileSync(`${dir}/req-${String(index).padStart(3, "0")}-child.json`, body)
      return anthropicReply({ kind: "text", text: "Child done: 1068 lines." }, index, body.length)
    }
    const index = nextIndex()
    writeFileSync(`${dir}/req-${String(index).padStart(3, "0")}.json`, body)
    const step = script()[index] ?? { kind: "text", text: "Done." }
    return anthropicReply(step, index, body.length)
  }
  if (url.startsWith("https://api.openai.com/") || url.startsWith("https://chatgpt.com/")) {
    const index = nextIndex()
    writeFileSync(`${dir}/oai-req-${String(index).padStart(3, "0")}.json`, body)
    return new Response(
      JSON.stringify({ error: { message: "capture only", type: "invalid_request_error" } }),
      { status: 400, headers: { "content-type": "application/json" } },
    )
  }
  // The public model catalog is a free GET, forwarded; everything else is blocked.
  if (method === "GET" && url === "https://models.dev/api.json") return realFetch(url)
  return new Response("blocked by capture preload", { status: 503 })
}

globalThis.fetch = Object.assign(capture, { preconnect: realFetch.preconnect })
