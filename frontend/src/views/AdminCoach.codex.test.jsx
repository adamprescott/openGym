// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const mocks = vi.hoisted(() => ({ state: { state: 'none' }, calls: [], api: vi.fn() }))
vi.mock('../lib/api.js', () => ({ api: (...args) => mocks.api(...args) }))
const { CodexLogin } = await import('./AdminCoach.jsx')
let host, root
const flush = () => act(async () => { for (let n = 0; n < 8; n++) await Promise.resolve() })
beforeEach(() => {
  vi.useFakeTimers(); mocks.calls = []; mocks.state = { state: 'none' }
  mocks.api.mockImplementation(async (url, opts) => {
    mocks.calls.push([url, opts?.method || 'GET'])
    if (url.endsWith('/cancel')) { mocks.state = { state: 'cancelled', ok: true }; return mocks.state }
    if (opts?.method === 'POST' && url.endsWith('/login')) {
      mocks.state = { state: 'pending', ok: true, expiresAt: Date.now() + 900000, verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGHI' }
    }
    return structuredClone(mocks.state)
  })
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers() })
const button = label => [...host.querySelectorAll('button')].find(b => b.textContent.includes(label))

it('shows device instructions, cancels, then refreshes completion without repeating notifications', async () => {
  const onDone = vi.fn()
  act(() => root.render(<CodexLogin onDone={onDone} />)); await flush()
  await act(async () => button('Sign in with ChatGPT').click()); await flush()
  expect(host.textContent).toContain('ABCD-EFGHI')
  expect(host.querySelector('a').href).toBe('https://auth.openai.com/codex/device')
  await act(async () => button('Cancel sign-in').click()); await flush()
  expect(host.textContent).not.toContain('ABCD-EFGHI')
  expect(mocks.calls).toContainEqual(['/api/admin/coach/codex/cancel', 'POST'])
  await act(async () => button('Sign in with ChatGPT').click()); await flush()
  mocks.state = { state: 'connected' }
  await act(async () => vi.advanceTimersByTimeAsync(2000)); await flush()
  expect(onDone).toHaveBeenCalledTimes(1)
  await act(async () => vi.advanceTimersByTimeAsync(2000)); await flush()
  expect(onDone).toHaveBeenCalledTimes(1)
})

it('reconnect removes the previous connection before beginning a new sign-in', async () => {
  act(() => root.render(<CodexLogin onDone={vi.fn()} reconnect />)); await flush()
  await act(async () => button('Reconnect ChatGPT subscription').click()); await flush()
  const posts = mocks.calls.filter(([, method]) => method === 'POST')
  expect(posts).toEqual([['/api/admin/coach/disconnect', 'POST'], ['/api/admin/coach/codex/login', 'POST']])
})

it('does not show a start button or code for another admin’s pending attempt', async () => {
  mocks.state = { state: 'busy' }
  act(() => root.render(<CodexLogin onDone={vi.fn()} />)); await flush()
  expect(host.textContent).toContain('Another admin has a pending sign-in')
  expect(host.querySelector('button')).toBeNull()
  expect(host.querySelector('a')).toBeNull()
})
