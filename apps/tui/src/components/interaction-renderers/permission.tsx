/** @jsxImportSource @opentui/solid */

import type { InteractionRendererProps } from "@gent/core/domain/extension-client.js"
import { OptionList } from "./option-list"

function summarizeInput(input: unknown): string {
  if (input === null || input === undefined) return ""
  const raw = typeof input === "string" ? input : JSON.stringify(input)
  return raw.length > 120 ? raw.slice(0, 120) + "..." : raw
}

export function PermissionRenderer(props: InteractionRendererProps<"PermissionRequested">) {
  const summary = summarizeInput(props.event.input)
  const question =
    summary.length > 0
      ? `Allow ${props.event.toolName} (${summary})?`
      : `Allow ${props.event.toolName}?`

  return (
    <OptionList
      header="Permission"
      question={question}
      options={[
        { label: "Allow" },
        { label: "Always Allow" },
        { label: "Deny" },
        { label: "Always Deny" },
      ]}
      onSubmit={(selections) => {
        const sel = selections[0]?.toLowerCase() ?? "deny"
        if (sel === "always allow") return props.resolve({ _tag: "allow", persist: true })
        if (sel === "always deny") return props.resolve({ _tag: "deny", persist: true })
        if (sel === "allow") return props.resolve({ _tag: "allow", persist: false })
        props.resolve({ _tag: "deny", persist: false })
      }}
      onCancel={() => props.resolve({ _tag: "deny", persist: false })}
    />
  )
}
