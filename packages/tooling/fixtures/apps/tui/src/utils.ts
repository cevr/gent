// The owner of the reply generation: `repliesInView` in apps/tui/src/utils.ts.

export const repliesInView = <K>(
  key: () => K,
  same: (left: K, right: K) => boolean = (left, right) => left === right,
) => {
  let newest = 0
  const writer = (read: number, captured: K) => ({
    live: () => read === newest && same(key(), captured),
  })
  return {
    take: () => writer(++newest, key()),
    newest: () => writer(newest, key()),
  }
}
