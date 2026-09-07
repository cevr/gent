/** @jsxImportSource @opentui/solid */

import type { InteractionRendererProps } from "../../extensions/client-facets.js"
import { Option } from "effect"
import { useClient } from "../../client/index"
import { useRouter } from "../../router"
import { OptionList } from "./option-list"

/** Confirms a handoff. A confirmed one opens the new session seeded with the summary. */
export function HandoffRenderer(props: InteractionRendererProps) {
  const client = useClient()
  const router = useRouter()
  const resolve = (result: Parameters<InteractionRendererProps["resolve"]>[0]) => {
    props.resolve(result)
    if (!result.approved) return
    client.openHandoffSession(props.event.text, (sessionId, branchId) =>
      router.navigateToSession(sessionId, branchId),
    )
  }
  return (
    <OptionList
      header="Handoff"
      question={props.event.text}
      options={[{ label: "Yes" }, { label: "No" }]}
      onSubmit={(selections) => {
        const sel = Option.fromNullishOr(selections[0]).pipe(
          Option.map((value) => value.toLowerCase()),
          Option.getOrElse(() => "no"),
        )
        const freeform = Option.fromNullishOr(
          selections.find((value) => !["yes", "no"].includes(value.toLowerCase())),
        )
        if (Option.isSome(freeform)) {
          resolve({ approved: sel === "yes", notes: freeform.value })
          return
        }
        resolve({ approved: sel === "yes" })
      }}
      onCancel={() => resolve({ approved: false })}
    />
  )
}
