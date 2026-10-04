// The site as a visitor and as `curl | sh` meet it: the routes the Railway
// service mounts, served over real HTTP on this machine, with GitHub replaced
// by a fake client that answers the release download.
import { BunHttpServer } from "@effect/platform-bun"
import { Effect, Layer, Option, Ref } from "effect"
import { HttpClient, HttpClientResponse, HttpRouter } from "effect/http"
import { describe, expect, it } from "effect-bun-test"
import * as Site from "../src/site"

const RELEASE_SCRIPT = "#!/bin/sh\necho installing the release\n"
const BUNDLED_SCRIPT = "#!/bin/sh\necho installing the bundled copy\n"

type GitHub = "release" | "no-release" | "down"

/** A GitHub that answers the release download as told, counting requests. */
const fakeGitHub = (github: GitHub) =>
  Effect.gen(function* () {
    const requests = yield* Ref.make<ReadonlyArray<string>>([])
    const client = HttpClient.make((request) =>
      Effect.gen(function* () {
        yield* Ref.update(requests, (list) => [...list, request.url])
        if (github === "release" && request.url === Site.RELEASE_INSTALLER_URL) {
          return HttpClientResponse.fromWeb(request, new Response(RELEASE_SCRIPT, { status: 200 }))
        }
        if (github === "down") {
          return HttpClientResponse.fromWeb(request, new Response("unicorn", { status: 503 }))
        }
        return HttpClientResponse.fromWeb(request, new Response("Not Found", { status: 404 }))
      }),
    )
    return { layer: Layer.succeed(HttpClient.HttpClient, client), requests: Ref.get(requests) }
  })

/** The site served on a test port, its GitHub reads going to `github`. */
const served = (github: Layer.Layer<HttpClient.HttpClient>, bundled: Option.Option<string>) =>
  HttpRouter.serve(Site.layer({ bundledInstaller: bundled }).pipe(Layer.provide(github))).pipe(
    Layer.provideMerge(BunHttpServer.layerTest),
  )

const get = Effect.fn("test.get")(function* (path: string) {
  const response = yield* HttpClient.get(path)
  return { status: response.status, headers: response.headers, body: yield* response.text }
})

describe("install script", () => {
  it.live("serves the latest release's installer when one exists, and reads GitHub once", () =>
    Effect.gen(function* () {
      const github = yield* fakeGitHub("release")
      yield* Effect.gen(function* () {
        for (const path of ["/install.sh", "/install", "/install.sh"]) {
          const response = yield* get(path)
          expect([path, response.status, response.body]).toEqual([path, 200, RELEASE_SCRIPT])
          expect(response.headers["x-gent-install-source"]).toBe("release")
          expect(response.headers["content-type"]).toContain("text/plain")
        }
      }).pipe(Effect.provide(served(github.layer, Option.some(BUNDLED_SCRIPT))))
      expect(yield* github.requests).toEqual([Site.RELEASE_INSTALLER_URL])
    }).pipe(Effect.timeout("8 seconds")),
  )

  it.live("serves the bundled copy when GitHub has no release or fails", () =>
    Effect.gen(function* () {
      for (const answer of ["no-release", "down"] as const) {
        const github = yield* fakeGitHub(answer)
        const response = yield* get("/install.sh").pipe(
          Effect.provide(served(github.layer, Option.some(BUNDLED_SCRIPT))),
        )
        expect([answer, response.status, response.body]).toEqual([answer, 200, BUNDLED_SCRIPT])
        expect(response.headers["x-gent-install-source"]).toBe("bundled")
      }
    }).pipe(Effect.timeout("8 seconds")),
  )

  it.live("with no release and no bundled copy, serves a script that says so and exits 1", () =>
    Effect.gen(function* () {
      const github = yield* fakeGitHub("no-release")
      const response = yield* get("/install.sh").pipe(
        Effect.provide(served(github.layer, Option.none())),
      )
      // 200, not 404: `curl -f` would print nothing and `sh` would exit 0.
      expect(response.status).toBe(200)
      expect(response.headers["x-gent-install-source"]).toBe("none")
      expect(response.body).toBe(Site.NO_RELEASE_SCRIPT)
      expect(response.body).toContain("no release yet")
      expect(response.body).toContain("exit 1")
    }).pipe(Effect.timeout("8 seconds")),
  )
})

describe("landing page", () => {
  it.live("says what gent is, gives the install line, and links GitHub and releases", () =>
    Effect.gen(function* () {
      const github = yield* fakeGitHub("no-release")
      const response = yield* get("/").pipe(Effect.provide(served(github.layer, Option.none())))
      expect(response.status).toBe(200)
      expect(response.headers["content-type"]).toContain("text/html")
      expect(response.body).toContain("agent harness")
      expect(response.body).toContain(Site.INSTALL_LINE)
      expect(response.body).toContain(`href="${Site.REPO_URL}"`)
      expect(response.body).toContain(`href="${Site.RELEASES_URL}"`)
      expect(response.body).toContain('name="viewport"')
      // The page loads nothing from anywhere else: no tracker, no font, no CDN.
      expect(response.body).not.toMatch(/<(script|link|img)[^>]+(src|href)="https?:/)
      // Rendering the page asks GitHub nothing.
      expect(yield* github.requests).toEqual([])
    }).pipe(Effect.timeout("8 seconds")),
  )

  it.live("answers the health check, and an unknown path is a 404", () =>
    Effect.gen(function* () {
      const github = yield* fakeGitHub("no-release")
      yield* Effect.gen(function* () {
        const health = yield* get("/healthz")
        expect([health.status, health.body]).toEqual([200, "ok"])
        expect((yield* get("/nope")).status).toBe(404)
      }).pipe(Effect.provide(served(github.layer, Option.none())))
    }).pipe(Effect.timeout("8 seconds")),
  )
})
