// Counters that are not a reply generation, and the one writer.

declare const repliesInView: (key: () => string) => {
  take: () => { live: () => boolean }
}

// The one writer.
export const navigations = (send: (done: () => void) => void, show: () => void) => {
  const views = repliesInView(() => "navigation")
  return () => {
    const navigation = views.take()
    send(() => {
      if (navigation.live()) show()
    })
  }
}

// A loop counter compared where it is declared.
export const third = (items: ReadonlyArray<string>) => {
  let index = 0
  for (const item of items) {
    index++
    if (index === 3) return item
  }
  return undefined
}

// A `let` compared later but never incremented.
export const latest = (run: (check: () => boolean) => void, next: string) => {
  let current = next
  run(() => current === next)
  current = "done"
}

// A counter incremented and read later, but never compared.
export const tally = (each: (run: () => void) => void) => {
  let count = 0
  each(() => {
    count++
  })
  return () => count
}

// A `const` compared later.
export const fixed = (run: (check: (value: number) => boolean) => void) => {
  const limit = 3
  run((value) => value === limit)
}
