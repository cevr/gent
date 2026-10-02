import { BunServices } from "@effect/platform-bun"
import { Config, Effect, FileSystem, Path, Stream } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { ChildProcess } from "effect/process"

/**
 * The shared test preload keeps every test off the network: a request or
 * connection to a remote host is refused before it leaves the process and
 * fails the test it ran under, and one to this machine goes through. The case
 * runs one test file in a child `bun test` under the preload and reads which
 * of its tests failed.
 */
const preloadTest = it.scopedLive.layer(BunServices.layer)

/** How long the child may ignore SIGTERM from the closing scope before it gets SIGKILL. */
const CHILD_KILL_GRACE = "5 seconds"

/**
 * The bound on the child run; the child takes about a second. With the kill
 * grace it ends inside 25 s, before bun's 30 s backstop from the preload, so
 * the bound fires and the scope stops the child, not bun's timeout.
 */
const CHILD_RUN_BOUND = "20 seconds"

/**
 * The entry points the guard holds, each tried against a remote host. The
 * remote host is `0.0.0.0`: the guard does not name it as this machine, yet
 * a connection to it reaches a listener on this machine, so a request that
 * got past the guard is counted, and none leaves the machine either way.
 */
const REMOTE_ENTRY_POINTS = [
  "fetch",
  "fetch.preconnect",
  "FetchHttpClient resolved as the test module loads",
  "node:http",
  "node:https",
  "node:net",
  "node:tls",
  "node:http2",
  "WebSocket",
  "Bun.connect",
] as const

/** The same entry points tried against this machine, and a Unix socket. */
const LOCAL_ENTRY_POINTS = [
  "fetch",
  "FetchHttpClient",
  "node:http",
  "node:net",
  "WebSocket",
  "Bun.connect",
  "a Unix socket",
] as const

/** The child's tests. */
const probeFile = `import { afterAll, expect, test } from "bun:test"
import * as http from "node:http"
import * as https from "node:https"
import * as http2 from "node:http2"
import * as net from "node:net"
import * as tls from "node:tls"
import { join } from "node:path"
import { Effect } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"

// Read as this module loads, the earliest a test module runs; the reference
// keeps the first value it reads for the rest of the process.
const fetchAtLoad = Effect.runSync(Effect.gen(function* () { return yield* FetchHttpClient.Fetch }))

let remoteConnections = 0
const remoteListener = Bun.listen({
  hostname: "127.0.0.1",
  port: 0,
  socket: { open(socket) { remoteConnections++; socket.end() }, data() {} },
})
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request, server) => (server.upgrade(request) ? undefined : new Response("ok")),
  websocket: { message() {} },
})
const unixPath = join(process.env.TMPDIR, "probe.sock")
const unixListener = Bun.listen({ unix: unixPath, socket: { data() {} } })
afterAll(() => { remoteListener.stop(true); server.stop(true); unixListener.stop(true) })

const remote = "0.0.0.0:" + remoteListener.port
const local = "127.0.0.1:" + server.port
const quiet = (emitter) => { emitter.on("error", () => {}); return emitter }

/** Runs send, waits for a refusal or a reply, and lets a connection land. */
const attempt = (send) =>
  new Promise((resolve) => {
    try { Promise.resolve(send()).then(resolve, resolve) } catch (error) { resolve(error) }
  }).then(() => Bun.sleep(50))

const getFetch = (url, fetch) =>
  Effect.runPromise(HttpClient.get(url).pipe(
    Effect.flatMap((response) => response.text),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
    Effect.provide(FetchHttpClient.layer),
  ))

test("remote: fetch", () => attempt(() => fetch("http://" + remote + "/")))
test("remote: fetch.preconnect", () => attempt(() => fetch.preconnect("http://" + remote + "/")))
test("remote: FetchHttpClient resolved as the test module loads", () =>
  attempt(() => getFetch("http://" + remote + "/", fetchAtLoad)))
test("remote: node:http", () => attempt(() => quiet(http.get("http://" + remote + "/"))))
test("remote: node:https", () => attempt(() => quiet(https.get("https://" + remote + "/"))))
test("remote: node:net", () => attempt(() => quiet(net.connect(remoteListener.port, "0.0.0.0"))))
test("remote: node:tls", () =>
  attempt(() => quiet(tls.connect({ host: "0.0.0.0", port: remoteListener.port, rejectUnauthorized: false }))))
test("remote: node:http2", () => attempt(() => quiet(http2.connect("http://" + remote))))
test("remote: WebSocket", () => attempt(() => { new WebSocket("ws://" + remote + "/").onerror = () => {} }))
test("remote: Bun.connect", () =>
  attempt(() => Bun.connect({ hostname: "0.0.0.0", port: remoteListener.port, socket: { data() {} } })))
test("no request reached the remote host", () => expect(remoteConnections).toBe(0))

test("local: fetch", async () => expect(await (await fetch("http://" + local + "/")).text()).toBe("ok"))
test("local: FetchHttpClient", async () => expect(await getFetch("http://" + local + "/", fetchAtLoad)).toBe("ok"))
test("local: node:http", async () => {
  const body = await new Promise((resolve, reject) =>
    http.get("http://" + local + "/", (response) => {
      let text = ""
      response.on("data", (chunk) => { text += chunk })
      response.on("end", () => resolve(text))
    }).on("error", reject))
  expect(body).toBe("ok")
})
test("local: node:net", () =>
  new Promise((resolve, reject) => {
    const socket = net.connect(server.port, "127.0.0.1", () => { socket.end(); resolve() })
    socket.on("error", reject)
  }))
test("local: WebSocket", () =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket("ws://" + local + "/")
    socket.onopen = () => { socket.close(); resolve() }
    socket.onerror = reject
  }))
test("local: Bun.connect", async () => {
  const socket = await Bun.connect({ hostname: "127.0.0.1", port: server.port, socket: { data() {} } })
  socket.end()
})
test("local: a Unix socket", () =>
  new Promise((resolve, reject) => {
    const socket = net.connect(unixPath, () => { socket.end(); resolve() })
    socket.on("error", reject)
  }))
test("fetches nothing", () => {})
`

