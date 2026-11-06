/*
 * Event handler + scheduled retry, end to end against fakes:
 * I/O Events payload in, ERP calls out, State bookkeeping checked.
 */
const mockStore = new Map()
const mockTtls = new Map()
const mockList = { pages: 1, duplicate: false, failPut: false }
jest.mock('@adobe/aio-lib-state', () => ({
  init: async () => {
    const s = require('./helpers').fakeState(mockStore, { ttls: mockTtls, pages: mockList.pages, duplicate: mockList.duplicate })
    if (mockList.failPut) s.put = async () => { throw new Error('state unavailable') }
    return s
  }
}))
jest.mock('@adobe/aio-sdk', () => ({
  Core: { Logger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) }
}))
jest.mock('../actions/order-sync/erp', () => {
  const real = jest.requireActual('../actions/order-sync/erp')
  return { ...real, sendOrder: (o, opts) => real.sendOrder(o, { ...opts, baseDelayMs: 0 }) }
})

const { main } = require('../actions/export-order')
const { main: retry } = require('../actions/export-order-retry')
const { scriptedFetch, order } = require('./helpers')

const params = { ERP_API_URL: 'https://erp.example/api', ERP_API_KEY: 'k' }
const event = { ...params, event_id: 'e1', data: { value: order } }
const keys = () => [...mockStore.keys()].sort()

beforeEach(() => { mockStore.clear(); mockTtls.clear(); Object.assign(mockList, { pages: 1, duplicate: false, failPut: false }) })

test('400 when ERP settings are missing', async () => {
  const res = await main({ data: { value: order } })
  expect(res.error.statusCode).toBe(400)
})

test('exports the order from an I/O Events payload and records it', async () => {
  global.fetch = scriptedFetch([201])
  const res = await main(event)
  expect(res).toEqual({ statusCode: 200, body: { orderNumber: '000000201', outcome: 'exported' } })
  expect(keys()).toEqual(['order-sync.done.000000201'])
})

test('a redelivered event is skipped, not sent twice', async () => {
  global.fetch = scriptedFetch([201])
  await main(event)
  global.fetch = scriptedFetch([201])
  const res = await main(event)
  expect(res.body.outcome).toBe('skipped')
  expect(global.fetch).not.toHaveBeenCalled()
})

test('an event without an order is acknowledged and ignored (no redelivery loop)', async () => {
  global.fetch = scriptedFetch([201])
  const res = await main({ ...params, data: { value: {} } })
  expect(res.statusCode).toBe(200)
  expect(res.body.outcome).toBe('ignored')
  expect(global.fetch).not.toHaveBeenCalled()
})

test('ERP down: queued for retry, then the scheduled run exports it', async () => {
  global.fetch = scriptedFetch([503])
  expect((await main(event)).body.outcome).toBe('queued')
  expect(keys()).toEqual(['order-sync.retry.000000201'])
  const queued = JSON.parse(mockStore.get('order-sync.retry.000000201'))
  expect(queued).toMatchObject({ runs: 1, status: 503, lastError: 'ERP returned 503' })
  // The retry entry holds the mapped order, complete, because it has to be resent as is.
  expect(queued.order).toMatchObject({ orderNumber: '000000201', customer: { email: 'jane@example.com' } })
  expect(mockTtls.get('order-sync.retry.000000201')).toBe(7 * 24 * 3600)

  global.fetch = scriptedFetch([201])
  const res = await retry(params)
  expect(res.body).toEqual({ exported: 1, skipped: 0, queued: 0, dead: 0, left: 0 })
  expect(keys()).toEqual(['order-sync.done.000000201'])
})

test('permanent ERP rejection goes straight to the dead-letter list', async () => {
  global.fetch = scriptedFetch([422])
  expect((await main(event)).body.outcome).toBe('dead')
  expect(keys()).toEqual(['order-sync.dead.000000201'])
})

