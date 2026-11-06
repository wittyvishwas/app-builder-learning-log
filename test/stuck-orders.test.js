/*
 * Unit tests for the Ep 3 job: Commerce, the alert webhook, State and Files are faked,
 * so this proves the logic (query, alert-then-remember, lock, report), not a real deployment.
 */
const mockStore = new Map()
const mockTtls = new Map()
jest.mock('@adobe/aio-lib-state', () => ({
  init: async () => require('./helpers').fakeState(mockStore, { ttls: mockTtls })
}))
const mockFiles = new Map()
const mockFilesFail = { on: false }
jest.mock('@adobe/aio-lib-files', () => ({
  init: async () => ({
    list: async (p) => (mockFiles.has(p) ? [{ name: p }] : []),
    read: async (p) => Buffer.from(mockFiles.get(p)),
    write: async (p, c) => {
      if (mockFilesFail.on) throw new Error('files unavailable')
      mockFiles.set(p, String(c))
      return String(c).length
    }
  })
}))
jest.mock('@adobe/aio-sdk', () => ({
  Core: { Logger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) }
}))

const { main, toCsv } = require('../actions/stuck-orders')

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

// Commerce answers with `items`; the webhook answers with webhookStatus.
function mockFetch (items, { status = 200, webhookStatus = 200 } = {}) {
  global.fetch = jest.fn(async (url) => {
    if (String(url).includes('/rest/V1/orders')) {
      return { ok: status === 200, status, json: async () => ({ items }) }
    }
    return { ok: webhookStatus < 300, status: webhookStatus, json: async () => ({}) }
  })
}
const alertCalls = () => global.fetch.mock.calls.filter(([u]) => u === params.ALERT_WEBHOOK_URL)
const stuckKeys = () => [...mockStore.keys()].filter(k => k.startsWith('stuck-')).sort()

beforeEach(() => { mockStore.clear(); mockTtls.clear(); mockFiles.clear(); mockFilesFail.on = false })

test('asks Commerce for pending_payment orders older than the cut-off, oldest first, with a bearer token', async () => {
  mockFetch([])
  await main(params)
  const [url, opts] = global.fetch.mock.calls[0]
  const q = new URL(url).searchParams
  expect(url.startsWith('https://shop.example/rest/V1/orders?')).toBe(true)
  expect(q.get('searchCriteria[filter_groups][0][filters][0][value]')).toBe('pending_payment')
  expect(q.get('searchCriteria[filter_groups][1][filters][0][condition_type]')).toBe('lt')
  expect(q.get('searchCriteria[filter_groups][1][filters][0][value]')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  expect(q.get('searchCriteria[sortOrders][0][field]')).toBe('created_at')
  expect(q.get('searchCriteria[sortOrders][0][direction]')).toBe('ASC')
  expect(opts.headers.Authorization).toBe('Bearer token')
})

test('works with or without a trailing slash on COMMERCE_BASE_URL', async () => {
  mockFetch([])
  await main({ ...params, COMMERCE_BASE_URL: 'https://shop.example' })
  expect(global.fetch.mock.calls[0][0].startsWith('https://shop.example/rest/V1/orders?')).toBe(true)
})

test('alerts each stuck order once, not once per run, and remembers it for 7 days', async () => {
  mockFetch(orders)
  const first = await main(params)
  expect(first.body.alerted).toBe(2)
  expect(JSON.parse(alertCalls()[0][1].body).text).toContain('#000000101 (49.5)')
  expect(mockTtls.get('stuck-000000101')).toBe(7 * 24 * 3600)

  mockFetch(orders)
  const second = await main(params)
  expect(second.body.alerted).toBe(0)
  expect(alertCalls()).toHaveLength(0)
})

test('a failing webhook remembers nothing, so the next run alerts again', async () => {
  mockFetch(orders, { webhookStatus: 500 })
  const res = await main(params)
  expect(res).toEqual({ statusCode: 500, body: { error: 'alert webhook returned 500' } })
  expect(stuckKeys()).toEqual([])

  mockFetch(orders)
  expect((await main(params)).body.alerted).toBe(2)
})

test('with more than one page of stuck orders, later runs reach the rest', async () => {
  const many = Array.from({ length: 51 }, (_, i) => ({ increment_id: String(1000 + i), grand_total: 1, created_at: '2027-01-07 08:00:00' }))
  mockFetch(many.slice(0, 50))
  expect((await main(params)).body.alerted).toBe(50)
  // Commerce returns the oldest 50 again plus the 51st; only the 51st is new.
  mockFetch(many.slice(1, 51))
  expect((await main(params)).body.alerted).toBe(1)
})

test('order numbers with unusual characters make valid State keys', async () => {
  mockFetch([{ increment_id: 'WEB/2027#7', grand_total: 1, created_at: 'x' }])
  await main(params)
  expect(stuckKeys()).toEqual(['stuck-WEB_2027_7'])
})

test('skips the run while another run holds the lock, and releases it afterwards', async () => {
  mockFetch(orders)
  mockStore.set('lock-stuck-orders', String(Date.now()))
  expect(await main(params)).toEqual({ skipped: true })
  expect(global.fetch).not.toHaveBeenCalled()
  mockStore.delete('lock-stuck-orders')
  await main(params)
  expect(mockStore.has('lock-stuck-orders')).toBe(false)
})

test('returns 500 and releases the lock when Commerce fails', async () => {
  mockFetch([], { status: 401 })
  const res = await main(params)
  expect(res).toEqual({ statusCode: 500, body: { error: 'Commerce returned 401' } })
  expect(mockStore.has('lock-stuck-orders')).toBe(false)
})

const today = () => `reports/stuck-orders/${new Date().toISOString().slice(0, 10)}.csv`

test('writes no report unless SAVE_REPORT is true', async () => {
  mockFetch(orders)
  await main(params)
  expect(mockFiles.size).toBe(0)
})

test('keeps one CSV per day in Files, newest rows first, header once', async () => {
  mockFetch(orders.slice(0, 1))
  await main({ ...params, SAVE_REPORT: 'true' })
  mockFetch(orders)
  await main({ ...params, SAVE_REPORT: true })
  expect(mockFiles.get(today())).toBe(
    'increment_id,grand_total,created_at\n' +
    '"000000102","120","2027-01-07 08:10:00"\n' +
    '"000000101","49.5","2027-01-07 08:00:00"\n'
  )
})

test('a Files failure is logged and does not block or repeat the alert', async () => {
  mockFilesFail.on = true
  mockFetch(orders)
  const res = await main({ ...params, SAVE_REPORT: 'true' })
  expect(res).toEqual({ statusCode: 200, body: { alerted: 2 } })
  expect(alertCalls()).toHaveLength(1)
})

test('CSV cells are quoted and embedded quotes doubled', () => {
  expect(toCsv([{ increment_id: 'A"1', grand_total: 5, created_at: 'x' }]))
    .toBe('increment_id,grand_total,created_at\n"A""1","5","x"\n')
})
