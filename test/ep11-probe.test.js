/*
 * Unit tests for the Ep 11 probe action: State, Files and aio-lib-db are faked, so this proves the result shape and
 * the error mapping, not what the real services answer.
 */
let mockDb
const mockStore = new Map()
const mockState = { initError: null, getBroken: false, onPut: null }
const mockFiles = { initError: null, data: new Map() }
jest.mock('@adobe/aio-lib-db', () => ({ init: (...a) => mockDb.init(...a) }))
jest.mock('@adobe/aio-lib-state', () => ({
  init: async () => {
    if (mockState.initError) throw mockState.initError
    const st = require('./helpers').fakeState(mockStore)
    return {
      ...st,
      put: async (k, ...r) => { if (mockState.onPut) mockState.onPut(k); return st.put(k, ...r) },
      get: async k => { if (mockState.getBroken) throw new Error('get failed'); return st.get(k) }
    }
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
const { main: probeMain } = require('../actions/ep11-probe')
const { main: stateProbeMain, scrubber } = require('../dev/run-ep11/state-probe')

// The action is gated in code: every call here passes the flag unless a test says otherwise.
const main = params => probeMain({ EP11_PROBE_ENABLED: '1', ...params })

// fakeDb has no collection.drop(): add it, as aio-lib-db 1.1.0 has one. opts.dropFails makes it throw.
function dbWithDrop ({ dropFails, ...opts } = {}) {
  const db = fakeDb(new Map(), opts)
  const orig = db.client.collection
  db.client.collection = name => ({
    ...orig(name),
    drop: async () => {
      if (dropFails) throw new DbError('fakeDb: drop failed')
      db.data.delete(name)
    }
  })
  return db
}

beforeEach(() => {
  mockStore.clear()
  mockFiles.data.clear()
  mockState.initError = null
  mockState.getBroken = false
  mockState.onPut = null
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

test('a DbError is recorded with its message and stops the op; the collection is cleaned up', async () => {
  mockDb = dbWithDrop({ failOn: ['findOne'] })
  const res = await main({ op: 'db' })
  const last = res.body.results[res.body.results.length - 1]
  expect(last).toEqual({ call: 'findOne', ok: false, error: 'fakeDb: findOne failed' })
  expect(res.statusCode).toBe(200)
  expect(mockDb.data.has('ep11_probe')).toBe(false)
  expect(mockDb.calls.close).toBe(1)
})

test('when deleteOne fails the cleanup still drops the collection', async () => {
  mockDb = dbWithDrop({ failOn: ['deleteOne'] })
  const res = await main({ op: 'db' })
  expect(res.body.results.map(r => [r.call, r.ok]).pop()).toEqual(['deleteOne', false])
  expect(mockDb.data.has('ep11_probe')).toBe(false)
})

test('when drop fails the op records it, the row is gone and the client is closed', async () => {
  mockDb = dbWithDrop({ dropFails: true })
  const res = await main({ op: 'db' })
  expect(res.body.results.pop()).toEqual({ call: 'drop', ok: false, error: 'fakeDb: drop failed' })
  expect(mockDb.data.get('ep11_probe')).toEqual([])
  expect(mockDb.calls.close).toBe(1)
})

test('state failing at get leaves no key behind', async () => {
  mockState.getBroken = true
  const res = await main({ op: 'state' })
  expect(res.body.results.pop()).toEqual({ call: 'get', ok: false, error: 'get failed' })
  expect(mockStore.size).toBe(0)
})

test('state key and db id carry a random suffix and differ between runs', async () => {
  const keys = new Set()
  for (let i = 0; i < 2; i++) {
    mockState.onPut = k => keys.add(k)
    await main({ op: 'state' })
  }
  mockState.onPut = null
  expect(keys.size).toBe(2)
  for (const k of keys) expect(k).toMatch(/^ep11-probe-[0-9a-f]{12}$/)
})

test('db op: the inserted document carries an id and findOne filters on it', async () => {
  mockDb = dbWithDrop()
  const inserted = []
  const orig = mockDb.client.collection
  mockDb.client.collection = name => {
    const c = orig(name)
    return { ...c, insertOne: async d => { inserted.push(d); return c.insertOne(d) } }
  }
  await main({ op: 'db' })
  expect(inserted[0].id).toMatch(/^[0-9a-f]{12}$/)
})

test('the db op passes only __ims_oauth_s2s and __ims_env to generateAccessToken', async () => {
  mockDb = dbWithDrop()
  await main({ op: 'db', __ims_oauth_s2s: { client_id: 'c' }, __ims_env: 'stage', SECRET_PARAM: 'x', __ow_headers: { authorization: 'Bearer y' } })
  expect(mockAuth).toHaveBeenCalledWith({ __ims_oauth_s2s: { client_id: 'c' }, __ims_env: 'stage' })
})

test.each([[undefined], [''], ['0'], ['true'], [1]])('disabled (EP11_PROBE_ENABLED %p) answers 403 and calls nothing', async flag => {
  mockDb = dbWithDrop()
  const res = await probeMain({ op: 'db', EP11_PROBE_ENABLED: flag })
  expect(res).toEqual({ statusCode: 403, body: { error: 'ep11-probe disabled' } })
  expect(mockAuth).not.toHaveBeenCalled()
  expect(mockDb.calls.init).toEqual([])
})

test('no params at all answers 403', async () => {
  expect((await probeMain()).statusCode).toBe(403)
})

test('app.config.yaml: ep11-probe is a non-web action with the enable gate input', () => {
  // Deployed, a non-web action can only be invoked with the namespace auth. require-adobe-auth would turn it into a
  // web sequence whose request params override the inputs (the gate included), and final does not protect the inner
  // `__secured_` action, so neither may come back. Under `aio app dev` it is still served over HTTP, with a warning.
  const cfg = require('fs').readFileSync(require('path').join(__dirname, '../app.config.yaml'), 'utf8')
  const start = cfg.indexOf('\n          ep11-probe:')
  expect(start).toBeGreaterThan(-1)
  const next = cfg.indexOf('\nextensions:', start)
  const block = cfg.slice(start, next === -1 ? undefined : next)
  expect(block).toMatch(/^\s+web: 'no'$/m)
  expect(block).not.toMatch(/web: 'yes'|web: true|web-export/)
  expect(block).not.toMatch(/^\s+require-adobe-auth:/m)
  expect(block).not.toMatch(/^\s+final:/m)
  expect(block).toMatch(/^\s+include-ims-credentials: true$/m)
  expect(block).toMatch(/^\s+EP11_PROBE_ENABLED: \$EP11_PROBE_ENABLED$/m)
})

describe('dev/run-ep11/state-probe.js', () => {
  const env = { AIO_runtime_namespace: 'ns-1234567890', AIO_runtime_auth: 'auth-secret-value', SHORT: 'abc' }
  const failing = message => ({ init: async () => { throw new Error(message) } })

  test('scrubber masks a value of 8+ characters and keeps a short one', () => {
    const scrub = scrubber(env)
    expect(scrub('bad auth-secret-value here, abc stays')).toBe('bad *** here, abc stays')
  })

  test('main rejects when AIO_runtime_auth is missing', async () => {
    const { AIO_runtime_auth: _omit, ...rest } = env
    await expect(stateProbeMain([], rest, { state: failing('x'), files: failing('x') })).rejects.toThrow(/AIO_runtime_auth/)
  })

  test('a failing lib becomes an error line and main resolves; secrets in the message are masked', async () => {
    const lines = await stateProbeMain([], env, {
      state: failing('denied for auth-secret-value'),
      files: failing('files down')
    })
    expect(lines).toEqual(['state init error denied for ***', 'files init error files down'])
  })
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
