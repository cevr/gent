import type { BranchId } from "../domain/ids.js"
import type { Branch, Message, Session } from "../domain/message.js"
import { BranchInfo, MessageInfo, SessionInfo } from "./transport-contract.js"
import type { BranchTreeNode, MessageInfoReadonly } from "./transport-contract.js"

type MutableBranchTreeNode = Omit<BranchTreeNode, "children"> & {
  children: MutableBranchTreeNode[]
}

export const sessionToInfo = (session: Session, branchIdFallback?: BranchId): SessionInfo =>
  new SessionInfo({
    id: session.id,
    name: session.name,
    cwd: session.cwd,
    reasoningLevel: session.reasoningLevel,
    branchId: session.activeBranchId ?? branchIdFallback,
    parentSessionId: session.parentSessionId,
    parentBranchId: session.parentBranchId,
    createdAt: session.createdAt.getTime(),
    updatedAt: session.updatedAt.getTime(),
  })

export const branchToInfo = (branch: Branch): BranchInfo =>
  new BranchInfo({
    id: branch.id,
    sessionId: branch.sessionId,
    parentBranchId: branch.parentBranchId,
    parentMessageId: branch.parentMessageId,
    name: branch.name,
    summary: branch.summary,
    createdAt: branch.createdAt.getTime(),
  })

export const messageToInfo = (message: Message): MessageInfoReadonly => {
  const fields = {
    id: message.id,
    sessionId: message.sessionId,
    branchId: message.branchId,
    role: message.role,
    parts: message.parts,
    createdAt: message.createdAt.getTime(),
    turnDurationMs: message.turnDurationMs,
    metadata: message.metadata,
  }
  return message._tag === "interjection"
    ? new MessageInfo.interjection({ ...fields, role: "user" })
    : new MessageInfo.regular(fields)
}

export const buildBranchTree = (
  branches: ReadonlyArray<Branch>,
  messageCounts: ReadonlyMap<BranchId, number>,
): BranchTreeNode[] => {
  const nodes = new Map<BranchId, MutableBranchTreeNode>()

  for (const branch of branches) {
    nodes.set(branch.id, {
      id: branch.id,
      name: branch.name,
      summary: branch.summary,
      parentMessageId: branch.parentMessageId,
      messageCount: messageCounts.get(branch.id) ?? 0,
      createdAt: branch.createdAt.getTime(),
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
    list.sort((a, b) => a.createdAt - b.createdAt)
    for (const node of list) {
      if (node.children.length > 0) sortNodes(node.children)
    }
  }

  sortNodes(roots)
  return roots
}
