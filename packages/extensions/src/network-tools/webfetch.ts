import { Effect, Option, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import { tool } from "@gent/core/extensions/api"
import TurndownService from "turndown"
import { parseHTML } from "linkedom"

// WebFetch Error

export class WebFetchError extends Schema.TaggedError<WebFetchError>()("WebFetchError", {
  message: Schema.String,
  url: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// WebFetch Params

export const WebFetchParams = Schema.Struct({
  url: Schema.String.check(Schema.isPattern(/^https?:\/\//)).annotate({
    description: "URL to fetch (must start with http:// or https://)",
  }),
  selector: Schema.optionalKey(Schema.String).annotate({
    description: "CSS selector to extract specific content",
  }),
})

// WebFetch Result

export const WebFetchResult = Schema.Struct({
  url: Schema.String,
  content: Schema.String,
  title: Schema.optional(Schema.String),
})

// WebFetch Tool

export const WebFetchTool = tool({
  id: "webfetch",
  description:
    "Fetch a URL and convert HTML to markdown. Use for researching documentation, reading web content, or gathering information from websites.",
  promptSnippet: "Fetch a URL and convert HTML to markdown",
  params: WebFetchParams,
  output: WebFetchResult,
  execute: Effect.fn("WebFetchTool.execute")(function* (params) {
    const http = yield* HttpClient.HttpClient
    const response = yield* http
      .get(params.url, {
        headers: {
          "User-Agent": "Gent/1.0 (AI Assistant)",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      })
      .pipe(
        Effect.catchEager((e) =>
          Effect.gen(function* () {
            let message = String(e)
            if (e instanceof Error) message = e.message
            return yield* new WebFetchError({
              message: `Fetch failed: ${message}`,
              url: params.url,
              cause: e,
            })
          }),
        ),
      )

    if (response.status < 200 || response.status >= 300) {
      return yield* new WebFetchError({
        message: `HTTP ${response.status}`,
        url: params.url,
      })
    }

    const html = yield* response.text.pipe(
      Effect.catchEager((e) =>
        Effect.gen(function* () {
          let message = String(e)
          if (e instanceof Error) message = e.message
          return yield* new WebFetchError({
            message: `Failed to read response: ${message}`,
            url: params.url,
            cause: e,
          })
        }),
      ),
    )

    // Parse HTML
    const { document } = parseHTML(html)

    // Extract title
    const titleEl = document.querySelector("title")
    const title = Option.fromNullishOr(titleEl).pipe(
      Option.flatMap((element) => Option.fromNullishOr(element.textContent)),
    )

    // Select content
    const selector = Option.fromNullishOr(params.selector)
    let contentEl: Option.Option<Element>
    if (Option.isSome(selector)) {
      contentEl = Option.fromNullishOr(document.querySelector(selector.value))
      if (Option.isNone(contentEl)) {
        return yield* new WebFetchError({
          message: `Selector "${selector.value}" not found`,
          url: params.url,
        })
      }
    } else {
      // Try common content selectors
      contentEl = Option.firstSomeOf([
        Option.fromNullishOr(document.querySelector("main")),
        Option.fromNullishOr(document.querySelector("article")),
        Option.fromNullishOr(document.querySelector('[role="main"]')),
        Option.fromNullishOr(document.querySelector(".content")),
        Option.fromNullishOr(document.querySelector("#content")),
        Option.fromNullishOr(document.body),
      ])
    }

    // Remove unwanted elements
    const unwanted = ["script", "style", "nav", "header", "footer", "aside", "iframe", "noscript"]
    if (Option.isSome(contentEl)) {
      for (const tag of unwanted) {
        const elements = contentEl.value.querySelectorAll(tag)
        for (const el of elements) {
          el.remove()
        }
      }
    }

    // Convert to markdown
    const turndown = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
    })

    const markdown = turndown.turndown(
      contentEl.pipe(
        Option.map((element) => element.innerHTML),
        Option.getOrElse(() => ""),
      ),
    )

    // Truncate if too long (preserve ~50k chars for context)
    const maxLength = 50000
    let content = markdown
    if (markdown.length > maxLength) {
      content = markdown.slice(0, maxLength) + "\n\n[Content truncated...]"
    }

    return {
      url: params.url,
      content,
      title: Option.getOrUndefined(title),
    }
  }),
})
