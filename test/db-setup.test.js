/*
 * Unit tests for the Ep 4 post-deploy hook. ensureIndexes() is pure (takes a client), so most tests
 * need no token; run() is tested with aio-lib-db and the token call faked.
 */
let mockDb
jest.mock('@adobe/aio-lib-db', () => ({ init: (...a) => mockDb.init(...a) }))
const mockAuth = jest.fn(async () => ({ access_token: 'tok-abc' }))
jest.mock('@adobe/aio-sdk', () => ({ Core: { AuthClient: { generateAccessToken: (...a) => mockAuth(...a) } } }))

const { fakeDb } = require('./helpers')
const { ensureIndexes, parseScopes, run } = require('../scripts/post-deploy-db-setup')

const names = (db, coll) => db.indexes.get(coll).map(i => i.name).filter(n => n !== '_id_')

test('creates the planned indexes on every collection', async () => {
  const db = fakeDb()
  const res = await ensureIndexes(db.client)
  expect(res.skipped).toEqual([])
  expect(names(db, 'export_runs')).toEqual(['sku_1_at_-1', 'order_1_status_1', 'status_1_nextAt_1'])
  expect(names(db, 'stuck_alerts')).toEqual(['order_1', 'handled_1_at_-1'])
  expect(names(db, 'order_claims')).toEqual(['order_1'])
  expect(db.indexes.get('order_claims').find(i => i.name === 'order_1').unique).toBe(true)
  expect(db.indexes.get('stuck_alerts').find(i => i.name === 'order_1').unique).toBe(true)
})

test('a second run changes nothing and reports everything as skipped', async () => {
  const db = fakeDb()
  const first = await ensureIndexes(db.client)
  const second = await ensureIndexes(db.client)
  expect(second.created).toEqual([])
  expect(second.skipped.sort()).toEqual(first.created.sort())
  expect(names(db, 'export_runs')).toHaveLength(3)
})

test('creates only what is missing', async () => {
  const db = fakeDb()
  await db.client.collection('export_runs').createIndex({ sku: 1, at: -1 }, { name: 'sku_1_at_-1' })
  const res = await ensureIndexes(db.client)
  expect(res.skipped).toEqual(['export_runs.sku_1_at_-1'])
  expect(res.created).toHaveLength(5)
})

test('the unique index on stuck_alerts.order rejects a second alert for the same order', async () => {
  const db = fakeDb()
  await ensureIndexes(db.client)
  const alerts = db.client.collection('stuck_alerts')
  await alerts.insertOne({ order: '000000201', handled: false })
  await expect(alerts.insertOne({ order: '000000201', handled: false })).rejects.toThrow('duplicate key')
})

test('the unique index on order_claims.order rejects a second claim, which is what makes the claim atomic', async () => {
  const db = fakeDb()
  await ensureIndexes(db.client)
  const claims = db.client.collection('order_claims')
  await claims.updateOne({ order: '000000201', status: 'failed' }, { $set: { status: 'sending' } }, { upsert: true })
  await expect(claims.updateOne({ order: '000000201', status: 'failed' }, { $set: { status: 'sending' } }, { upsert: true }))
    .rejects.toThrow('E11000 duplicate key')
})

const env = {
  IMS_OAUTH_S2S_CLIENT_ID: 'id',
  IMS_OAUTH_S2S_CLIENT_SECRET: 'secret',
  IMS_OAUTH_S2S_ORG_ID: 'org@AdobeOrg',
  IMS_OAUTH_S2S_SCOPES: 'AdobeID, openid ,adobeio_api',
  AIO_RUNTIME_NAMESPACE: '1234-demo-stage'
}

test('run() gets a token from the .env credentials, then closes the client', async () => {
  mockDb = fakeDb()
  mockAuth.mockClear()
  const res = await run(env)
  expect(mockAuth).toHaveBeenCalledWith({
    clientId: 'id', clientSecret: 'secret', orgId: 'org@AdobeOrg', scopes: ['AdobeID', 'openid', 'adobeio_api']
  })
  expect(mockDb.calls.init).toEqual([{ token: 'tok-abc', region: 'emea', ow: { namespace: '1234-demo-stage' } }])
  expect(res.created).toHaveLength(6)
  expect(mockDb.calls.close).toBe(1)
})

test('run() names the missing .env variables and never touches the database', async () => {
  mockDb = fakeDb()
  await expect(run({ IMS_OAUTH_S2S_CLIENT_ID: 'id', AIO_RUNTIME_NAMESPACE: 'ns' })).rejects.toThrow(/IMS_OAUTH_S2S_CLIENT_SECRET.*IMS_OAUTH_S2S_ORG_ID.*IMS_OAUTH_S2S_SCOPES/)
  expect(mockDb.calls.init).toEqual([])
})

test('parseScopes reads the JSON array that aio app use writes', () => {
  expect(parseScopes('["AdobeID","openid","adobeio.abdata.read"]')).toEqual(['AdobeID', 'openid', 'adobeio.abdata.read'])
  expect(parseScopes(' [ " AdobeID " , "" , "openid" ] ')).toEqual(['AdobeID', 'openid'])
})

test('parseScopes reads the comma-separated list from .env.dist', () => {
  expect(parseScopes('AdobeID, openid ,adobeio_api,')).toEqual(['AdobeID', 'openid', 'adobeio_api'])
  expect(parseScopes('AdobeID')).toEqual(['AdobeID'])
})

test('parseScopes names IMS_OAUTH_S2S_SCOPES when the JSON is invalid', () => {
  expect(() => parseScopes('["AdobeID","openid"')).toThrow(/^IMS_OAUTH_S2S_SCOPES is not valid JSON/)
})

test('parseScopes names IMS_OAUTH_S2S_SCOPES when no scope is left', () => {
  expect(() => parseScopes('[]')).toThrow(/IMS_OAUTH_S2S_SCOPES has no scopes/)
  expect(() => parseScopes('')).toThrow(/IMS_OAUTH_S2S_SCOPES has no scopes/)
  expect(() => parseScopes('["", 3]')).toThrow(/IMS_OAUTH_S2S_SCOPES has no scopes/)
})

test('run() passes JSON-array scopes to the token call as separate scopes', async () => {
  mockDb = fakeDb()
  mockAuth.mockClear()
  await run({ ...env, IMS_OAUTH_S2S_SCOPES: '["AdobeID","openid","adobeio.abdata.read"]' })
  expect(mockAuth.mock.calls[0][0].scopes).toEqual(['AdobeID', 'openid', 'adobeio.abdata.read'])
})

test('run() needs AIO_RUNTIME_NAMESPACE, because the hook has no __OW_NAMESPACE', async () => {
  mockDb = fakeDb()
  const { AIO_RUNTIME_NAMESPACE, ...rest } = env
  await expect(run(rest)).rejects.toThrow('AIO_RUNTIME_NAMESPACE')
  expect(mockDb.calls.init).toEqual([])
})

test('run() closes the client even when creating an index fails', async () => {
  mockDb = fakeDb(new Map(), { failOn: ['createIndex'] })
  await expect(run(env)).rejects.toThrow('createIndex failed')
  expect(mockDb.calls.close).toBe(1)
})
