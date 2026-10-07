// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const mocks = vi.hoisted(() => ({ calls: [], fail: false }))
vi.mock('../lib/api.js', () => ({ api: async (url, opts) => {
  mocks.calls.push([url, opts])
  if (url === '/api/admin/users') return { users: [{ id: 'owner', name: 'Owner' }, { id: 'member', name: 'Member' }, { id: 'other', name: 'Other' }] }
  if (mocks.fail) throw new Error('The connection or access settings changed. Refresh and retry.')
  return { ok: true }
} }))
const { CredentialAccess } = await import('./AdminCoach.jsx')
let host, root, onSaved
const flush = () => act(async () => { for (let n = 0; n < 8; n++) await Promise.resolve() })
const data = { provider: 'codex', boundUid: 'owner', canManageAccess: true,
  credentialAccess: { ownerUid: 'owner', selectedOnly: false, uids: [], revision: 'version-a' } }
beforeEach(() => {
  mocks.calls = []; mocks.fail = false; onSaved = vi.fn()
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })
const render = async d => { act(() => root.render(<CredentialAccess data={d} onSaved={onSaved} />)); await flush() }
const save = async () => { await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Save access').click()); await flush() }

it('defaults to owner only and saves selected users only on explicit save', async () => {
  await render(data)
  const boxes = host.querySelectorAll('input[type="checkbox"]')
  expect(boxes[0].checked).toBe(true); expect(boxes[0].disabled).toBe(true)
  expect(boxes[1].checked).toBe(false); expect(boxes[2].checked).toBe(false)
  await act(async () => boxes[1].click())
  expect(mocks.calls.filter(([, o]) => o?.method === 'POST')).toHaveLength(0)
  await save()
  const post = mocks.calls.find(([, o]) => o?.method === 'POST')
  expect(post[0]).toBe('/api/admin/coach/access')
  expect(JSON.parse(post[1].body)).toEqual({ provider: 'codex', revision: 'version-a', uids: ['member'] })
  expect(onSaved).toHaveBeenCalledTimes(1)
})

it('reloads selected users and supports revoking a grant', async () => {
  await render({ ...data, credentialAccess: { ...data.credentialAccess, selectedOnly: true, uids: ['member'] } })
  const boxes = host.querySelectorAll('input[type="checkbox"]')
  expect(boxes[1].checked).toBe(true)
  await act(async () => boxes[1].click()); await save()
  expect(JSON.parse(mocks.calls.find(([, o]) => o?.method === 'POST')[1].body).uids).toEqual([])
})

it('shows stale-save errors and does not claim success', async () => {
  await render(data); mocks.fail = true; await save()
  expect(host.querySelector('[role="alert"]').textContent).toContain('Refresh and retry')
  expect(onSaved).not.toHaveBeenCalled()
})

it('another admin cannot edit or load the user list for a personal credential', async () => {
  await render({ ...data, canManageAccess: false })
  expect(host.textContent).toContain('Only the connected credential owner')
  expect(host.querySelector('input')).toBeNull()
  expect(mocks.calls).toHaveLength(0)
})
