/*
 * Unit tests for the Ep 9 list-alerts action: aio-lib-db and the token call are faked.
 * Proves the query (open alerts, newest first, 50 at most), closing the client and error mapping.
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
const { main } = require('../src/commerce-backend-ui-1/actions/list-alerts')

const row = (order, at, extra = {}) => ({ order, status: 'pending_payment', created_at: '2027-01-07 08:00:00', at, handled: false, ...extra })
beforeEach(() => { mockLogs.error = [] })

test('returns open alerts only, newest first; handled ones and missing flags are treated right', async () => {
  mockDb = fakeDb(new Map([['stuck_alerts', [
    row('1', '2027-01-01T00:00:00.000Z'),
    row('2', '2027-01-03T00:00:00.000Z', { handled: true }),
    row('3', '2027-01-02T00:00:00.000Z'),
    { order: '4', status: 'pending_payment', at: '2027-01-04T00:00:00.000Z' } // no handled field: still open
  ]]]))
  const res = await main({})
  expect(res.statusCode).toBe(200)
  expect(res.body.map(r => r.order)).toEqual(['4', '3', '1'])
  expect(mockDb.calls.init).toEqual([{ token: 'tok-123', region: 'emea' }])
  expect(mockDb.calls.close).toBe(1)
})

test('returns at most 50 rows', async () => {
  const many = Array.from({ length: 60 }, (_, i) => row(String(i), `2027-01-01T00:${String(i).padStart(2, '0')}:00.000Z`))
  mockDb = fakeDb(new Map([['stuck_alerts', many]]))
  const res = await main({})
  expect(res.body).toHaveLength(50)
  expect(res.body[0].order).toBe('59')
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
