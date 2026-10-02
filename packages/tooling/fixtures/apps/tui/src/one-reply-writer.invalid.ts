// Hand-rolled reply generations: each read bumps a counter that a later
// callback compares with the number it captured.

// 6e7673446^ client.tsx: the navigation counter.
export const navigations = (send: (done: () => void) => void, show: () => void) => {
  let navigation = 0
  const create = () => {
    const ownNavigation = ++navigation
    send(() => {
      if (ownNavigation !== navigation) return
      show()
    })
  }
  const switchSession = () => {
    navigation++
  }
  return { create, switchSession }
}

// 6e7673446^ builtins.tsx: the listing generation, passed in and bumped on open.
export const listings = (fork: (run: () => void) => void, write: () => void) => {
  let opened = 0
  const fetchListing = (generation: number) =>
    fork(() => {
      if (generation === opened) write()
    })
  const open = () => {
    fetchListing(opened)
    opened += 1
  }
  return open
}

// 59517a2bc message-list.tsx: the commit epoch, here bumped by assignment.
export const commits = (queue: (run: () => boolean) => void) => {
  let commitEpoch = 0
  const rewind = () => {
    commitEpoch = commitEpoch + 1
  }
  const write = () => {
    const epoch = commitEpoch
    queue(() => commitEpoch === epoch)
  }
  return { rewind, write }
}
