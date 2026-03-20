/**
 * Pure segment builder for border lines.
 * Extracted from bordered-input.tsx for testability without JSX.
 */

import type { RGBA } from "@opentui/core"

export interface BorderLabelItem {
  text: string
  color: RGBA
}

export interface Segment {
  text: string
  color: RGBA
}

export function buildBorderSegments(
  width: number,
  leftItems: readonly BorderLabelItem[],
  rightItems: readonly BorderLabelItem[],
  borderColor: RGBA,
): Segment[] {
  const bc = borderColor
  const result: Segment[] = []

  // Left labels: "── label1 · label2 "
  let usedWidth = 0
  if (leftItems.length > 0) {
    result.push({ text: "── ", color: bc })
    usedWidth += 3
    for (let idx = 0; idx < leftItems.length; idx++) {
      const item = leftItems[idx]
      if (item === undefined) continue
      if (idx > 0) {
        result.push({ text: " · ", color: bc })
        usedWidth += 3
      }
      result.push({ text: item.text, color: item.color })
      usedWidth += item.text.length
    }
    result.push({ text: " ", color: bc })
    usedWidth += 1
  }

  // Right labels (build ahead to know width): " label1 · label2 ──"
  const rightSegments: Segment[] = []
  if (rightItems.length > 0) {
    rightSegments.push({ text: " ", color: bc })
    usedWidth += 1
    for (let idx = 0; idx < rightItems.length; idx++) {
      const item = rightItems[idx]
      if (item === undefined) continue
      if (idx > 0) {
        rightSegments.push({ text: " · ", color: bc })
        usedWidth += 3
      }
      rightSegments.push({ text: item.text, color: item.color })
      usedWidth += item.text.length
    }
    rightSegments.push({ text: " ──", color: bc })
    usedWidth += 3
  }

  // Fill
  const fill = Math.max(0, width - usedWidth)
  result.push({ text: "─".repeat(fill), color: bc })

  // Right labels
  result.push(...rightSegments)

  return result
}
