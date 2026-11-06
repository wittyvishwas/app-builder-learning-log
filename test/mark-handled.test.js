/*
 * Unit tests for the Ep 9 mark-handled action: aio-lib-db and the token call are faked.
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
const { main } = require('../src/commerce-backend-ui-1/actions/mark-handled')

const alerts = () => [
  { order: '000000101', status: 'pending_payment', at: '2027-01-01T00:00:00.000Z', handled: false },
  { order: '000000102', status: 'pending_payment', at: '2027-01-02T00:00:00.000Z', handled: false }
]
beforeEach(() => { mockLogs.error = [] })

test.each([undefined, '', '   ', 101, null, { $ne: '' }])('rejects a missing or non-string order (%p) with 400 and no database call', async order => {
  mockDb = fakeDb()
  const res = await main({ order })
  expect(res).toEqual({ statusCode: 400, body: { error: 'order is required' } })
  expect(mockDb.calls.init).toHaveLength(0)
})

test('sets handled and handledAt on that order only, and closes the client', async () => {
  mockDb = fakeDb(new Map([['stuck_alerts', alerts()]]))
  const res = await main({ order: '000000101' })
  expect(res).toEqual({ statusCode: 200, body: { order: '000000101', handled: true } })
  const [a, b] = mockDb.data.get('stuck_alerts')
  expect(a.handled).toBe(true)
  expect(new Date(a.handledAt).toISOString()).toBe(a.handledAt)
  expect(b.handled).toBe(false)
  expect(b.handledAt).toBeUndefined()
  expect(mockDb.calls.close).toBe(1)
})

test('answers 404 for an order with no alert, and creates nothing', async () => {
  mockDb = fakeDb(new Map([['stuck_alerts', alerts()]]))
  const res = await main({ order: '999' })
  expect(res).toEqual({ statusCode: 404, body: { error: 'no such alert' } })
  expect(mockDb.data.get('stuck_alerts')).toHaveLength(2)
  expect(mockDb.calls.close).toBe(1)
})

test('a database error answers 500, is logged by message, and still closes the client', async () => {
  mockDb = fakeDb(new Map([['stuck_alerts', alerts()]]), { failOn: ['updateOne'] })
  const res = await main({ order: '000000101' })
  expect(res).toEqual({ statusCode: 500, body: { error: 'database error' } })
  expect(mockLogs.error).toEqual(['fakeDb: updateOne failed'])
  expect(mockDb.calls.close).toBe(1)
})
