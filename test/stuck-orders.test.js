/*
 * Unit tests for the Ep 3 job: Commerce, the alert webhook and State are mocked,
 * so this proves the logic (query, de-duplication, lock), not a real deployment.
 */
const mockStore = new Map()
jest.mock('@adobe/aio-lib-state', () => ({
  init: async () => ({
    get: async (k) => (mockStore.has(k) ? { value: mockStore.get(k) } : undefined),
    put: async (k, v) => { mockStore.set(k, v); return k },
    delete: async (k) => { mockStore.delete(k); return k }
  })
}))
jest.mock('@adobe/aio-sdk', () => ({
  Core: { Logger: () => ({ info: () => {}, error: () => {}, debug: () => {} }) }
}))

const { main } = require('../actions/stuck-orders')

const params = {
  COMMERCE_BASE_URL: 'https://shop.example/',
  COMMERCE_TOKEN: 'token',
  ALERT_WEBHOOK_URL: 'https://hooks.example/alert',
  STUCK_AFTER_MINUTES: 30
}
const orders = [
  { increment_id: '000000101', grand_total: 49.5, created_at: '2027-01-07 08:00:00' },
  { increment_id: '000000102', grand_total: 120, created_at: '2027-01-07 08:10:00' }
]

function mockFetch (items, status = 200) {
  global.fetch = jest.fn(async (url) => {
    if (String(url).startsWith(params.COMMERCE_BASE_URL)) {
      return { ok: status === 200, status, json: async () => ({ items }) }
    }
    return { ok: true, status: 200, json: async () => ({}) }
  })
}

beforeEach(() => mockStore.clear())

test('asks Commerce for pending_payment orders older than the cut-off, with a bearer token', async () => {
  mockFetch([])
  await main(params)
  const [url, opts] = global.fetch.mock.calls[0]
  const q = new URL(url).searchParams
  expect(url.startsWith('https://shop.example/rest/V1/orders?')).toBe(true)
  expect(q.get('searchCriteria[filter_groups][0][filters][0][value]')).toBe('pending_payment')
  expect(q.get('searchCriteria[filter_groups][1][filters][0][condition_type]')).toBe('lt')
  expect(q.get('searchCriteria[filter_groups][1][filters][0][value]')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  expect(opts.headers.Authorization).toBe('Bearer token')
})

test('alerts each stuck order once, not once per run', async () => {
  mockFetch(orders)
  const first = await main(params)
  expect(first.body.alerted).toBe(2)
  const alert = global.fetch.mock.calls.find(([u]) => u === params.ALERT_WEBHOOK_URL)
  expect(JSON.parse(alert[1].body).text).toContain('#000000101 (49.5)')

  mockFetch(orders)
  const second = await main(params)
  expect(second.body.alerted).toBe(0)
  expect(global.fetch.mock.calls.some(([u]) => u === params.ALERT_WEBHOOK_URL)).toBe(false)
})

test('skips the run while another run holds the lock, and releases it afterwards', async () => {
  mockFetch(orders)
  mockStore.set('lock-stuck-orders', String(Date.now()))
  expect(await main(params)).toEqual({ skipped: true })
  mockStore.delete('lock-stuck-orders')
  await main(params)
  expect(mockStore.has('lock-stuck-orders')).toBe(false)
})

test('returns 500 and releases the lock when Commerce fails', async () => {
  mockFetch([], 401)
  const res = await main(params)
  expect(res).toEqual({ statusCode: 500, body: { error: 'Commerce returned 401' } })
  expect(mockStore.has('lock-stuck-orders')).toBe(false)
})
