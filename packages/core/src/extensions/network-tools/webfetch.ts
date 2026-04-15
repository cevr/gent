import { Effect, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import { defineTool } from "../../domain/tool.js"
import TurndownService from "turndown"
import { parseHTML } from "linkedom"

// WebFetch Error

export class WebFetchError extends Schema.TaggedErrorClass<WebFetchError>()("WebFetchError", {
  message: Schema.String,
  url: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// WebFetch Params

export const WebFetchParams = Schema.Struct({
  url: Schema.String.check(Schema.isPattern(/^https?:\/\//)).annotate({
    description: "URL to fetch (must start with http:// or https://)",
  }),
  selector: Schema.optional(Schema.String).annotate({
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

export const WebFetchTool = defineTool({
  name: "webfetch",
  concurrency: "parallel",
  idempotent: true,
  description:
    "Fetch a URL and convert HTML to markdown. Use for researching documentation, reading web content, or gathering information from websites.",
  promptSnippet: "Fetch a URL and convert HTML to markdown",
  params: WebFetchParams,
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
          Effect.fail(
            new WebFetchError({
              message: `Fetch failed: ${e instanceof Error ? e.message : String(e)}`,
              url: params.url,
              cause: e,
            }),
          ),
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
        Effect.fail(
          new WebFetchError({
            message: `Failed to read response: ${e instanceof Error ? e.message : String(e)}`,
            url: params.url,
            cause: e,
          }),
        ),
      ),
    )

    // Parse HTML
    const { document } = parseHTML(html)

    // Extract title
    const titleEl = document.querySelector("title")
    const title = titleEl?.textContent ?? undefined

    // Select content
    let contentEl: Element | null = null
    if (params.selector !== undefined) {
      contentEl = document.querySelector(params.selector)
      if (contentEl === null) {
        return yield* new WebFetchError({
          message: `Selector "${params.selector}" not found`,
          url: params.url,
        })
      }
    } else {
      // Try common content selectors
      contentEl =
        document.querySelector("main") ??
        document.querySelector("article") ??
        document.querySelector('[role="main"]') ??
        document.querySelector(".content") ??
        document.querySelector("#content") ??
        document.body
    }

    // Remove unwanted elements
    const unwanted = ["script", "style", "nav", "header", "footer", "aside", "iframe", "noscript"]
    for (const tag of unwanted) {
      const elements = contentEl?.querySelectorAll(tag) ?? []
      for (const el of elements) {
        el.remove()
      }
    }

    // Convert to markdown
    const turndown = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
    })

    const markdown = turndown.turndown(contentEl?.innerHTML ?? "")

    // Truncate if too long (preserve ~50k chars for context)
    const maxLength = 50000
    const content =
      markdown.length > maxLength
        ? markdown.slice(0, maxLength) + "\n\n[Content truncated...]"
        : markdown

    return {
      url: params.url,
      content,
      title,
    }
  }),
})
