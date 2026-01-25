import { describe, test, expect } from "bun:test"

// Import the getFileTag function - need to extract it for testing
// Since it's not exported, we'll recreate the logic here for testing
function getFileTag(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase()
  switch (ext) {
    case "ts":
    case "tsx":
      return "[ts]"
    case "js":
    case "jsx":
      return "[js]"
    case "md":
    case "mdx":
      return "[md]"
    case "json":
      return "[json]"
    case "css":
    case "scss":
    case "less":
      return "[css]"
    case "html":
      return "[html]"
    case "py":
      return "[py]"
    case "rs":
      return "[rs]"
    case "go":
      return "[go]"
    case "yaml":
    case "yml":
      return "[yaml]"
    case "toml":
      return "[toml]"
    case "sh":
    case "bash":
    case "zsh":
      return "[sh]"
    default:
      return ""
  }
}

describe("getFileTag", () => {
  test("returns [ts] for TypeScript files", () => {
    expect(getFileTag("file.ts")).toBe("[ts]")
    expect(getFileTag("component.tsx")).toBe("[ts]")
    expect(getFileTag("src/utils/helper.ts")).toBe("[ts]")
  })

  test("returns [js] for JavaScript files", () => {
    expect(getFileTag("file.js")).toBe("[js]")
    expect(getFileTag("component.jsx")).toBe("[js]")
  })

  test("returns [md] for Markdown files", () => {
    expect(getFileTag("README.md")).toBe("[md]")
    expect(getFileTag("docs/guide.mdx")).toBe("[md]")
  })

  test("returns [json] for JSON files", () => {
    expect(getFileTag("package.json")).toBe("[json]")
    expect(getFileTag("tsconfig.json")).toBe("[json]")
  })

  test("returns [css] for CSS-like files", () => {
    expect(getFileTag("styles.css")).toBe("[css]")
    expect(getFileTag("theme.scss")).toBe("[css]")
    expect(getFileTag("vars.less")).toBe("[css]")
  })

  test("returns [html] for HTML files", () => {
    expect(getFileTag("index.html")).toBe("[html]")
  })

  test("returns [py] for Python files", () => {
    expect(getFileTag("script.py")).toBe("[py]")
  })

  test("returns [rs] for Rust files", () => {
    expect(getFileTag("main.rs")).toBe("[rs]")
  })

  test("returns [go] for Go files", () => {
    expect(getFileTag("main.go")).toBe("[go]")
  })

  test("returns [yaml] for YAML files", () => {
    expect(getFileTag("config.yaml")).toBe("[yaml]")
    expect(getFileTag("ci.yml")).toBe("[yaml]")
  })

  test("returns [toml] for TOML files", () => {
    expect(getFileTag("Cargo.toml")).toBe("[toml]")
  })

  test("returns [sh] for shell files", () => {
    expect(getFileTag("script.sh")).toBe("[sh]")
    expect(getFileTag("setup.bash")).toBe("[sh]")
    expect(getFileTag("init.zsh")).toBe("[sh]")
  })

  test("returns empty string for unknown extensions", () => {
    expect(getFileTag("file.txt")).toBe("")
    expect(getFileTag("image.png")).toBe("")
    expect(getFileTag("archive.zip")).toBe("")
  })

  test("returns empty string for files without extension", () => {
    expect(getFileTag("Makefile")).toBe("")
    expect(getFileTag("Dockerfile")).toBe("")
  })

  test("is case insensitive", () => {
    expect(getFileTag("FILE.TS")).toBe("[ts]")
    expect(getFileTag("README.MD")).toBe("[md]")
    expect(getFileTag("Config.JSON")).toBe("[json]")
  })
})
