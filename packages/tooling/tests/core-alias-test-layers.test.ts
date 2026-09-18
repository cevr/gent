import { describe, expect, test } from "bun:test"
import { findAliasTestLayers } from "../src/guards"

const FILE = "packages/core/src/domain/widget.ts"

const wrap = (member: string): string =>
  `export class Widget extends Context.Tag("Widget")<Widget, WidgetService>() {\n${member}\n}\n`

describe("alias alternative-layer guard", () => {
  test("flags a single-line alias under any alternative name", () => {
    for (const name of ["Test", "Fake", "Stub", "Mock"]) {
      const findings = findAliasTestLayers(
        FILE,
        wrap(`  static ${name} = (): Layer.Layer<Widget> => Widget.Live`),
      )
      expect(findings.map((finding) => `${finding.file}:${finding.line}`)).toEqual([`${FILE}:2`])
      expect(findings[0]?.message).toContain(`static ${name}`)
      expect(findings[0]?.message).toContain("Widget.Live")
    }
  })

  test("flags an alias the formatter broke across lines", () => {
    const findings = findAliasTestLayers(
      FILE,
      wrap(
        [
          "  static Test = (",
          "    options: WidgetOptions = {},",
          "  ): Layer.Layer<Widget> =>",
          "    Widget.Live",
        ].join("\n"),
      ),
    )
    expect(findings.map((finding) => `${finding.file}:${finding.line}`)).toEqual([`${FILE}:2`])
    expect(findings[0]?.message).toContain("Widget.Live")
  })

  test("flags a property alias that carries no arrow head", () => {
    const findings = findAliasTestLayers(
      FILE,
      wrap("  static Fake: Layer.Layer<Widget> = Widget.Live"),
    )
    expect(findings.map((finding) => `${finding.file}:${finding.line}`)).toEqual([`${FILE}:2`])
    expect(findings[0]?.message).toContain("static Fake")
  })

  test("leaves a member name outside the alternative table alone", () => {
    const findings = findAliasTestLayers(
      FILE,
      wrap("  static Memory: Layer.Layer<Widget> = Widget.Live"),
    )
    expect(findings).toEqual([])
  })

  test("accepts an alternative that builds its own implementation", () => {
    const findings = findAliasTestLayers(
      FILE,
      wrap(
        [
          "  static Test = (): Layer.Layer<Widget> =>",
          "    Layer.succeed(",
          "      Widget,",
          "      Widget.of({",
          "        read: Effect.succeed(0),",
          "      }),",
          "    )",
        ].join("\n"),
      ),
    )
    expect(findings).toEqual([])
  })

  test("accepts an alternative that delegates to a sibling that is not Live", () => {
    const findings = findAliasTestLayers(
      FILE,
      wrap("  static Test = (): Layer.Layer<Widget> => Widget.fromResolved(resolveWidgets([]))"),
    )
    expect(findings).toEqual([])
  })

  test("accepts a following member that does alias Live in a later class", () => {
    const findings = findAliasTestLayers(
      FILE,
      wrap(
        [
          "  static Test = (): Layer.Layer<Widget> =>",
          "    Layer.succeed(Widget, Widget.of({ read: Effect.succeed(0) }))",
          "",
          "  static describe = (): string => `Widget.Live`",
        ].join("\n"),
      ),
    )
    expect(findings).toEqual([])
  })

  test("flags an alias in an app source tree, not only a package one", () => {
    const file = "apps/tui/src/services/widget.ts"
    const findings = findAliasTestLayers(
      file,
      wrap("  static Test = (): Layer.Layer<Widget> => Widget.Live"),
    )
    expect(findings.map((finding) => `${finding.file}:${finding.line}`)).toEqual([`${file}:2`])
    expect(findings[0]?.message).toContain("Widget.Live")
  })

  test("ignores files outside a shipped source tree", () => {
    const member = "  static Test = (): Layer.Layer<Widget> => Widget.Live"
    expect(findAliasTestLayers("packages/core/tests/domain/widget.test.ts", wrap(member))).toEqual(
      [],
    )
    expect(findAliasTestLayers("apps/tui/tests/services/widget.test.ts", wrap(member))).toEqual([])
    expect(findAliasTestLayers("scripts/widget.ts", wrap(member))).toEqual([])
    expect(findAliasTestLayers("ARCHITECTURE.md", wrap(member))).toEqual([])
  })
})
