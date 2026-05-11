import { Effect } from "effect"
import type { BranchId, SessionId } from "../domain/ids.js"
import type { Branch, BranchTreeNode } from "../domain/message.js"
import { BranchStorage } from "../storage/branch-storage.js"
import type { StorageError } from "../domain/storage-error.js"

type MutableBranchTreeNode = Omit<BranchTreeNode, "children"> & {
  children: MutableBranchTreeNode[]
}

export const buildBranchTree = (
  branches: ReadonlyArray<Branch>,
  messageCounts: ReadonlyMap<BranchId, number>,
): BranchTreeNode[] => {
  const nodes = new Map<BranchId, MutableBranchTreeNode>()

  for (const branch of branches) {
    nodes.set(branch.id, {
      branch,
      messageCount: messageCounts.get(branch.id) ?? 0,
      children: [],
    })
  }

  const roots: MutableBranchTreeNode[] = []
  for (const branch of branches) {
    const node = nodes.get(branch.id)
    if (node === undefined) continue
    if (
      branch.parentBranchId !== undefined &&
      branch.parentBranchId !== "" &&
      nodes.has(branch.parentBranchId)
    ) {
      const parent = nodes.get(branch.parentBranchId)
      if (parent !== undefined) parent.children.push(node)
      continue
    }
    roots.push(node)
  }

  const sortNodes = (list: MutableBranchTreeNode[]) => {
    list.sort((a, b) => a.branch.createdAt.getTime() - b.branch.createdAt.getTime())
    for (const node of list) {
      if (node.children.length > 0) sortNodes(node.children)
    }
  }

  sortNodes(roots)
  return roots
}

export const getBranchTree = (
  sessionId: SessionId,
): Effect.Effect<ReadonlyArray<BranchTreeNode>, StorageError, BranchStorage> =>
  Effect.gen(function* () {
    const branchStorage = yield* BranchStorage
    const branches = yield* branchStorage.listBranches(sessionId)
    const messageCounts = yield* branchStorage.countMessagesByBranches(
      branches.map((branch) => branch.id),
    )
    return buildBranchTree(branches, messageCounts)
  })