describe("the test preload's network guard", () => {
  preloadTest(
    "a remote request fails its test and never connects; a local one and no request pass",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const tooling = yield* path.fromFileUrl(new URL("..", import.meta.url))
        const repo = yield* path.fromFileUrl(new URL("../../..", import.meta.url))
        const preload = path.join(tooling, "src", "test-preload.ts")
        const sandbox = yield* fs.makeTempDirectoryScoped({ prefix: "gent-preload-guard-" })
        // The child's test file imports `effect` from the repo's install.
        yield* fs.symlink(path.join(repo, "node_modules"), path.join(sandbox, "node_modules"))
        const file = path.join(sandbox, "network-probe.test.ts")
        yield* fs.writeFileString(file, probeFile)
        const handle = yield* ChildProcess.make("bun", ["test", "--preload", preload, file], {
          cwd: tooling,
          forceKillAfter: CHILD_KILL_GRACE,
          env: {
            PATH: yield* Config.String("PATH"),
            TMPDIR: sandbox,
            HOME: sandbox,
            NO_COLOR: "1",
          },
          extendEnv: false,
        })
        const [exitCode, output] = yield* Effect.all(
          [handle.exitCode, Stream.mkString(Stream.decodeText(handle.all))],
          { concurrency: "unbounded" },
        )
        // Bun ends a result line with the duration, so `fetch` does not match `fetch.preconnect`.
        const outcome = (name: string) => {
          if (output.includes(`(pass) ${name} [`)) return "pass"
          if (output.includes(`(fail) ${name} [`)) return "fail"
          return "missing"
        }
        expect(REMOTE_ENTRY_POINTS.map((name) => [name, outcome(`remote: ${name}`)])).toEqual(
          REMOTE_ENTRY_POINTS.map((name) => [name, "fail"]),
        )
        expect(LOCAL_ENTRY_POINTS.map((name) => [name, outcome(`local: ${name}`)])).toEqual(
          LOCAL_ENTRY_POINTS.map((name) => [name, "pass"]),
        )
        expect(outcome("no request reached the remote host")).toBe("pass")
        expect(outcome("fetches nothing")).toBe("pass")
        // Each failure names the refused target.
        for (const scheme of ["http", "tcp", "ws"]) {
          expect(output).toContain(`"${scheme}://0.0.0.0:`)
        }
        expect(Number(exitCode)).toBe(1)
      }).pipe(Effect.timeout(CHILD_RUN_BOUND)),
  )
})
