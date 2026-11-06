/*
 * Unit tests for the Ep 10 retry-delivery action: aio-lib-db, State, the token call and Commerce (fetch) are faked.
 * Proves validation, the three row kinds (retry, dead, sent) and their status codes, the Commerce REST call and
 * its mapping to the ERP order, that a sent row is never touched, closing the client, and that the next
 * retry run picks the re-queued row up.
 */
let mockDb
const mockStore = new Map()
const mockLogs = { error: [] }
jest.mock('@adobe/aio-lib-db', () => ({ init: (...a) => mockDb.init(...a) }))
jest.mock('@adobe/aio-lib-state', () => ({ init: async () => require('./helpers').fakeState(mockStore) }))
jest.mock('@adobe/aio-sdk', () => ({
  Core: {
    Logger: () => ({ info: () => {}, warn: () => {}, error: m => mockLogs.error.push(m), debug: () => {} }),
    AuthClient: { generateAccessToken: async () => ({ access_token: 'tok-123' }) }
  }
}))

const { fakeDb } = require('./helpers')
const { main } = require('../src/commerce-backend-ui-1/actions/retry-delivery')
const { main: retryRun } = require('../actions/export-order-retry')

const params = { COMMERCE_BASE_URL: 'https://shop.example/', COMMERCE_TOKEN: 'ctok' }
const rows = () => mockDb.data.get('export_runs')
const row = n => rows().find(r => r.order === n)

// An order as GET /rest/V1/orders returns it: the shipping address sits under extension_attributes.
const restOrder = {
  increment_id: '000000301',
  created_at: '2027-01-14 10:00:00',
  order_currency_code: 'EUR',
  grand_total: 119.9,
  shipping_amount: 5,
  tax_amount: 19.14,
  customer_email: 'jane@example.com',
  customer_firstname: 'Jane',
  customer_lastname: 'Doe',
  billing_address: { address_type: 'billing', firstname: 'Jane', lastname: 'Doe', street: ['1 Main St'], city: 'Berlin', postcode: '10115', country_id: 'DE' },
  items: [
    { item_id: 1, sku: 'TSHIRT-M', name: 'T-shirt', qty_ordered: 2, price: 29.95, row_total: 59.9 },
    { item_id: 2, parent_item_id: 1, sku: 'TSHIRT-M', name: 'T-shirt', qty_ordered: 2, price: 0 }
  ],
  extension_attributes: {
    shipping_assignments: [{ shipping: { address: { address_type: 'shipping', firstname: 'Jan', lastname: 'Doe', street: ['9 Side St', 'Flat 3'], city: 'Hamburg', postcode: '20095', region: 'HH', country_id: 'DE' } } }]
  }
}
const commerce = (status, body = { items: [restOrder] }) => {
  global.fetch = jest.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }))
}
const dead = (extra = {}) => ({ order: '000000301', status: 'dead', at: '2027-01-01T00:00:00.000Z', attempts: 6, lastError: 'ERP returned 422', httpStatus: 422, lines: [{ sku: 'TSHIRT-M' }], totals: { total: 119.9 }, ...extra })

beforeEach(() => {
  mockDb = fakeDb(new Map([['export_runs', []]]))
  mockStore.clear()
  mockLogs.error = []
  global.fetch = jest.fn(async () => { throw new Error('unexpected fetch') })
})

test.each([undefined, '', '   ', 301, null, { $ne: '' }])('rejects a missing or non-string order (%p) with 400 and no database call', async order => {
  const res = await main({ ...params, order })
  expect(res).toEqual({ statusCode: 400, body: { error: 'order is required' } })
  expect(mockDb.calls.init).toHaveLength(0)
})