test('after the last scheduled run a still-failing order goes to dead-letter', async () => {
  global.fetch = scriptedFetch([503])
  await main(event)
  for (let i = 0; i < 5; i++) await retry(params)
  expect(keys()).toEqual(['order-sync.dead.000000201'])
  expect(JSON.parse(mockStore.get('order-sync.dead.000000201')).runs).toBe(6)
})

test('order numbers with unusual characters make valid State keys', async () => {
  global.fetch = scriptedFetch([201])
  await main({ ...params, data: { value: { ...order, increment_id: 'WEB/2027#7' } } })
  expect(keys()).toEqual(['order-sync.done.WEB_2027_7'])
})

test('records done orders for 30 days', async () => {
  global.fetch = scriptedFetch([201])
  await main(event)
  expect(mockTtls.get('order-sync.done.000000201')).toBe(30 * 24 * 3600)
})

test('dead-letter entries keep no customer data, and no ERP response body', async () => {
  global.fetch = jest.fn(async () => ({ ok: false, status: 422, text: async () => 'invalid email jane@example.com' }))
  await main(event)
  const dead = JSON.parse(mockStore.get('order-sync.dead.000000201'))
  expect(dead).toMatchObject({ runs: 1, status: 422, lastError: 'ERP returned 422' })
  expect(JSON.stringify(dead)).not.toContain('jane')
  expect(dead.order.customer).toBeUndefined()
  expect(dead.order.billingAddress).toBeUndefined()
  expect(dead.order.lines).toHaveLength(2)
  expect(mockTtls.get('order-sync.dead.000000201')).toBe(365 * 24 * 3600)
})

test('a bare order works for a manual invocation', async () => {
  global.fetch = scriptedFetch([201])
  const res = await main({ ...params, ...order })
  expect(res.body).toEqual({ orderNumber: '000000201', outcome: 'exported' })
})

test('if State cannot record anything, the handler fails so I/O Events redelivers', async () => {
  global.fetch = scriptedFetch([201])
  mockList.failPut = true
  const res = await main(event)
  expect(res.error.statusCode).toBe(500)
})

test('the retry run tries each order once: the schedule is the backoff', async () => {
  global.fetch = scriptedFetch([503])
  await main(event)
  global.fetch = scriptedFetch([503])
  const res = await retry(params)
  expect(global.fetch).toHaveBeenCalledTimes(1)
  expect(res.body.queued).toBe(1)
  expect(JSON.parse(mockStore.get('order-sync.retry.000000201')).runs).toBe(2)
})

test('a key listed twice by the State scan is retried once', async () => {
  global.fetch = scriptedFetch([503])
  await main(event)
  mockList.pages = 2
  mockList.duplicate = true
  global.fetch = scriptedFetch([201])
  const res = await retry(params)
  expect(global.fetch).toHaveBeenCalledTimes(1)
  expect(res.body.exported).toBe(1)
})

test('a retry run is skipped while another holds the lock', async () => {
  global.fetch = scriptedFetch([503])
  await main(event)
  mockStore.set('order-sync.lock.retry', '1')
  global.fetch = scriptedFetch([201])
  expect((await retry(params)).body).toEqual({ skipped: true })
  expect(global.fetch).not.toHaveBeenCalled()
  mockStore.delete('order-sync.lock.retry')
  await retry(params)
  expect(mockStore.has('order-sync.lock.retry')).toBe(false)
})

test('the retry run stops at MAX_PER_RUN and on its time budget, and reports what is left', async () => {
  global.fetch = scriptedFetch([503])
  for (const n of ['301', '302', '303']) await main({ ...params, data: { value: { ...order, increment_id: n } } })
  global.fetch = scriptedFetch([201])
  expect((await retry({ ...params, MAX_PER_RUN: 1 })).body).toMatchObject({ exported: 1, left: 2 })

  const realNow = Date.now
  let t = realNow()
  Date.now = () => (t += 200000) // every check jumps 200 s: the budget runs out after one order
  try {
    expect((await retry(params)).body).toMatchObject({ exported: 1, left: 1 })
  } finally { Date.now = realNow }
})
