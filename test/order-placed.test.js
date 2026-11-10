/*
 * Unit tests for the Ep 6 order-placed action: aio-lib-db, the token call and the ERP (fetch) are faked.
 * This proves the logic (the atomic claim in order_claims, status codes, close in finally), not a real delivery.
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
const claimsOf = db => db.data.get('order_claims') || []
const minutesAgo = n => new Date(Date.now() - n * 60 * 1000).toISOString()
// An index like the one scripts/post-deploy-db-setup.js creates: the fake needs it to reject a second claim.
const dbWithIndex = async (data) => {
  const db = fakeDb(data)
  await db.client.collection('order_claims').createIndex({ order: 1 }, { unique: true, name: 'order_1' })
  return db
}
// Makes every order_claims.updateOne throw a plain error (not a duplicate key), like an outage during the claim.
const breakClaimWrites = db => {
  const real = db.client.collection
  db.client.collection = name => {
    const c = real(name)
    if (name === 'order_claims') c.updateOne = async () => { throw new Error('service unavailable') }
    return c
  }
  return db
}
// Logger spies, one per level, so the info/warn choice is asserted.
const spyLogger = () => {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  const spy = jest.spyOn(require('@adobe/aio-sdk').Core, 'Logger').mockReturnValue({ ...log, debug: () => {} })
  return { ...log, restore: () => spy.mockRestore() }
}
const withClaim = (status, at) => dbWithIndex(new Map([['order_claims', [{ order: '000000201', status, at }]]]))

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
  expect(claimsOf(mockDb)).toEqual([expect.objectContaining({ order: '000000201', status: 'sent' })])
})

test('a redelivery is skipped without calling the ERP', async () => {
  mockDb = await dbWithIndex()
  await main({ ...base, ...event })
  global.fetch.mockClear()
  const res = await main({ ...base, ...event })
  expect(res).toEqual({ statusCode: 200, body: { skipped: true } })
  expect(global.fetch).not.toHaveBeenCalled()
  expect(mockDb.data.get('export_runs')).toHaveLength(1)
  expect(mockDb.calls.close).toBe(2)
})

test('export_runs rows do not influence the claim: a retry or dead row is left alone', async () => {
  mockDb = fakeDb(new Map([['export_runs', [
    { order: '000000201', status: 'dead', at: '2027-01-01T00:00:00.000Z' },
    { order: '000000999', status: 'sent', at: '2027-01-01T00:00:00.000Z' }
  ]]]))
  const res = await main({ ...base, ...event })
  expect(res.body).toEqual({ sent: '000000201' })
  expect(global.fetch).toHaveBeenCalledTimes(1)
  const rows = mockDb.data.get('export_runs')
  expect(rows.map(r => `${r.order}:${r.status}`)).toEqual(['000000201:dead', '000000999:sent', '000000201:sent'])
  expect(rows[0].at).toBe('2027-01-01T00:00:00.000Z')
})

test('the sent row is an upsert: an existing sent row is updated, never duplicated', async () => {
  mockDb = fakeDb(new Map([['export_runs', [{ order: '000000201', status: 'sent', at: '2020-01-01T00:00:00.000Z' }]]]))
  const res = await main({ ...base, ...event })
  expect(res.body).toEqual({ sent: '000000201' })
  const rows = mockDb.data.get('export_runs')
  expect(rows).toHaveLength(1)
  expect(rows[0].at).not.toBe('2020-01-01T00:00:00.000Z')
})

test('params.data without .value works', async () => {
  mockDb = fakeDb()
  const res = await main({ ...base, data: { increment_id: '000000202', grand_total: '10' } })
  expect(res).toEqual({ statusCode: 200, body: { sent: '000000202' } })
  expect(mockDb.data.get('export_runs')[0]).toMatchObject({ order: '000000202', status: 'sent' })
})

test('the nested payload Commerce sends (data.value.order) sends the order and writes the sent row', async () => {
  mockDb = fakeDb()
  const res = await main({ ...base, data: { value: { order: { increment_id: '100000001', grand_total: 12 } } } })
  expect(res).toEqual({ statusCode: 200, body: { sent: '100000001' } })
  expect(global.fetch).toHaveBeenCalledTimes(1)
  const [url, init] = global.fetch.mock.calls[0]
  expect(url).toBe('https://erp.example.com/orders')
  expect(init.headers['Idempotency-Key']).toBe('100000001')
  expect(JSON.parse(init.body)).toMatchObject({ orderNumber: '100000001', increment_id: '100000001', grand_total: 12 })
  expect(mockDb.data.get('export_runs')).toEqual([expect.objectContaining({ order: '100000001', status: 'sent' })])
  expect(mockDb.calls.close).toBe(1)
})

test.each([
  ['an empty order', { data: { value: { order: {} } } }],
  ['an empty value (fields did not match)', { data: { value: {} } }]
])('nested payload with %s: 400, and no token, database or ERP call', async (_name, extra) => {
  mockDb = fakeDb()
  const res = await main({ ...base, ...extra })
  expect(res).toEqual({ statusCode: 400, body: { error: 'no order number' } })
  expect(mockAuth).not.toHaveBeenCalled()
  expect(mockDb.calls.init).toHaveLength(0)
  expect(global.fetch).not.toHaveBeenCalled()
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

test('the 400 path for a nested payload logs the order\'s keys, not the value', async () => {
  const warn = jest.fn()
  const sdk = require('@adobe/aio-sdk')
  const spy = jest.spyOn(sdk.Core, 'Logger').mockReturnValue({ info: () => {}, warn, error: () => {} })
  mockDb = fakeDb()
  const res = await main({ ...base, data: { value: { order: { grand_total: 1 } } } })
  spy.mockRestore()
  expect(res.statusCode).toBe(400)
  expect(warn.mock.calls[0][0]).toBe('no order number in event: ["grand_total"]')
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
  expect(claimsOf(mockDb)).toEqual([expect.objectContaining({ order: '000000201', status: 'failed' })])
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

test('a database failure on the claim answers 500, sends nothing and still closes the client', async () => {
  mockDb = fakeDb(new Map(), { failOn: ['updateOne'] })
  const res = await main({ ...base, ...event })
  expect(res).toEqual({ statusCode: 500, body: { error: 'fakeDb: updateOne failed' } })
  expect(global.fetch).not.toHaveBeenCalled()
  expect(mockDb.calls.close).toBe(1)
})

test('a failure on the claim and on the lookup after it answers 500 and sends nothing', async () => {
  mockDb = fakeDb(new Map(), { failOn: ['updateOne', 'findOne'] })
  const res = await main({ ...base, ...event })
  // The claim error is what comes back, not the error of the lookup.
  expect(res).toEqual({ statusCode: 500, body: { error: 'fakeDb: updateOne failed' } })
  expect(global.fetch).not.toHaveBeenCalled()
  expect(mockDb.calls.close).toBe(1)
})

test('a failed sent row after a successful send answers 500, keeps the claim sending (the ERP dedups) and closes', async () => {
  mockDb = fakeDb(new Map(), { failOn: ['export_runs.updateOne'] })
  const res = await main({ ...base, ...event })
  expect(res.statusCode).toBe(500)
  expect(global.fetch).toHaveBeenCalledTimes(1)
  expect(mockDb.data.get('export_runs') || []).toHaveLength(0)
  expect(claimsOf(mockDb)).toEqual([expect.objectContaining({ status: 'sending' })])
  expect(mockDb.calls.close).toBe(1)
})

test('marking the claim sent fails after a successful send: 500, the sent row is there, the claim stays sending', async () => {
  // Calls to order_claims.updateOne: 1 is the claim, 2 is the mark sent.
  mockDb = fakeDb(new Map(), { failOn: ['order_claims.updateOne#2'] })
  const res = await main({ ...base, ...event })
  expect(res).toEqual({ statusCode: 500, body: { error: 'fakeDb: updateOne failed' } })
  expect(global.fetch).toHaveBeenCalledTimes(1)
  expect(mockDb.data.get('export_runs')).toEqual([expect.objectContaining({ order: '000000201', status: 'sent' })])
  expect(claimsOf(mockDb)).toEqual([expect.objectContaining({ status: 'sending' })])
  expect(mockDb.calls.close).toBe(1)
})

test('the sent row is written before the claim is marked sent', async () => {
  mockDb = fakeDb()
  const calls = []
  const real = mockDb.client.collection
  mockDb.client.collection = name => {
    const c = real(name)
    const f = c.updateOne
    c.updateOne = async (...a) => { calls.push(`${name}.updateOne`); return f(...a) }
    return c
  }
  await main({ ...base, ...event })
  expect(calls).toEqual(['order_claims.updateOne', 'export_runs.updateOne', 'order_claims.updateOne'])
})

test('a sent claim is skipped without calling the ERP', async () => {
  mockDb = await withClaim('sent', minutesAgo(60))
  const res = await main({ ...base, ...event })
  expect(res).toEqual({ statusCode: 200, body: { skipped: true } })
  expect(global.fetch).not.toHaveBeenCalled()
  expect(claimsOf(mockDb)).toHaveLength(1)
})

test('a fresh sending claim answers 503 so I/O Events retries, and calls no ERP', async () => {
  mockDb = await withClaim('sending', minutesAgo(1))
  const res = await main({ ...base, ...event })
  expect(res).toEqual({ statusCode: 503, body: { error: 'in progress, retry later' } })
  expect(global.fetch).not.toHaveBeenCalled()
  expect(claimsOf(mockDb)[0]).toMatchObject({ status: 'sending' })
  expect(mockDb.calls.close).toBe(1)
})

test('a stale sending claim is claimed again and sent', async () => {
  mockDb = await withClaim('sending', minutesAgo(11))
  const res = await main({ ...base, ...event })
  expect(res.body).toEqual({ sent: '000000201' })
  expect(global.fetch).toHaveBeenCalledTimes(1)
  expect(claimsOf(mockDb)).toEqual([expect.objectContaining({ order: '000000201', status: 'sent' })])
})

test('a failed claim is claimed again and sent', async () => {
  mockDb = await withClaim('failed', minutesAgo(1))
  const res = await main({ ...base, ...event })
  expect(res.body).toEqual({ sent: '000000201' })
  expect(global.fetch).toHaveBeenCalledTimes(1)
  expect(claimsOf(mockDb)).toHaveLength(1)
  expect(claimsOf(mockDb)[0].status).toBe('sent')
})

test('an ERP failure, then a redelivery: the second delivery claims it and sends', async () => {
  mockDb = await dbWithIndex()
  global.fetch = scriptedFetch([400])
  expect((await main({ ...base, ...event })).statusCode).toBe(500)
  global.fetch = scriptedFetch([200])
  expect((await main({ ...base, ...event })).body).toEqual({ sent: '000000201' })
  expect(global.fetch).toHaveBeenCalledTimes(1)
  expect(claimsOf(mockDb)).toHaveLength(1)
})

test('two deliveries at once: exactly one ERP call', async () => {
  mockDb = await dbWithIndex()
  const results = await Promise.all([main({ ...base, ...event }), main({ ...base, ...event })])
  expect(global.fetch).toHaveBeenCalledTimes(1)
  expect(results.map(r => r.statusCode).sort()).toEqual([200, 503])
  expect(results.find(r => r.statusCode === 200).body).toEqual({ sent: '000000201' })
  expect(mockDb.data.get('export_runs')).toHaveLength(1)
  expect(claimsOf(mockDb)).toEqual([expect.objectContaining({ status: 'sent' })])
  expect(mockDb.calls.close).toBe(2)
})

test('a claim error that is not a duplicate key, with no claim on file, answers 500 and sends nothing', async () => {
  mockDb = fakeDb()
  const real = mockDb.client.collection
  mockDb.client.collection = name => {
    const c = real(name)
    if (name === 'order_claims') c.updateOne = async () => { throw new Error('service unavailable') }
    return c
  }
  const res = await main({ ...base, ...event })
  expect(res).toEqual({ statusCode: 500, body: { error: 'service unavailable' } })
  expect(global.fetch).not.toHaveBeenCalled()
})

test('a claim error that is not a duplicate key, with a sent claim on file: 200 skipped and a warn log', async () => {
  const log = spyLogger()
  mockDb = breakClaimWrites(await withClaim('sent', minutesAgo(60)))
  const res = await main({ ...base, ...event })
  log.restore()
  expect(res).toEqual({ statusCode: 200, body: { skipped: true } })
  expect(global.fetch).not.toHaveBeenCalled()
  expect(log.warn.mock.calls).toEqual([['order 000000201 already claimed (sent)']])
  expect(log.info).not.toHaveBeenCalled()
})

test('a claim error that is not a duplicate key, with a fresh sending claim on file: 503 and a warn log', async () => {
  const log = spyLogger()
  mockDb = breakClaimWrites(await withClaim('sending', minutesAgo(1)))
  const res = await main({ ...base, ...event })
  log.restore()
  expect(res).toEqual({ statusCode: 503, body: { error: 'in progress, retry later' } })
  expect(global.fetch).not.toHaveBeenCalled()
  expect(log.warn.mock.calls).toEqual([['order 000000201 already claimed (sending)']])
  expect(log.info).not.toHaveBeenCalled()
})

test.each([
  ['failed', 1],
  ['sending', 11]
])('a claim error with a %s claim that is claimable: 500 with the original error, nothing sent', async (status, age) => {
  mockDb = breakClaimWrites(await withClaim(status, minutesAgo(age)))
  const res = await main({ ...base, ...event })
  expect(res).toEqual({ statusCode: 500, body: { error: 'service unavailable' } })
  expect(global.fetch).not.toHaveBeenCalled()
  expect(claimsOf(mockDb)[0].status).toBe(status)
})

test.each([
  ['an operator object', { $ne: null }],
  ['a number', 201],
  ['an empty string', ''],
  ['a string with whitespace', '0000 201'],
  ['a string over 64 characters', 'x'.repeat(65)]
])('increment_id as %s: 400, and no database or ERP call', async (_name, increment_id) => {
  mockDb = fakeDb()
  const res = await main({ ...base, data: { value: { increment_id, grand_total: '5' } } })
  expect(res).toEqual({ statusCode: 400, body: { error: 'no order number' } })
  expect(mockDb.calls.init).toHaveLength(0)
  expect(global.fetch).not.toHaveBeenCalled()
})

test('skip and in-progress logs after a duplicate key are info, carry the message only, never the database error', async () => {
  const { info, warn, restore } = spyLogger()
  mockDb = await dbWithIndex()
  await main({ ...base, ...event })
  await main({ ...base, ...event })
  mockDb = await withClaim('sending', minutesAgo(1))
  await main({ ...base, ...event })
  restore()
  expect(info.mock.calls).toEqual([
    ['order 000000201 already claimed (sent)'],
    ['order 000000201 already claimed (sending)']
  ])
  expect(warn).not.toHaveBeenCalled()
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
