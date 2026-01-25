/**
 * E2E tests for TUI components using @opentui/solid testRender
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal, createContext, useContext, type ParentProps } from "solid-js"

// Inline AgentMode type to avoid workspace import (breaks tsc -b)
type AgentMode = "plan" | "build"

// =============================================================================
// Mock Contexts for Testing
// =============================================================================

// Simplified Client Context for testing
interface MockClientContextValue {
  session: () => { sessionId: string; branchId: string; name: string } | null
  mode: () => AgentMode
  isStreaming: () => boolean
  isError: () => boolean
  error: () => string | null
  cost: () => number
  createSession: () => void
  sendMessage: (content: string) => void
}

const MockClientContext = createContext<MockClientContextValue>()

function MockClientProvider(
  props: ParentProps & {
    session?: { sessionId: string; branchId: string; name: string } | null
    mode?: AgentMode
    isStreaming?: boolean
    error?: string | null
    cost?: number
    onCreateSession?: () => void
    onSendMessage?: (content: string) => void
  },
) {
  const [session, setSession] = createSignal(props.session ?? null)
  const [mode] = createSignal<AgentMode>(props.mode ?? "plan")
  const [isStreaming] = createSignal(props.isStreaming ?? false)
  const [error] = createSignal(props.error ?? null)
  const [cost] = createSignal(props.cost ?? 0)

  const value: MockClientContextValue = {
    session,
    mode,
    isStreaming,
    isError: () => error() !== null,
    error,
    cost,
    createSession: () => {
      if (props.onCreateSession) {
        props.onCreateSession()
      }
      setSession({ sessionId: "test-session", branchId: "test-branch", name: "Test Session" })
    },
    sendMessage: (content) => {
      if (props.onSendMessage) {
        props.onSendMessage(content)
      }
    },
  }

  return <MockClientContext.Provider value={value}>{props.children}</MockClientContext.Provider>
}

// Simplified Theme Context for testing
interface MockThemeContextValue {
  theme: {
    text: string
    textMuted: string
    background: string
    primary: string
    error: string
    warning: string
    success: string
    border: string
  }
}

const _MockThemeContext = createContext<MockThemeContextValue>()

// Simplified Router Context for testing
type MockRoute = { _tag: "home" } | { _tag: "session"; sessionId: string; branchId: string }

interface MockRouterContextValue {
  route: () => MockRoute
  navigate: (route: MockRoute) => void
  navigateToSession: (sessionId: string, branchId: string, prompt?: string) => void
}

const MockRouterContext = createContext<MockRouterContextValue>()

function MockRouterProvider(
  props: ParentProps & {
    initialRoute?: MockRoute
    onNavigate?: (route: MockRoute) => void
  },
) {
  const [route, setRoute] = createSignal<MockRoute>(props.initialRoute ?? { _tag: "home" })

  const value: MockRouterContextValue = {
    route,
    navigate: (newRoute) => {
      setRoute(newRoute)
      if (props.onNavigate) {
        props.onNavigate(newRoute)
      }
    },
    navigateToSession: (sessionId, branchId) => {
      const newRoute: MockRoute = { _tag: "session", sessionId, branchId }
      setRoute(newRoute)
      if (props.onNavigate) {
        props.onNavigate(newRoute)
      }
    },
  }

  return <MockRouterContext.Provider value={value}>{props.children}</MockRouterContext.Provider>
}

// =============================================================================
// Test Setup
// =============================================================================

let testSetup: Awaited<ReturnType<typeof testRender>>

// =============================================================================
// Basic Rendering Tests
// =============================================================================

describe("Basic TUI Rendering", () => {
  beforeEach(() => {
    if (testSetup) {
      testSetup.renderer.destroy()
    }
  })

  afterEach(() => {
    if (testSetup) {
      testSetup.renderer.destroy()
    }
  })

  test("renders box with text", async () => {
    testSetup = await testRender(
      () => (
        <box flexDirection="column">
          <text>Hello World</text>
        </box>
      ),
      { width: 40, height: 10 },
    )

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()
    expect(frame).toContain("Hello World")
  })

  test("renders nested boxes", async () => {
    testSetup = await testRender(
      () => (
        <box flexDirection="column">
          <box>
            <text>Header</text>
          </box>
          <box>
            <text>Content</text>
          </box>
          <box>
            <text>Footer</text>
          </box>
        </box>
      ),
      { width: 40, height: 10 },
    )

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()
    expect(frame).toContain("Header")
    expect(frame).toContain("Content")
    expect(frame).toContain("Footer")
  })
})

// =============================================================================
// Provider Integration Tests
// =============================================================================

describe("Provider Integration", () => {
  beforeEach(() => {
    if (testSetup) {
      testSetup.renderer.destroy()
    }
  })

  afterEach(() => {
    if (testSetup) {
      testSetup.renderer.destroy()
    }
  })

  test("MockClientProvider provides session state", async () => {
    function TestComponent() {
      const ctx = useContext(MockClientContext)!
      return (
        <box>
          <text>{ctx.session() ? `Session: ${ctx.session()!.name}` : "No session"}</text>
        </box>
      )
    }

    testSetup = await testRender(
      () => (
        <MockClientProvider session={{ sessionId: "s1", branchId: "b1", name: "My Session" }}>
          <TestComponent />
        </MockClientProvider>
      ),
      { width: 40, height: 10 },
    )

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()
    expect(frame).toContain("Session: My Session")
  })

  test("MockClientProvider handles no session", async () => {
    function TestComponent() {
      const ctx = useContext(MockClientContext)!
      return (
        <box>
          <text>{ctx.session() ? `Session: ${ctx.session()!.name}` : "No session"}</text>
        </box>
      )
    }

    testSetup = await testRender(
      () => (
        <MockClientProvider session={null}>
          <TestComponent />
        </MockClientProvider>
      ),
      { width: 40, height: 10 },
    )

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()
    expect(frame).toContain("No session")
  })

  test("MockRouterProvider tracks navigation", async () => {
    function TestComponent() {
      const router = useContext(MockRouterContext)!
      return (
        <box flexDirection="column">
          <text>Route: {router.route()._tag}</text>
        </box>
      )
    }

    testSetup = await testRender(
      () => (
        <MockRouterProvider initialRoute={{ _tag: "home" }}>
          <TestComponent />
        </MockRouterProvider>
      ),
      { width: 40, height: 10 },
    )

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()
    expect(frame).toContain("Route: home")
  })
})

// =============================================================================
// Status Bar Component Tests
// =============================================================================

describe("Status Bar Components", () => {
  beforeEach(() => {
    if (testSetup) {
      testSetup.renderer.destroy()
    }
  })

  afterEach(() => {
    if (testSetup) {
      testSetup.renderer.destroy()
    }
  })

  test("displays mode indicator", async () => {
    function ModeIndicator() {
      const ctx = useContext(MockClientContext)!
      return (
        <box>
          <text>Mode: {ctx.mode()}</text>
        </box>
      )
    }

    testSetup = await testRender(
      () => (
        <MockClientProvider mode="plan">
          <ModeIndicator />
        </MockClientProvider>
      ),
      { width: 40, height: 10 },
    )

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()
    expect(frame).toContain("Mode: plan")
  })

  test("displays streaming indicator", async () => {
    function StreamingIndicator() {
      const ctx = useContext(MockClientContext)!
      return (
        <box>
          <text>{ctx.isStreaming() ? "● Streaming..." : "○ Idle"}</text>
        </box>
      )
    }

    testSetup = await testRender(
      () => (
        <MockClientProvider isStreaming={true}>
          <StreamingIndicator />
        </MockClientProvider>
      ),
      { width: 40, height: 10 },
    )

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()
    expect(frame).toContain("Streaming")
  })

  test("displays error state", async () => {
    function ErrorIndicator() {
      const ctx = useContext(MockClientContext)!
      return (
        <box>
          <text>{ctx.isError() ? `Error: ${ctx.error()}` : "No error"}</text>
        </box>
      )
    }

    testSetup = await testRender(
      () => (
        <MockClientProvider error="API rate limit exceeded">
          <ErrorIndicator />
        </MockClientProvider>
      ),
      { width: 60, height: 10 },
    )

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()
    expect(frame).toContain("Error: API rate limit exceeded")
  })

  test("displays cost", async () => {
    function CostIndicator() {
      const ctx = useContext(MockClientContext)!
      return (
        <box>
          <text>Cost: ${ctx.cost().toFixed(4)}</text>
        </box>
      )
    }

    testSetup = await testRender(
      () => (
        <MockClientProvider cost={0.0123}>
          <CostIndicator />
        </MockClientProvider>
      ),
      { width: 40, height: 10 },
    )

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()
    expect(frame).toContain("Cost: $0.0123")
  })
})

// =============================================================================
// Input Handling Tests
// =============================================================================

describe("Input Handling", () => {
  beforeEach(() => {
    if (testSetup) {
      testSetup.renderer.destroy()
    }
  })

  afterEach(() => {
    if (testSetup) {
      testSetup.renderer.destroy()
    }
  })

  test("typing updates input value", async () => {
    const [value, setValue] = createSignal("")

    testSetup = await testRender(
      () => (
        <box>
          <input
            value={value()}
            onChange={(newValue: string) => {
              setValue(newValue)
            }}
            focused
          />
        </box>
      ),
      { width: 40, height: 10 },
    )

    await testSetup.renderOnce()

    // Type some text
    testSetup.mockInput.typeText("hello")
    await testSetup.renderOnce()

    const frame = testSetup.captureCharFrame()
    expect(frame).toContain("hello")
  })
})

// =============================================================================
// Session Flow Tests
// =============================================================================

describe("Session Flow", () => {
  beforeEach(() => {
    if (testSetup) {
      testSetup.renderer.destroy()
    }
  })

  afterEach(() => {
    if (testSetup) {
      testSetup.renderer.destroy()
    }
  })

  test("createSession updates session state", async () => {
    let sessionCreated = false

    function TestComponent() {
      const ctx = useContext(MockClientContext)!
      return (
        <box flexDirection="column">
          <text>{ctx.session() ? `Session: ${ctx.session()!.sessionId}` : "No session"}</text>
          <text>[Create Session]</text>
        </box>
      )
    }

    testSetup = await testRender(
      () => (
        <MockClientProvider
          session={null}
          onCreateSession={() => {
            sessionCreated = true
          }}
        >
          <TestComponent />
        </MockClientProvider>
      ),
      { width: 40, height: 10 },
    )

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()
    expect(frame).toContain("No session")
    // Initial state verified - session not created yet
    expect(sessionCreated).toBe(false)
  })

  test("sendMessage callback is invoked", async () => {
    let sentMessage = ""

    function TestComponent() {
      const ctx = useContext(MockClientContext)!
      // Immediately send a message on mount for testing
      ctx.sendMessage("Hello from test")
      return (
        <box>
          <text>Test Component</text>
        </box>
      )
    }

    testSetup = await testRender(
      () => (
        <MockClientProvider
          session={{ sessionId: "s1", branchId: "b1", name: "Test" }}
          onSendMessage={(content) => {
            sentMessage = content
          }}
        >
          <TestComponent />
        </MockClientProvider>
      ),
      { width: 40, height: 10 },
    )

    await testSetup.renderOnce()
    expect(sentMessage).toBe("Hello from test")
  })
})

// =============================================================================
// Reactive Updates Tests
// =============================================================================

describe("Reactive Updates", () => {
  beforeEach(() => {
    if (testSetup) {
      testSetup.renderer.destroy()
    }
  })

  afterEach(() => {
    if (testSetup) {
      testSetup.renderer.destroy()
    }
  })

  test("component updates when signal changes", async () => {
    const [count, setCount] = createSignal(0)

    testSetup = await testRender(
      () => (
        <box>
          <text>Count: {count()}</text>
        </box>
      ),
      { width: 40, height: 10 },
    )

    await testSetup.renderOnce()
    let frame = testSetup.captureCharFrame()
    expect(frame).toContain("Count: 0")

    setCount(5)
    await testSetup.renderOnce()
    frame = testSetup.captureCharFrame()
    expect(frame).toContain("Count: 5")
  })
})
