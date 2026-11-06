/*
 * Unit tests for the Ep 4 sync-log action: aio-lib-db and the token call are faked,
 * so this proves the logic (insert, last failure, close in finally, error mapping), not a real database.
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

const { fakeDb } = require('./helpers')
const { main } = require('../actions/sync-log')

beforeEach(() => {
  mockAuth.mockClear()
  mockAuth.mockImplementation(async () => ({ access_token: 'tok-123' }))
})

test('records the run and returns no failure when there is none', async () => {
  mockDb = fakeDb()
  const res = await main({ sku: 'MUG', status: 'sent' })
  expect(res).toEqual({ statusCode: 200, body: { lastFailure: null } })
  const rows = mockDb.data.get('export_runs')
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ sku: 'MUG', status: 'sent', error: null })
  expect(new Date(rows[0].at).toISOString()).toBe(rows[0].at)
  expect(mockDb.calls.init).toEqual([{ token: 'tok-123', region: 'emea' }])
  expect(mockDb.calls.close).toBe(1)
})

test('returns the newest failure for that SKU only', async () => {
  mockDb = fakeDb(new Map([['export_runs', [
    { sku: 'MUG', status: 'failed', error: 'old', at: '2027-01-01T00:00:00.000Z' },
    { sku: 'MUG', status: 'failed', error: 'new', at: '2027-01-02T00:00:00.000Z' },
    { sku: 'MUG', status: 'sent', error: null, at: '2027-01-03T00:00:00.000Z' },
    { sku: 'TSHIRT-M', status: 'failed', error: 'other sku', at: '2027-01-04T00:00:00.000Z' }
  ]]]))
  const res = await main({ sku: 'MUG', status: 'sent' })
  expect(res.statusCode).toBe(200)
  expect(res.body.lastFailure).toMatchObject({ error: 'new' })
})

test('a failed run is stored with its error and is its own last failure', async () => {
  mockDb = fakeDb()
  const res = await main({ sku: 'MUG', status: 'failed', error: 'ERP 503' })
  expect(res.body.lastFailure).toMatchObject({ sku: 'MUG', status: 'failed', error: 'ERP 503' })
})

test('a database error answers 500 "database error" and still closes the client', async () => {
  mockDb = fakeDb(new Map(), { failOn: ['insertOne'] })
  const res = await main({ sku: 'MUG', status: 'sent' })
  expect(res).toEqual({ statusCode: 500, body: { error: 'database error' } })
  expect(mockDb.calls.close).toBe(1)
})

test('closes the client when a later step fails too', async () => {
  mockDb = fakeDb(new Map(), { failOn: ['find'] })
  const res = await main({ sku: 'MUG', status: 'sent' })
  expect(res.statusCode).toBe(500)
  expect(mockDb.calls.close).toBe(1)
})

test('a token failure returns its message and never opens a connection', async () => {
  mockDb = fakeDb()
  mockAuth.mockImplementation(async () => { throw new Error('no credentials') })
  const res = await main({ sku: 'MUG', status: 'sent' })
  expect(res).toEqual({ statusCode: 500, body: { error: 'no credentials' } })
  expect(mockDb.calls.connect).toBe(0)
  expect(mockDb.calls.close).toBe(0)
})

test('passes the action params (with the injected credentials) to generateAccessToken', async () => {
  mockDb = fakeDb()
  const params = { sku: 'MUG', status: 'sent', __ims_oauth_s2s: { client_id: 'c' } }
  await main(params)
  expect(mockAuth).toHaveBeenCalledWith(params)
})
