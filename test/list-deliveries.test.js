/*
 * Unit tests for the Ep 10 list-deliveries action: aio-lib-db and the token call are faked.
 * Proves which rows are listed (order rows only), the order (failures first, newest first), the limit,
 * that `mapped` never leaves the action, closing the client and error mapping.
 */
let mockDb
jest.mock('@adobe/aio-lib-db', () => ({ init: (...a) => mockDb.init(...a) }))
const mockLogs = { error: [] }
jest.mock('@adobe/aio-sdk', () => ({
  Core: {
    Logger: () => ({ info: () => {}, warn: () => {}, error: m => mockLogs.error.push(m), debug: () => {} }),
    AuthClient: { generateAccessToken: async () => ({ access_token: 'tok-123' }) }
  }
}))

const { fakeDb } = require('./helpers')
const { main } = require('../src/commerce-backend-ui-1/actions/list-deliveries')

const at = n => `2027-01-01T00:${String(n).padStart(2, '0')}:00.000Z`
beforeEach(() => { mockLogs.error = [] })

test('failures first (dead, retry, sent), newest first within each, sync-log rows left out', async () => {
  mockDb = fakeDb(new Map([['export_runs', [
    { order: 'S1', status: 'sent', at: at(1) },
    { order: 'D1', status: 'dead', at: at(2), attempts: 6, lastError: 'ERP returned 422', httpStatus: 422, lines: [], totals: {} },
    { order: 'R1', status: 'retry', at: at(3), attempts: 2, nextAt: at(3), lastError: 'ERP returned 503', httpStatus: 503, mapped: { customer: { email: 'jane@example.com' } } },
    { order: 'S2', status: 'sent', at: at(9) },
    { order: 'D2', status: 'dead', at: at(8), attempts: 1, lastError: 'ERP returned 400', httpStatus: 400 },
    { order: 'R2', status: 'retry', at: at(4), attempts: 1, nextAt: at(4), lastError: 'ERP returned 500', httpStatus: 500 },
    { sku: 'TSHIRT-M', status: 'sent', error: null, at: at(20) }, // Ep 4 sync-log row
    { sku: 'MUG', status: 'failed', error: 'x', at: at(21) }
  ]]]))
  const res = await main({})
  expect(res.statusCode).toBe(200)
  expect(res.body.map(r => r.order)).toEqual(['D2', 'D1', 'R2', 'R1', 'S2', 'S1'])
  expect(mockDb.calls.init).toEqual([{ token: 'tok-123', region: 'emea' }])
  expect(mockDb.calls.close).toBe(1)
})

test('returns only order, status, attempts, lastError, httpStatus, at and nextAt: never mapped, lines or totals', async () => {
  mockDb = fakeDb(new Map([['export_runs', [
    { order: 'R1', status: 'retry', at: at(3), attempts: 2, nextAt: at(3), lastError: 'ERP returned 503', httpStatus: 503, mapped: { customer: { email: 'jane@example.com' } } },
    { order: 'D1', status: 'dead', at: at(2), attempts: 6, lastError: 'ERP returned 422', httpStatus: 422, lines: [{ sku: 'A' }], totals: { total: 1 } }
  ]]]))
  const res = await main({})
  for (const r of res.body) expect(Object.keys(r).sort()).toEqual(['at', 'attempts', 'httpStatus', 'lastError', 'nextAt', 'order', 'status'])
  expect(JSON.stringify(res.body)).not.toContain('jane@example.com')
  expect(res.body[1]).toEqual({ order: 'R1', status: 'retry', attempts: 2, lastError: 'ERP returned 503', httpStatus: 503, at: at(3), nextAt: at(3) })
})

test('returns at most 50 rows, failures kept ahead of the newer sent rows', async () => {
  const sent = Array.from({ length: 60 }, (_, i) => ({ order: `S${i}`, status: 'sent', at: at(i) }))
  mockDb = fakeDb(new Map([['export_runs', [...sent, { order: 'D1', status: 'dead', at: '2026-12-31T00:00:00.000Z', attempts: 6 }]]]))
  const res = await main({})
  expect(res.body).toHaveLength(50)
  expect(res.body[0].order).toBe('D1')
  expect(res.body[1].order).toBe('S59')
})

test('retry and dead rows of an order that also has a sent row are left out', async () => {
  mockDb = fakeDb(new Map([['export_runs', [
    { order: 'A', status: 'sent', at: at(1) },
    { order: 'A', status: 'dead', at: at(2), attempts: 6 },
    { order: 'B', status: 'sent', at: at(3) },
    { order: 'B', status: 'retry', at: at(4), attempts: 1, nextAt: at(4) },
    { order: 'C', status: 'dead', at: at(5), attempts: 6 }
  ]]]))
  const res = await main({})
  expect(res.body.map(r => `${r.order}:${r.status}`)).toEqual(['C:dead', 'B:sent', 'A:sent'])
})

test('an empty collection answers an empty list', async () => {
  mockDb = fakeDb()
  expect(await main({})).toEqual({ statusCode: 200, body: [] })
  expect(mockDb.calls.close).toBe(1)
})

test('a database error answers 500, is logged by message, and still closes the client', async () => {
  mockDb = fakeDb(new Map(), { failOn: ['find'] })
  const res = await main({})
  expect(res).toEqual({ statusCode: 500, body: { error: 'database error' } })
  expect(mockLogs.error).toEqual(['fakeDb: find failed'])
  expect(mockDb.calls.close).toBe(1)
})

test('a failed connect answers 500 and has nothing to close', async () => {
  mockDb = fakeDb(new Map(), { failOn: ['connect'] })
  expect((await main({})).statusCode).toBe(500)
  expect(mockDb.calls.close).toBe(0)
})
