// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const mocks = vi.hoisted(() => ({ status: null, patches: [], catalog: null }))
vi.mock('../lib/api.js', () => ({ api: async (url, opts) => {
  if (url === '/api/admin/coach') return structuredClone(mocks.status)
  if (url.endsWith('/models')) return structuredClone(mocks.catalog)
  if (url.endsWith('/config')) {
    const body = JSON.parse(opts.body); mocks.patches.push(body)
    mocks.status.model = body.model || null
    mocks.status.models.codex = body.model || ''
    return { ok: true }
  }
  if (url.endsWith('/disconnect')) { mocks.status.auth = { state: 'none' }; return { ok: true } }
  return { state: 'none' }
} }))
vi.mock('../store/useStore.js', () => {
  const state = { refreshConfig: vi.fn(), user: { id: 'owner' } }
  const useStore = fn => fn(state); useStore.getState = () => state
  return { useStore }
})
vi.mock('../sheets.jsx', () => ({ confirmSheet: async options => options.onConfirm() }))
vi.mock('../store/useUI.js', () => ({ useUI: fn => fn({ toast: vi.fn(), openSheet: vi.fn() }) }))
const { default: AdminCoach } = await import('./AdminCoach.jsx')
let host, root
const flush = () => act(async () => { for (let n = 0; n < 8; n++) await Promise.resolve() })
const click = async text => { await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent.includes(text)).click()); await flush() }
beforeEach(async () => {
  mocks.status = {
    enabled: true, provider: 'codex', providers: [{ id: 'codex', label: 'Codex', runtime: 'CLI', apiKey: true }],
    model: null, models: {}, caps: {}, runtime: { ok: true }, authMode: 'instance', boundUid: 'owner',
    auth: { state: 'connected', type: 'chatgpt-cli', connectedAt: 'first' }, unprivileged: { ok: true }, recent: []
  }
  mocks.catalog = { ok: true, models: ['model-a', 'model-b'], defaultModel: 'model-a' }
  mocks.patches = []
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  act(() => root.render(<AdminCoach />)); await flush()
})
afterEach(() => { act(() => root.unmount()); host.remove() })

it('shows discovered default, saves an override, and returns to runtime default', async () => {
  await click('List models')
  expect(host.textContent).toContain('Runtime default: model-a')
  let select = host.querySelector('select[aria-label="Model"]')
  expect(select.value).toBe('')
  await act(async () => { select.value = 'model-b'; select.dispatchEvent(new Event('change', { bubbles: true })) }); await flush()
  expect(mocks.patches.at(-1)).toEqual({ model: 'model-b' })
  expect(host.textContent).toContain('Selected override: model-b')
  select = host.querySelector('select[aria-label="Model"]')
  expect(select.value).toBe('model-b')
  await act(async () => { select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true })) }); await flush()
  expect(mocks.patches.at(-1)).toEqual({ model: '' })
  expect(host.textContent).toContain('Using the runtime default')
  expect(host.textContent).toContain('Runtime default: model-a')
})

it('preserves a selected model omitted from the catalog', async () => {
  mocks.status.models.codex = 'custom-model'; mocks.status.model = 'custom-model'
  // A config save reloads status; select an override, then receive a catalog without it.
  await click('List models')
  const select = host.querySelector('select[aria-label="Model"]')
  await act(async () => { select.value = 'model-b'; select.dispatchEvent(new Event('change', { bubbles: true })) }); await flush()
  mocks.catalog.models = ['model-a']
  await click('Refresh list')
  expect(host.querySelector('select[aria-label="Model"]').value).toBe('model-b')
  expect(host.textContent).toContain('model-b (not in the list)')
})

it('clears catalog and default after disconnect', async () => {
  await click('List models')
  await click('Remove')
  expect(host.textContent).not.toContain('Runtime default: model-a')
  expect(host.querySelector('select[aria-label="Model"]')).toBeNull()
})
