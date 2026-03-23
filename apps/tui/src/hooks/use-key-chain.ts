const DEFAULT_CHAIN_WINDOW_MS = 500

export interface KeyChainOptions {
  windowMs?: number
}

export interface KeyChain {
  readonly trigger: (id: string, actions?: { first?: () => void; second: () => void }) => void
  readonly reset: () => void
}

export function useKeyChain(options?: KeyChainOptions): KeyChain {
  const windowMs = options?.windowMs ?? DEFAULT_CHAIN_WINDOW_MS
  let armed: { id: string; at: number } | null = null

  return {
    trigger(id, actions) {
      const now = Date.now()
      const isSecond = armed?.id === id && now - armed.at < windowMs
      if (isSecond) {
        armed = null
        actions?.second()
        return
      }

      armed = { id, at: now }
      actions?.first?.()
    },

    reset() {
      armed = null
    },
  }
}
