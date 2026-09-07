import { createContext, type ParentProps } from "solid-js"
import { Option } from "effect"
import type { BranchId } from "@gent/core-internal/domain/ids.js"
import type { ComposerInteractionState } from "./composer-interaction-state"
import { useRequiredContext } from "../utils/solid-context"

export type ComposerDraft = Pick<ComposerInteractionState, "draft" | "mode">

interface ComposerDrafts {
  readonly get: (branchId: BranchId) => Option.Option<ComposerDraft>
  readonly set: (branchId: BranchId, draft: ComposerDraft) => void
}

const ComposerDraftsContext = createContext<ComposerDrafts>()

export function ComposerDraftsProvider(props: ParentProps) {
  const drafts = new Map<BranchId, ComposerDraft>()
  const value: ComposerDrafts = {
    get: (branchId) => Option.fromNullishOr(drafts.get(branchId)),
    set: (branchId, draft) => {
      if (draft.draft.length === 0 && draft.mode === "editing") {
        drafts.delete(branchId)
        return
      }
      drafts.set(branchId, draft)
    },
  }
  return (
    <ComposerDraftsContext.Provider value={value}>{props.children}</ComposerDraftsContext.Provider>
  )
}

export const useComposerDrafts = () =>
  useRequiredContext(ComposerDraftsContext, "Composer drafts require ComposerDraftsProvider")