test('a retry row: nextAt becomes now, the stored order stays, Commerce is not called', async () => {
  rows().push({ order: '000000301', status: 'retry', at: '2027-01-01T00:00:00.000Z', attempts: 3, nextAt: '2027-01-01T00:00:00.000Z', mapped: { orderNumber: '000000301' } })
  const before = Date.now()
  const res = await main({ ...params, order: '000000301' })
  expect(res).toEqual({ statusCode: 200, body: { order: '000000301', status: 'retry' } })
  expect(Date.parse(row('000000301').nextAt)).toBeGreaterThanOrEqual(before)
  expect(row('000000301')).toMatchObject({ status: 'retry', attempts: 3, mapped: { orderNumber: '000000301' } })
  expect(global.fetch).not.toHaveBeenCalled()
  expect(mockDb.calls.close).toBe(1)
})

test('a dead row: the order is fetched from Commerce, mapped, and the row goes back to retry with attempts 0', async () => {
  rows().push(dead())
  commerce(200)
  const before = Date.now()
  const res = await main({ ...params, order: '000000301' })
  expect(res).toEqual({ statusCode: 200, body: { order: '000000301', status: 'retry' } })

  const [url, opts] = global.fetch.mock.calls[0]
  expect(url.startsWith('https://shop.example/rest/V1/orders?')).toBe(true) // trailing slash tolerated
  const q = new URL(url).searchParams
  expect(q.get('searchCriteria[filter_groups][0][filters][0][field]')).toBe('increment_id')
  expect(q.get('searchCriteria[filter_groups][0][filters][0][value]')).toBe('000000301')
  expect(q.get('searchCriteria[filter_groups][0][filters][0][condition_type]')).toBe('eq')
  expect(opts.headers.Authorization).toBe('Bearer ctok')

  expect(rows()).toHaveLength(1)
  expect(row('000000301')).toMatchObject({ status: 'retry', attempts: 0, lastError: null, lines: null, totals: null })
  expect(Date.parse(row('000000301').nextAt)).toBeGreaterThanOrEqual(before)
  expect(row('000000301').mapped).toMatchObject({
    orderNumber: '000000301',
    currency: 'EUR',
    total: 119.9,
    customer: { email: 'jane@example.com', name: 'Jane Doe' },
    billingAddress: { city: 'Berlin' },
    // The REST shape needs no adapter: the mapper reads the shipping address from extension_attributes.
    shippingAddress: { name: 'Jan Doe', street: '9 Side St\nFlat 3', city: 'Hamburg', region: 'HH', country: 'DE' },
    lines: [{ sku: 'TSHIRT-M', qty: 2, unitPrice: 29.95, rowTotal: 59.9 }]
  })
  expect(row('000000301').mapped.lines).toHaveLength(1)
  expect(mockDb.calls.close).toBe(1)
})

test('the base URL works without a trailing slash', async () => {
  rows().push(dead())
  commerce(200)
  await main({ ...params, COMMERCE_BASE_URL: 'https://shop.example', order: '000000301' })
  expect(global.fetch.mock.calls[0][0].startsWith('https://shop.example/rest/V1/orders?')).toBe(true)
})

test('the re-queued row is picked up by the next retry run and sent', async () => {
  rows().push(dead())
  commerce(200)
  await main({ ...params, order: '000000301' })
  global.fetch = jest.fn(async () => ({ ok: true, status: 201, text: async () => 'ok' }))
  const res = await retryRun({ ERP_API_URL: 'https://erp.example/api', ERP_API_KEY: 'k' })
  expect(res.body).toMatchObject({ exported: 1, dead: 0, queued: 0 })
  const [url, opts] = global.fetch.mock.calls[0]
  expect(url).toBe('https://erp.example/api/orders')
  expect(JSON.parse(opts.body)).toMatchObject({ orderNumber: '000000301', customer: { email: 'jane@example.com' } })
  expect(rows()).toHaveLength(1)
  expect(row('000000301')).toMatchObject({ status: 'sent', mapped: null, nextAt: null })
})

