/*
 * Unit tests for the Ep 6 order-placed action: aio-lib-db, the token call and the ERP (fetch) are faked.
 * This proves the logic (idempotency through export_runs, status codes, close in finally), not a real delivery.
 */
let mockDb
jest.mock('@adobe/aio-lib-db', () => ({ init: (...a) => mockDb.init(...a) }))
const mockAuth = jest.fn(async () => ({ access_token: 'tok-123' }))
jest.mock('@adobe/aio-sdk', () => ({
  Core: {
    Logger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
    AuthClient: { generateAccessToken: (...a) => mockAuth(...a) }
  }
}))

const { fakeDb, scriptedFetch } = require('./helpers')
const { main } = require('../actions/order-placed')

const base = { ERP_API_URL: 'https://erp.example.com/', ERP_API_KEY: 'key-1' }
const event = { data: { value: { increment_id: '000000201', grand_total: '119.9' } } }
const realFetch = global.fetch

beforeEach(() => {
  mockAuth.mockClear()
  mockAuth.mockImplementation(async () => ({ access_token: 'tok-123' }))
  global.fetch = scriptedFetch([200])
})
afterAll(() => { global.fetch = realFetch })

test('first delivery sends the order and writes the sent row', async () => {
  mockDb = fakeDb()
  const res = await main({ ...base, ...event })
  expect(res).toEqual({ statusCode: 200, body: { sent: '000000201' } })
  expect(global.fetch).toHaveBeenCalledTimes(1)
  const [url, init] = global.fetch.mock.calls[0]
  expect(url).toBe('https://erp.example.com/orders')
  expect(init.headers['Idempotency-Key']).toBe('000000201')
  expect(init.headers.Authorization).toBe('Bearer key-1')
  expect(JSON.parse(init.body)).toMatchObject({ increment_id: '000000201', grand_total: '119.9' })
  const rows = mockDb.data.get('export_runs')
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ order: '000000201', status: 'sent' })
  expect(new Date(rows[0].at).toISOString()).toBe(rows[0].at)
  expect(mockDb.calls.init).toEqual([{ token: 'tok-123', region: 'emea' }])
  expect(mockDb.calls.close).toBe(1)
})

test('a redelivery is skipped without calling the ERP', async () => {
  mockDb = fakeDb()
  await main({ ...base, ...event })
  global.fetch.mockClear()
  const res = await main({ ...base, ...event })
  expect(res).toEqual({ statusCode: 200, body: { skipped: true } })
  expect(global.fetch).not.toHaveBeenCalled()
  expect(mockDb.data.get('export_runs')).toHaveLength(1)
  expect(mockDb.calls.close).toBe(2)
})

test('only a sent row counts: a retry or dead row for the order does not skip it', async () => {
  mockDb = fakeDb(new Map([['export_runs', [
    { order: '000000201', status: 'dead', at: '2027-01-01T00:00:00.000Z' },
    { order: '000000999', status: 'sent', at: '2027-01-01T00:00:00.000Z' }
  ]]]))
  const res = await main({ ...base, ...event })
  expect(res.body).toEqual({ sent: '000000201' })
  expect(global.fetch).toHaveBeenCalledTimes(1)
})

test('params.data without .value works', async () => {
  mockDb = fakeDb()
  const res = await main({ ...base, data: { increment_id: '000000202', grand_total: '10' } })
  expect(res).toEqual({ statusCode: 200, body: { sent: '000000202' } })
  expect(mockDb.data.get('export_runs')[0]).toMatchObject({ order: '000000202', status: 'sent' })
})

test.each([
  ['no data', {}],
  ['data without an order number', { data: { value: { grand_total: '5', customer_email: 'jane@example.com' } } }]
])('%s: 400, and no token, database or ERP call', async (_name, extra) => {
  mockDb = fakeDb()
  const res = await main({ ...base, ...extra })
  expect(res).toEqual({ statusCode: 400, body: { error: 'no order number' } })
  expect(mockAuth).not.toHaveBeenCalled()
  expect(mockDb.calls.init).toHaveLength(0)
  expect(global.fetch).not.toHaveBeenCalled()
  expect(mockDb.calls.close).toBe(0)
})

