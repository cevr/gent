import { BunServices } from "@effect/platform-bun"
import { Config, Effect, FileSystem, Path, Stream } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { ChildProcess } from "effect/process"

/**
 * The shared test preload keeps every test off the network: a fetch to a
 * remote host is refused and fails the test it ran under, and a fetch to this
 * machine goes through. The case runs one test file in a child `bun test`
 * under the preload and reads which of its tests failed.
 */
const preloadTest = it.scopedLive.layer(BunServices.layer)

/** The child's tests; the remote host is under `.invalid`, which never resolves. */
const probeFile = `import { test } from "bun:test"

test("fetches a remote host", () => fetch("https://gent-preload-probe.invalid/models").catch(() => undefined))

test("fetches this machine", () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response("ok") })
  return fetch("http://127.0.0.1:" + server.port + "/").then((response) => response.text()).finally(() => server.stop(true))
})

test("fetches nothing", () => {})
`

describe("the test preload's network guard", () => {
  preloadTest("a remote fetch fails its test; a loopback fetch and no fetch pass", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const preload = yield* path.fromFileUrl(new URL("../src/test-preload.ts", import.meta.url))
      const sandbox = yield* fs.makeTempDirectoryScoped({ prefix: "gent-preload-guard-" })
      const file = path.join(sandbox, "network-probe.test.ts")
      yield* fs.writeFileString(file, probeFile)
      const handle = yield* ChildProcess.make("bun", ["test", "--preload", preload, file], {
        cwd: yield* path.fromFileUrl(new URL("..", import.meta.url)),
        forceKillAfter: "5 seconds",
        env: { PATH: yield* Config.String("PATH"), TMPDIR: sandbox, HOME: sandbox, NO_COLOR: "1" },
        extendEnv: false,
      })
      const [exitCode, output] = yield* Effect.all(
        [handle.exitCode, Stream.mkString(Stream.decodeText(handle.all))],
        { concurrency: "unbounded" },
      )
      expect(output).toContain("(fail) fetches a remote host")
      expect(output).toContain("https://gent-preload-probe.invalid/models")
      expect(output).toContain("(pass) fetches this machine")
      expect(output).toContain("(pass) fetches nothing")
      expect(output).toContain("2 pass")
      expect(Number(exitCode)).toBe(1)
    }).pipe(Effect.timeout("60 seconds")),
  )
})
