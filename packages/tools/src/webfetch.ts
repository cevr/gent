import { Effect, Schema } from "effect"
import { defineTool } from "@gent/core"
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
  url: Schema.String.pipe(Schema.pattern(/^https?:\/\//)).annotations({
    description: "URL to fetch (must start with http:// or https://)",
  }),
  selector: Schema.optional(Schema.String).annotations({
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
  description:
    "Fetch a URL and convert HTML to markdown. Use for researching documentation, reading web content, or gathering information from websites.",
  params: WebFetchParams,
  execute: Effect.fn("WebFetchTool.execute")(function* (params) {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(params.url, {
          headers: {
            "User-Agent": "Gent/1.0 (AI Assistant)",
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
        }),
      catch: (e) =>
        new WebFetchError({
          message: `Fetch failed: ${e instanceof Error ? e.message : String(e)}`,
          url: params.url,
          cause: e,
        }),
    })

    if (!response.ok) {
      return yield* new WebFetchError({
        message: `HTTP ${response.status}: ${response.statusText}`,
        url: params.url,
      })
    }

    const html = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (e) =>
        new WebFetchError({
          message: `Failed to read response: ${e instanceof Error ? e.message : String(e)}`,
          url: params.url,
          cause: e,
        }),
    })

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
      url: response.url, // Final URL after redirects
      content,
      title,
    }
  }),
})