test('a retry row set to now is also picked up by the next retry run', async () => {
  rows().push({ order: '000000301', status: 'retry', at: '2027-01-01T00:00:00.000Z', attempts: 2, nextAt: '2999-01-01T00:00:00.000Z', mapped: { orderNumber: '000000301', customer: {}, lines: [] } })
  await main({ ...params, order: '000000301' })
  global.fetch = jest.fn(async () => ({ ok: true, status: 201, text: async () => 'ok' }))
  const res = await retryRun({ ERP_API_URL: 'https://erp.example/api', ERP_API_KEY: 'k' })
  expect(res.body).toMatchObject({ exported: 1 })
})

test('a dead row whose order is not in Commerce answers 404 and is left as it was', async () => {
  rows().push(dead())
  commerce(200, { items: [] })
  expect(await main({ ...params, order: '000000301' })).toEqual({ statusCode: 404, body: { error: 'order not found in Commerce' } })
  expect(row('000000301')).toEqual(dead())
  expect(mockDb.calls.close).toBe(1)
})

test('a Commerce answer for another order is not used', async () => {
  rows().push(dead())
  commerce(200, { items: [{ ...restOrder, increment_id: '000000999' }] })
  expect((await main({ ...params, order: '000000301' })).statusCode).toBe(404)
  expect(row('000000301').status).toBe('dead')
})

test.each([500, 503, 401])('Commerce answering %i gives 502 "commerce error", the row stays dead and the log has the message only', async status => {
  rows().push(dead())
  commerce(status)
  expect(await main({ ...params, order: '000000301' })).toEqual({ statusCode: 502, body: { error: 'commerce error' } })
  expect(row('000000301')).toEqual(dead())
  expect(mockLogs.error).toEqual([`Commerce returned ${status}`])
  expect(mockDb.calls.close).toBe(1)
})

test('Commerce unreachable gives 502 too', async () => {
  rows().push(dead())
  global.fetch = jest.fn(async () => { throw new Error('ECONNRESET') })
  expect((await main({ ...params, order: '000000301' })).statusCode).toBe(502)
  expect(row('000000301').status).toBe('dead')
})

test('a sent row answers 409 and is never touched, also next to a stray dead row', async () => {
  rows().push({ order: '000000301', status: 'sent', at: '2027-01-01T00:00:00.000Z' }, dead())
  const res = await main({ ...params, order: '000000301' })
  expect(res).toEqual({ statusCode: 409, body: { error: 'already sent' } })
  expect(rows()).toEqual([{ order: '000000301', status: 'sent', at: '2027-01-01T00:00:00.000Z' }, dead()])
  expect(global.fetch).not.toHaveBeenCalled()
  expect(mockDb.calls.close).toBe(1)
})

test('an order with no row answers 404 and creates nothing', async () => {
  expect(await main({ ...params, order: '999' })).toEqual({ statusCode: 404, body: { error: 'no such delivery' } })
  expect(rows()).toHaveLength(0)
  expect(mockDb.calls.close).toBe(1)
})

test('a row that became sent while Commerce was asked is not overwritten (409)', async () => {
  rows().push(dead())
  global.fetch = jest.fn(async () => {
    rows()[0].status = 'sent' // the retry run delivered it meanwhile
    return { ok: true, status: 200, json: async () => ({ items: [restOrder] }) }
  })
  expect((await main({ ...params, order: '000000301' })).statusCode).toBe(409)
  expect(row('000000301')).toMatchObject({ status: 'sent' })
  expect(row('000000301').mapped).toBeUndefined()
})

test('a database error answers 500, is logged by message, and still closes the client', async () => {
  mockDb = fakeDb(new Map(), { failOn: ['findOne'] })
  const res = await main({ ...params, order: '000000301' })
  expect(res).toEqual({ statusCode: 500, body: { error: 'database error' } })
  expect(mockLogs.error).toEqual(['fakeDb: findOne failed'])
  expect(mockDb.calls.close).toBe(1)
})

test('a failed connect answers 500 and has nothing to close', async () => {
  mockDb = fakeDb(new Map(), { failOn: ['connect'] })
  expect((await main({ ...params, order: '000000301' })).statusCode).toBe(500)
  expect(mockDb.calls.close).toBe(0)
})