test('the 400 path logs only the data keys, never values', async () => {
  const warn = jest.fn()
  const sdk = require('@adobe/aio-sdk')
  const spy = jest.spyOn(sdk.Core, 'Logger').mockReturnValue({ info: () => {}, warn, error: () => {} })
  mockDb = fakeDb()
  await main({ ...base, data: { value: { customer_email: 'jane@example.com' } } })
  await main({ ...base, data: { grand_total: '5', customer_email: 'jane@example.com' } })
  spy.mockRestore()
  expect(warn).toHaveBeenCalledTimes(2)
  expect(warn.mock.calls[1][0]).toBe('no order number in event: ["grand_total","customer_email"]')
  expect(warn.mock.calls.flat().join(' ')).not.toContain('jane@example.com')
})

test('an ERP failure answers 500 and writes no sent row, so I/O Events retries', async () => {
  global.fetch = scriptedFetch([400])
  mockDb = fakeDb()
  const res = await main({ ...base, ...event })
  expect(res).toEqual({ statusCode: 500, body: { error: 'ERP returned 400' } })
  expect(mockDb.data.get('export_runs') || []).toHaveLength(0)
  expect(mockDb.calls.close).toBe(1)
})

test('a 409 from the ERP counts as sent', async () => {
  global.fetch = scriptedFetch([409])
  mockDb = fakeDb()
  const res = await main({ ...base, ...event })
  expect(res.body).toEqual({ sent: '000000201' })
  expect(mockDb.data.get('export_runs')).toHaveLength(1)
})

test('missing ERP settings answer 500 and send nothing', async () => {
  mockDb = fakeDb()
  const res = await main({ ...event })
  expect(res.statusCode).toBe(500)
  expect(global.fetch).not.toHaveBeenCalled()
  expect(mockDb.data.get('export_runs') || []).toHaveLength(0)
  expect(mockDb.calls.close).toBe(1)
})

test('a token failure answers 500 and calls neither database nor ERP', async () => {
  mockAuth.mockRejectedValueOnce(new Error('ims down'))
  mockDb = fakeDb()
  const res = await main({ ...base, ...event })
  expect(res).toEqual({ statusCode: 500, body: { error: 'ims down' } })
  expect(mockDb.calls.init).toHaveLength(0)
  expect(mockDb.calls.connect).toBe(0)
  expect(mockDb.calls.close).toBe(0)
  expect(global.fetch).not.toHaveBeenCalled()
})

test('a database failure on the lookup answers 500 and still closes the client', async () => {
  mockDb = fakeDb(new Map(), { failOn: ['findOne'] })
  const res = await main({ ...base, ...event })
  expect(res.statusCode).toBe(500)
  expect(global.fetch).not.toHaveBeenCalled()
  expect(mockDb.calls.close).toBe(1)
})

test('a failed insert after a successful send answers 500 (the ERP dedups the redelivery) and closes', async () => {
  mockDb = fakeDb(new Map(), { failOn: ['insertOne'] })
  const res = await main({ ...base, ...event })
  expect(res.statusCode).toBe(500)
  expect(global.fetch).toHaveBeenCalledTimes(1)
  expect(mockDb.calls.close).toBe(1)
})

test('error logs carry only the message: no stack, no object, no ERP response body', async () => {
  const error = jest.fn()
  const sdk = require('@adobe/aio-sdk')
  const spy = jest.spyOn(sdk.Core, 'Logger').mockReturnValue({ info: () => {}, warn: () => {}, error, debug: () => {} })
  const body = 'ECHOED-CUSTOMER-JANE'
  global.fetch = jest.fn(async () => ({ ok: false, status: 400, text: async () => body }))
  mockDb = fakeDb()
  const res = await main({ ...base, ...event })
  spy.mockRestore()
  expect(res.statusCode).toBe(500)
  expect(error).toHaveBeenCalledTimes(1)
  const [arg, ...rest] = error.mock.calls[0]
  expect(rest).toHaveLength(0)
  expect(typeof arg).toBe('string')
  expect(arg).toBe('order 000000201: ERP returned 400')
  expect(arg).not.toMatch(/\n\s+at /)
  expect(JSON.stringify(res)).not.toContain(body)
})

test('a transient 503 then a success through erp.js writes exactly one sent row', async () => {
  jest.useFakeTimers()
  try {
    global.fetch = scriptedFetch([503, 201])
    mockDb = fakeDb()
    const promise = main({ ...base, ...event })
    await jest.advanceTimersByTimeAsync(1000)
    const res = await promise
    expect(res.body).toEqual({ sent: '000000201' })
    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(mockDb.data.get('export_runs')).toHaveLength(1)
  } finally {
    jest.useRealTimers()
  }
})
