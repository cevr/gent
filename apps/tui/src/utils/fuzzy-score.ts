/**
 * Simple fuzzy match scoring.
 * Returns 0 if no match, higher = better match.
 */
export function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase()
  const t = target.toLowerCase()

  if (t === q) return 1000

  if (t.includes(q)) return 500 + (100 - target.length)

  let qIdx = 0
  let score = 0
  let consecutive = 0

  for (let tIdx = 0; tIdx < t.length && qIdx < q.length; tIdx++) {
    if (t[tIdx] === q[qIdx]) {
      consecutive++
      score += consecutive * 10

      if (tIdx === 0 || t[tIdx - 1] === "/" || t[tIdx - 1] === "-" || t[tIdx - 1] === "_") {
        score += 20
      }

      qIdx++
    } else {
      consecutive = 0
    }
  }

  if (qIdx < q.length) return 0

  return score + Math.max(0, 50 - target.length)
}
