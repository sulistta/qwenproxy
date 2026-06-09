let playwrightMockEnabled = false
let mockSessionId = 'mock-session'

export function enablePlaywrightMock(options: { sessionId?: string } = {}): void {
  playwrightMockEnabled = true
  mockSessionId = options.sessionId || 'mock-session'
}

export function disablePlaywrightMock(): void {
  playwrightMockEnabled = false
  mockSessionId = 'mock-session'
}

export function isPlaywrightMockEnabled(): boolean {
  return playwrightMockEnabled
}

export function getMockSessionId(): string {
  return mockSessionId
}
