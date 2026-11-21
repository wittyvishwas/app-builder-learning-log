/*
 * Unit tests for the Ep 11 probe action: State, Files and aio-lib-db are faked, so this proves the result shape and
 * the error mapping, not what the real services answer.
 */
let mockDb
const mockStore = new Map()
const mockState = { initError: null }
const mockFiles = { initError: null, data: new Map() }
jest.mock('@adobe/aio-lib-db', () => ({ init: (...a) => mockDb.init(...a) }))
jest.mock('@adobe/aio-lib-state', () => ({
  init: async () => {
    if (mockState.initError) throw mockState.initError
    return require('./helpers').fakeState(mockStore)
  }
}))
jest.mock('@adobe/aio-lib-files', () => ({
  init: async () => {
    if (mockFiles.initError) throw mockFiles.initError
    return {
      write: async (p, c) => { mockFiles.data.set(p, c) },
      read: async p => Buffer.from(mockFiles.data.get(p)),
      delete: async p => { mockFiles.data.delete(p) }
    }
  }
}))
const mockAuth = jest.fn(async () => ({ access_token: 'tok-secret-123' }))
jest.mock('@adobe/aio-sdk', () => ({ Core: { AuthClient: { generateAccessToken: (...a) => mockAuth(...a) } } }))

const { fakeDb, DbError } = require('./helpers')
const { main } = require('../actions/ep11-probe')

// fakeDb has no collection.drop(): add it, as aio-lib-db 1.1.0 has one.
function dbWithDrop (opts) {
  const db = fakeDb(new Map(), opts)
  const orig = db.client.collection
  db.client.collection = name => ({ ...orig(name), drop: async () => { db.data.delete(name) } })
  return db
}

beforeEach(() => {
  mockStore.clear()
  mockFiles.data.clear()
  mockState.initError = null
  mockFiles.initError = null
  mockAuth.mockClear()
  mockAuth.mockImplementation(async () => ({ access_token: 'tok-secret-123' }))
})

test('state op: init, put, get and delete all work', async () => {
  const res = await main({ op: 'state' })
  expect(res.statusCode).toBe(200)
  expect(res.body.op).toBe('state')
  expect(res.body.results).toEqual([
    { call: 'init', ok: true }, { call: 'put', ok: true }, { call: 'get', ok: true }, { call: 'delete', ok: true }
  ])
  expect(mockStore.size).toBe(0)
})

test('state init failing is recorded, with status 200 and no further calls', async () => {
  mockState.initError = new Error('denied')
  const res = await main({ op: 'state' })
  expect(res.statusCode).toBe(200)
  expect(res.body.results).toEqual([{ call: 'init', ok: false, error: 'denied' }])
})

test('files op: init, write, read and delete all work and leave no file', async () => {
  const res = await main({ op: 'files' })
  expect(res.body.results.map(r => [r.call, r.ok])).toEqual([['init', true], ['write', true], ['read', true], ['delete', true]])
  expect(mockFiles.data.size).toBe(0)
})

test('files init failing is recorded', async () => {
  mockFiles.initError = new Error('not authorized')
  const res = await main({ op: 'files' })
  expect(res).toEqual({ statusCode: 200, body: { op: 'files', results: [{ call: 'init', ok: false, error: 'not authorized' }] } })
})

test('db op: token, init, insert, find, delete and drop all work, and the client is closed', async () => {
  mockDb = dbWithDrop()
  const res = await main({ op: 'db' })
  expect(res.statusCode).toBe(200)
  expect(res.body.results.map(r => [r.call, r.ok])).toEqual([
    ['token', true], ['init', true], ['insertOne', true], ['findOne', true], ['deleteOne', true], ['drop', true]
  ])
  expect(mockDb.calls.init).toEqual([{ region: 'emea', token: 'tok-secret-123' }])
  expect(mockDb.calls.close).toBe(1)
  expect(mockDb.data.has('ep11_probe')).toBe(false)
})

test('a DbError is recorded with its message and stops the op; the row is cleaned up', async () => {
  mockDb = dbWithDrop({ failOn: ['findOne'] })
  const res = await main({ op: 'db' })
  const last = res.body.results[res.body.results.length - 1]
  expect(last).toEqual({ call: 'findOne', ok: false, error: 'fakeDb: findOne failed' })
  expect(res.statusCode).toBe(200)
  expect(mockDb.data.get('ep11_probe')).toEqual([])
  expect(mockDb.calls.close).toBe(1)
})

test('a failing token is recorded as the token call', async () => {
  mockDb = dbWithDrop()
  mockAuth.mockRejectedValue(new Error('invalid_client'))
  const res = await main({ op: 'db' })
  expect(res.body.results).toEqual([{ call: 'token', ok: false, error: 'invalid_client' }])
  expect(mockDb.calls.init).toEqual([])
})

test('a DbError from init keeps its message', async () => {
  mockDb = { init: async () => { throw new DbError('Forbidden') }, calls: { close: 0 } }
  const res = await main({ op: 'db' })
  expect(res.body.results[1]).toEqual({ call: 'init', ok: false, error: 'Forbidden' })
})

test.each([['nope'], [undefined], ['']])('op %p answers 400', async op => {
  const res = await main({ op })
  expect(res.statusCode).toBe(400)
})

test('the answer never contains a value from params other than op', async () => {
  mockDb = dbWithDrop()
  const params = {
    op: 'db',
    SECRET_PARAM: 'param-secret-xyz',
    clientSecret: 'client-secret-xyz',
    __ow_headers: { authorization: 'Bearer header-secret-xyz' }
  }
  for (const op of ['state', 'files', 'db', 'nope']) {
    const res = await main({ ...params, op })
    const text = JSON.stringify(res)
    for (const secret of ['param-secret-xyz', 'client-secret-xyz', 'header-secret-xyz', 'tok-secret-123']) {
      expect(text).not.toContain(secret)
    }
  }
})
