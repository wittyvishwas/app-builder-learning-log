/*
 * Unit tests for the fake ERP test helper: State is faked (and, like the real one, rejects non-string values).
 */
const mockStore = new Map()
const mockPuts = []
jest.mock('@adobe/aio-lib-state', () => ({
  init: async () => {
    const state = require('./helpers').fakeState(mockStore)
    return {
      ...state,
      put: async (k, v, opts) => {
        if (typeof v !== 'string') throw new Error('aio-lib-state: value must be a string')
        mockPuts.push([k, v, opts])
        return state.put(k, v, opts)
      }
    }
  }
}))

const { main } = require('../actions/fake-erp')
const { sendOrder } = require('../actions/order-sync/erp')

const KEY = 'k'.repeat(16)
const realFetch = global.fetch
const realLog = console.log
beforeEach(() => { mockStore.clear(); mockPuts.length = 0; console.log = () => {} })
afterEach(() => { global.fetch = realFetch; console.log = realLog })

const call = (method, extra = {}, { key = KEY, bearer = KEY, path = '/orders' } = {}) => main({
  FAKE_ERP_API_KEY: key,
  LOG_LEVEL: 'info',
  __ow_method: method,
  __ow_path: path,
  __ow_headers: bearer === null ? {} : { authorization: `Bearer ${bearer}`, 'idempotency-key': extra.orderNumber },
  ...extra
})
const post = (extra, opts) => call('post', { orderNumber: '000000201', grandTotal: '119.9', ...extra }, opts)

test('stores a new order and answers 201', async () => {
  const res = await post()
  expect(res.statusCode).toBe(201)
  expect(res.body).toEqual({ stored: '000000201' })
  const value = mockStore.get('fake-erp.000000201')
  expect(typeof value).toBe('string')
  const parsed = JSON.parse(value)
  expect(parsed.orderNumber).toBe('000000201')
  expect(parsed.grandTotal).toBe('119.9')
  expect(typeof parsed.receivedAt).toBe('string')
  expect(mockPuts[0][2]).toEqual({ ttl: 604800, ifNotExists: true })
})

test('stored value has no key, LOG_LEVEL or __ow_ fields', async () => {
  await post()
  const value = mockStore.get('fake-erp.000000201')
  expect(value).not.toContain(KEY)
  expect(value).not.toContain('LOG_LEVEL')
  expect(value).not.toContain('FAKE_ERP_API_KEY')
  expect(value).not.toContain('__ow_')
})

test('answers 409 to the same order and keeps the first copy', async () => {
  await post({ grandTotal: '1' })
  const first = mockStore.get('fake-erp.000000201')
  const res = await post({ grandTotal: '2' })
  expect(res.statusCode).toBe(409)
  expect(res.body).toEqual({ duplicate: '000000201' })
  expect(mockStore.get('fake-erp.000000201')).toBe(first)
})

test('401 for missing or wrong bearer, nothing stored', async () => {
  expect((await post({}, { bearer: null })).statusCode).toBe(401)
  expect((await post({}, { bearer: 'x'.repeat(16) })).statusCode).toBe(401)
  expect((await post({}, { bearer: KEY.slice(0, 15) })).statusCode).toBe(401)
  const noScheme = await main({ FAKE_ERP_API_KEY: KEY, __ow_method: 'post', __ow_path: '/orders', __ow_headers: { authorization: KEY }, orderNumber: '1' })
  expect(noScheme.statusCode).toBe(401)
  expect((await call('get', { order: '000000201' }, { bearer: 'nope' })).statusCode).toBe(401)
  expect(mockStore.size).toBe(0)
})

test('401 for everything when FAKE_ERP_API_KEY is unset, empty or shorter than 16', async () => {
  for (const key of [undefined, '', 'short', 'k'.repeat(15)]) {
    // the caller even presents the same (weak) value as the bearer
    expect((await post({}, { key, bearer: key === undefined ? 'undefined' : key })).statusCode).toBe(401)
    expect((await call('get', { order: '000000201' }, { key, bearer: key || '' })).statusCode).toBe(401)
  }
  expect(mockStore.size).toBe(0)
})

test('400 for a missing orderNumber and for one with characters outside [A-Za-z0-9_.-]', async () => {
  const bad = [undefined, '', 'a/b', 'a b', 'a*b', 'x'.repeat(65), 42, { a: 1 }]
  for (const orderNumber of bad) {
    const res = await call('post', { orderNumber })
    expect(res.statusCode).toBe(400)
  }
  expect(mockStore.size).toBe(0)
  expect((await post({ orderNumber: 'A-1_b.2' })).statusCode).toBe(201)
  expect((await post({ orderNumber: 'x'.repeat(64) })).statusCode).toBe(201)
})

test('GET returns a stored order; 404 unknown; 400 bad ?order=', async () => {
  await post()
  const found = await call('get', { order: '000000201' })
  expect(found.statusCode).toBe(200)
  expect(found.body.orderNumber).toBe('000000201')
  expect(typeof found.body.receivedAt).toBe('string')
  expect((await call('get', { order: 'unknown-1' })).statusCode).toBe(404)
  expect((await call('get', { order: 'a/b' })).statusCode).toBe(400)
  expect((await call('get', {})).statusCode).toBe(400)
})

test('404 for any other path or method', async () => {
  expect((await post({}, { path: '/other' })).statusCode).toBe(404)
  expect((await post({}, { path: '' })).statusCode).toBe(404)
  expect((await call('delete', { orderNumber: '000000201' })).statusCode).toBe(404)
  expect((await call('put', { orderNumber: '000000201' })).statusCode).toBe(404)
  expect(mockStore.size).toBe(0)
})

test('round trip with erp.js', async () => {
  // Route erp.js's fetch to the action, as the web gateway would: JSON body fields become params.
  global.fetch = async (url, init) => {
    expect(url).toBe('https://erp.example.com/api/v1/web/dev/fake-erp/orders')
    const h = Object.fromEntries(Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v]))
    const res = await main({
      FAKE_ERP_API_KEY: KEY,
      LOG_LEVEL: 'info',
      ...JSON.parse(init.body),
      __ow_method: init.method.toLowerCase(),
      __ow_path: '/orders',
      __ow_headers: h
    })
    return { ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: async () => JSON.stringify(res.body) }
  }
  const opts = { url: 'https://erp.example.com/api/v1/web/dev/fake-erp', apiKey: KEY }
  const erpOrder = { orderNumber: '000000201', total: 119.9 }
  expect(await sendOrder(erpOrder, opts)).toEqual({ status: 201, duplicate: false })
  expect(await sendOrder(erpOrder, opts)).toEqual({ status: 409, duplicate: true })
  expect(mockStore.size).toBe(1)
})
