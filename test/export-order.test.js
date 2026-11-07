/*
 * Event handler + scheduled retry, end to end against fakes:
 * I/O Events payload in, ERP calls out, State bookkeeping checked.
 */
let mockDb
const mockStore = new Map()
const mockLogs = []
const mockFailPut = { on: false }
jest.mock('@adobe/aio-lib-db', () => ({ init: (...a) => mockDb.init(...a) }))
jest.mock('@adobe/aio-lib-state', () => ({
  init: async () => {
    const s = require('./helpers').fakeState(mockStore)
    if (mockFailPut.on) s.put = async () => { throw new Error('state unavailable') }
    return s
  }
}))
jest.mock('@adobe/aio-sdk', () => {
  const log = level => (...a) => mockLogs.push({ level, args: a })
  return {
    Core: {
      Logger: () => ({ info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') }),
      AuthClient: { generateAccessToken: async () => ({ access_token: 'tok-123' }) }
    }
  }
})
jest.mock('../actions/order-sync/erp', () => {
  const real = jest.requireActual('../actions/order-sync/erp')
  return { ...real, sendOrder: (o, opts) => real.sendOrder(o, { ...opts, baseDelayMs: 0 }) }
})

const { main } = require('../actions/export-order')
const { main: retry } = require('../actions/export-order-retry')
const { main: placed } = require('../actions/order-placed')
const { scriptedFetch, order, fakeDb } = require('./helpers')

const params = { ERP_API_URL: 'https://erp.example/api', ERP_API_KEY: 'k' }
const event = { ...params, event_id: 'e1', data: { value: order } }
const rows = () => mockDb.data.get('export_runs') || []
const row = n => rows().find(r => r.order === n)

beforeEach(() => {
  mockDb = fakeDb()
  mockStore.clear()
  mockLogs.length = 0
  mockFailPut.on = false
})

test('400 when ERP settings are missing', async () => {
  const res = await main({ data: { value: order } })
  expect(res.error.statusCode).toBe(400)
})

test('exports the order from an I/O Events payload and records one sent row, like Ep 6', async () => {
  global.fetch = scriptedFetch([201])
  const res = await main(event)
  expect(res).toEqual({ statusCode: 200, body: { orderNumber: '000000201', outcome: 'exported' } })
  expect(rows()).toHaveLength(1)
  expect(Object.keys(row('000000201')).sort()).toEqual(['at', 'order', 'status'])
  expect(row('000000201').status).toBe('sent')
  expect(mockDb.calls.init).toEqual([{ token: 'tok-123', region: 'emea' }])
  expect(mockDb.calls.close).toBe(1)
})

test('a redelivered event is skipped, not sent twice', async () => {
  global.fetch = scriptedFetch([201])
  await main(event)
  global.fetch = scriptedFetch([201])
  const res = await main(event)
  expect(res.body.outcome).toBe('skipped')
  expect(global.fetch).not.toHaveBeenCalled()
  expect(rows()).toHaveLength(1)
})

test('an event without an order is acknowledged and ignored (no redelivery loop)', async () => {
  global.fetch = scriptedFetch([201])
  const res = await main({ ...params, data: { value: {} } })
  expect(res.statusCode).toBe(200)
  expect(res.body.outcome).toBe('ignored')
  expect(global.fetch).not.toHaveBeenCalled()
  expect(mockDb.calls.init).toHaveLength(0)
})

test('ERP down: queued for retry, then the scheduled run exports it', async () => {
  global.fetch = scriptedFetch([503])
  expect((await main(event)).body.outcome).toBe('queued')
  expect(rows()).toHaveLength(1)
  expect(row('000000201')).toMatchObject({ status: 'retry', attempts: 1, httpStatus: 503, lastError: 'ERP returned 503' })
  expect(new Date(row('000000201').nextAt).toISOString()).toBe(row('000000201').nextAt)
  // The retry row holds the mapped order, complete, because it has to be resent as is.
  expect(row('000000201').mapped).toMatchObject({ orderNumber: '000000201', customer: { email: 'jane@example.com' } })

  global.fetch = scriptedFetch([201])
  const res = await retry(params)
  expect(res.body).toEqual({ exported: 1, skipped: 0, queued: 0, dead: 0, left: 0 })
  expect(rows()).toHaveLength(1)
  expect(row('000000201').status).toBe('sent')
  // The sent row no longer carries the order or a schedule.
  expect(row('000000201').mapped).toBeNull()
  expect(row('000000201').nextAt).toBeNull()
  expect(JSON.stringify(rows())).not.toContain('jane')
})

test('permanent ERP rejection goes straight to a dead row', async () => {
  global.fetch = scriptedFetch([422])
  expect((await main(event)).body.outcome).toBe('dead')
  expect(rows()).toHaveLength(1)
  expect(row('000000201')).toMatchObject({ status: 'dead', attempts: 1, httpStatus: 422 })
})

test('after the last scheduled run a still-failing order goes dead, still one row', async () => {
  global.fetch = scriptedFetch([503])
  await main(event)
  for (let i = 0; i < 5; i++) await retry(params)
  expect(rows()).toHaveLength(1)
  expect(row('000000201')).toMatchObject({ status: 'dead', attempts: 6 })
})

test('one row per order across sent, retry and dead transitions', async () => {
  global.fetch = scriptedFetch([503])
  await main(event)
  expect(rows().map(r => r.status)).toEqual(['retry'])
  await retry(params) // attempt 2, still failing: same row updated
  expect(rows()).toHaveLength(1)
  expect(row('000000201').attempts).toBe(2)
  for (let i = 0; i < 4; i++) await retry(params)
  expect(rows().map(r => r.status)).toEqual(['dead'])
  // A redelivery of an order that is dead is tried again and, if it gets through, the same row becomes sent.
  global.fetch = scriptedFetch([201])
  expect((await main(event)).body.outcome).toBe('exported')
  expect(rows().map(r => r.status)).toEqual(['sent'])
  expect(row('000000201')).toMatchObject({ mapped: null, nextAt: null })
  expect(row('000000201').lines).toBeDefined() // history from the dead row stays; it has no personal data
  expect(JSON.stringify(rows())).not.toContain('jane')
})

test('order numbers with unusual characters are stored as they are, one row', async () => {
  global.fetch = scriptedFetch([201])
  await main({ ...params, data: { value: { ...order, increment_id: 'WEB/2027#7' } } })
  expect(rows()).toHaveLength(1)
  expect(row('WEB/2027#7').status).toBe('sent')
})

test('retry and dead rows: the dead row has no customer or address data; the retry row clears its order once settled', async () => {
  global.fetch = jest.fn(async () => ({ ok: false, status: 422, text: async () => 'invalid email jane@example.com' }))
  await main(event)
  const dead = row('000000201')
  expect(dead).toMatchObject({ status: 'dead', attempts: 1, httpStatus: 422, lastError: 'ERP returned 422' })
  expect(Object.keys(dead).sort()).toEqual(['at', 'attempts', 'httpStatus', 'lastError', 'lines', 'order', 'status', 'totals'])
  expect(JSON.stringify(dead)).not.toContain('jane')
  expect(JSON.stringify(dead)).not.toContain('Berlin')
  expect(dead.customer).toBeUndefined()
  expect(dead.mapped).toBeUndefined()
  expect(dead.lines).toHaveLength(2)
  expect(dead.totals).toEqual({ currency: 'EUR', total: 119.9, shippingAmount: 5, taxAmount: 19.14 })

  // Retry then dead: the mapped order (customer, addresses) is gone from the row.
  mockDb = fakeDb()
  global.fetch = scriptedFetch([503, 503, 503, 503, 422])
  await main(event)
  expect(row('000000201').mapped.customer.email).toBe('jane@example.com')
  for (let i = 0; i < 5; i++) await retry(params)
  expect(row('000000201').status).toBe('dead')
  expect(row('000000201').mapped).toBeNull()
  expect(JSON.stringify(rows())).not.toContain('jane')
  expect(JSON.stringify(rows())).not.toContain('Berlin')
})

test('a bare order works for a manual invocation', async () => {
  global.fetch = scriptedFetch([201])
  const res = await main({ ...params, ...order })
  expect(res.body).toEqual({ orderNumber: '000000201', outcome: 'exported' })
})

test('if Database Storage cannot record anything, the handler fails so I/O Events redelivers, and still closes', async () => {
  global.fetch = scriptedFetch([201])
  mockDb = fakeDb(new Map(), { failOn: ['updateMany', 'insertOne'] })
  const res = await main(event)
  expect(res.error.statusCode).toBe(500)
  expect(mockDb.calls.close).toBe(1)
})

test('a failed token or connection is a 500, not a crash', async () => {
  mockDb = fakeDb(new Map(), { failOn: ['connect'] })
  expect((await main(event)).error.statusCode).toBe(500)
  expect((await retry(params)).error.statusCode).toBe(500)
  expect(mockStore.has('order-sync.lock.retry')).toBe(false) // the lock is released
})

test('the retry run tries each order once: the schedule is the backoff', async () => {
  global.fetch = scriptedFetch([503])
  await main(event)
  global.fetch = scriptedFetch([503])
  const res = await retry(params)
  expect(global.fetch).toHaveBeenCalledTimes(1)
  expect(res.body.queued).toBe(1)
  expect(row('000000201').attempts).toBe(2)
})

test('the retry run picks only due rows, oldest first', async () => {
  global.fetch = scriptedFetch([503])
  for (const n of ['301', '302', '303']) await main({ ...params, data: { value: { ...order, increment_id: n } } })
  const future = new Date(Date.now() + 3600000).toISOString()
  rows().find(r => r.order === '301').nextAt = '2020-01-01T00:00:03.000Z'
  rows().find(r => r.order === '302').nextAt = '2020-01-01T00:00:01.000Z'
  rows().find(r => r.order === '303').nextAt = future // not due yet
  global.fetch = scriptedFetch([201])
  const res = await retry({ ...params, MAX_PER_RUN: 1 })
  expect(res.body).toMatchObject({ exported: 1, left: 1 }) // 302 (the oldest) went; 301 waits; 303 is not due, so not counted
  expect(row('302').status).toBe('sent')
  expect(row('301').status).toBe('retry')
})

test('a retry run is skipped while another holds the lock', async () => {
  global.fetch = scriptedFetch([503])
  await main(event)
  mockStore.set('order-sync.lock.retry', '1')
  global.fetch = scriptedFetch([201])
  expect((await retry(params)).body).toEqual({ skipped: true })
  expect(global.fetch).not.toHaveBeenCalled()
  mockStore.delete('order-sync.lock.retry')
  await retry(params)
  expect(mockStore.has('order-sync.lock.retry')).toBe(false)
})

test('State keeps only the retry lock', async () => {
  global.fetch = scriptedFetch([503])
  await main(event)
  await retry(params)
  expect([...mockStore.keys()]).toEqual([]) // the lock is released; nothing else was ever written
})

test('the retry run stops at MAX_PER_RUN and on its time budget, and reports what is left', async () => {
  global.fetch = scriptedFetch([503])
  for (const n of ['301', '302', '303']) await main({ ...params, data: { value: { ...order, increment_id: n } } })
  global.fetch = scriptedFetch([201])
  expect((await retry({ ...params, MAX_PER_RUN: 1 })).body).toMatchObject({ exported: 1, left: 2 })

  const realNow = Date.now
  let t = realNow()
  Date.now = () => (t += 200000) // every check jumps 200 s: the budget runs out after one order
  try {
    expect((await retry(params)).body).toMatchObject({ exported: 1, left: 1 })
  } finally { Date.now = realNow }
})

test('order-placed (Ep 6, claims) and export-order: one direction is seen, the other relies on the ERP key', async () => {
  global.fetch = scriptedFetch([200])
  const ep6 = { ...params, data: { value: { increment_id: '000000201', grand_total: '119.9' } } }
  // order-placed writes first: its sent row makes export-order skip.
  expect((await placed(ep6)).body).toEqual({ sent: '000000201' })
  global.fetch = scriptedFetch([201])
  expect((await main(event)).body.outcome).toBe('skipped')
  expect(global.fetch).not.toHaveBeenCalled()
  // export-order writes first: order-placed looks only at its own claims, so it sends again and the ERP's
  // Idempotency-Key makes that a 409. This is why only one of the two is registered for the event.
  mockDb = fakeDb()
  global.fetch = scriptedFetch([201])
  await main({ ...params, data: { value: { ...order, increment_id: '000000202' } } })
  global.fetch = scriptedFetch([409])
  expect((await placed({ ...params, data: { value: { increment_id: '000000202', grand_total: '1' } } })).body).toEqual({ sent: '000000202' })
  expect(global.fetch.mock.calls[0][1].headers['Idempotency-Key']).toBe('000000202')
  // Its sent row is an upsert, so export-order's row for the order stays the only one.
  expect(mockDb.data.get('export_runs').filter(r => r.order === '000000202' && r.status === 'sent')).toHaveLength(1)
})

test('the logger never receives an ERP body or an error object', async () => {
  const body = 'echo: jane@example.com 1 Main St Berlin'
  global.fetch = jest.fn(async () => ({ ok: false, status: 422, text: async () => body }))
  await main(event)
  global.fetch = jest.fn(async () => ({ ok: false, status: 503, text: async () => body }))
  await main({ ...event, data: { value: { ...order, increment_id: '000000202' } } })
  await retry(params)
  mockDb = fakeDb(new Map(), { failOn: ['updateOne'] })
  await main({ ...event, data: { value: { ...order, increment_id: '000000203' } } })
  await retry(params)
  expect(mockLogs.length).toBeGreaterThan(0)
  for (const { args } of mockLogs) {
    for (const a of args) {
      expect(typeof a).toBe('string')
      expect(a).not.toContain('jane')
      expect(a).not.toContain('Berlin')
      expect(a).not.toContain('echo')
    }
  }
})

test('no TTL: a sent row older than 30 days still de-dups', async () => {
  mockDb = fakeDb(new Map([['export_runs', [{ order: '000000201', status: 'sent', at: '2020-01-01T00:00:00.000Z' }]]]))
  global.fetch = scriptedFetch([201])
  expect((await main(event)).body.outcome).toBe('skipped')
  expect(global.fetch).not.toHaveBeenCalled()
})

test('a late transient failure never overwrites a sent row', async () => {
  const { connect } = require('../actions/order-sync/store')
  const { store, close } = await connect({})
  await store.markDone('000000201')
  expect(await store.putRetry('000000201', { mapped: { orderNumber: '000000201' }, attempts: 1, lastError: 'x', httpStatus: 503 })).toBe(false)
  expect(await store.putDead('000000201', { lines: [], totals: {}, attempts: 1, lastError: 'x', httpStatus: 422 })).toBe(false)
  await close()
  expect(rows()).toHaveLength(1)
  expect(row('000000201').status).toBe('sent')
})

test('a racing delivery that fails after another succeeded leaves the order sent', async () => {
  // The first delivery's POST is in flight while the second one succeeds and records sent.
  let release
  const gate = new Promise(resolve => { release = resolve })
  global.fetch = jest.fn(async () => { await gate; return { ok: false, status: 503, text: async () => '' } })
  const first = main(event)
  await new Promise(resolve => setImmediate(resolve))
  const seen = rows().length
  mockDb.data.set('export_runs', [{ order: '000000201', status: 'sent', at: new Date().toISOString() }])
  release()
  const res = await first
  expect(seen).toBe(0)
  expect(res.body.outcome).toBe('skipped')
  expect(rows().map(r => r.status)).toEqual(['sent'])
})

test('markDone settles every row for the order, and adds a sent row only when there was none', async () => {
  mockDb = fakeDb(new Map([['export_runs', [
    { order: '000000201', status: 'retry', attempts: 2, nextAt: '2020-01-01T00:00:00.000Z', mapped: { orderNumber: '000000201', customer: { email: 'jane@example.com' } }, at: '2020-01-01T00:00:00.000Z' },
    { order: '000000201', status: 'sent', at: '2020-01-01T00:00:00.000Z' }
  ]]]))
  const { connect } = require('../actions/order-sync/store')
  const { store, close } = await connect({})
  await store.markDone('000000201')
  await store.markDone('000000202')
  await close()
  expect(rows().filter(r => r.order === '000000201').map(r => r.status)).toEqual(['sent', 'sent'])
  expect(JSON.stringify(rows())).not.toContain('jane')
  expect(rows().filter(r => r.order === '000000202')).toHaveLength(1)
  expect(Object.keys(row('000000202')).sort()).toEqual(['at', 'order', 'status'])
})

test('a retry run that finds its order already sent settles the stray retry row', async () => {
  mockDb = fakeDb(new Map([['export_runs', [
    { order: '000000201', status: 'sent', at: '2020-01-01T00:00:00.000Z' },
    { order: '000000201', status: 'retry', attempts: 1, nextAt: '2020-01-01T00:00:00.000Z', mapped: { orderNumber: '000000201', customer: { email: 'jane@example.com' } }, at: '2020-01-01T00:00:00.000Z' }
  ]]]))
  global.fetch = scriptedFetch([201])
  expect((await retry(params)).body).toMatchObject({ skipped: 1, exported: 0 })
  expect(global.fetch).not.toHaveBeenCalled()
  expect(rows().map(r => r.status)).toEqual(['sent', 'sent'])
  expect(JSON.stringify(rows())).not.toContain('jane')
  expect((await retry(params)).body).toMatchObject({ skipped: 0 }) // nothing due any more
})

test('a retry row without a stored order goes dead, and the run continues', async () => {
  mockDb = fakeDb(new Map([['export_runs', [
    { order: '401', status: 'retry', attempts: 2, nextAt: '2020-01-01T00:00:01.000Z', mapped: null, at: '2020-01-01T00:00:00.000Z' },
    { order: '402', status: 'retry', attempts: 1, nextAt: '2020-01-01T00:00:02.000Z', mapped: 'garbage', at: '2020-01-01T00:00:00.000Z' },
    { order: '403', status: 'retry', attempts: 1, nextAt: '2020-01-01T00:00:03.000Z', mapped: { orderNumber: '403', lines: [] }, at: '2020-01-01T00:00:00.000Z' }
  ]]]))
  global.fetch = scriptedFetch([201])
  const res = await retry(params)
  expect(res.statusCode).toBe(200)
  expect(res.body).toMatchObject({ dead: 2, exported: 1 })
  expect(row('401')).toMatchObject({ status: 'dead', lastError: 'cannot resend: no stored order', mapped: null })
  expect(row('402').status).toBe('dead')
  expect(row('403').status).toBe('sent')
  expect(mockLogs.some(l => l.level === 'error' && l.args[0].includes('401'))).toBe(true)
})

test('an error on one row is logged and the run goes on; error only if nothing could be recorded', async () => {
  global.fetch = scriptedFetch([503])
  for (const n of ['301', '302']) await main({ ...params, data: { value: { ...order, increment_id: n } } })
  const data = mockDb.data
  // Every write fails: both rows error, so the run reports an error and the lock is released.
  mockDb = fakeDb(data, { failOn: ['updateMany', 'updateOne'] })
  global.fetch = scriptedFetch([201])
  expect((await retry(params)).error.statusCode).toBe(500)
  expect(mockStore.has('order-sync.lock.retry')).toBe(false)
})

test('markDone does not depend on the shape of updateMany\'s result', async () => {
  const wrap = coll => ({ ...coll, updateMany: async (...a) => { await coll.updateMany(...a); return {} } })
  const client = mockDb.client
  const orig = client.collection
  client.collection = name => wrap(orig(name))
  mockDb.data.set('export_runs', [{ order: '000000201', status: 'retry', attempts: 1, nextAt: '2020-01-01T00:00:00.000Z', mapped: { orderNumber: '000000201' }, at: '2020-01-01T00:00:00.000Z' }])
  const { connect } = require('../actions/order-sync/store')
  const { store, close } = await connect({})
  await store.markDone('000000201')
  await store.markDone('000000202')
  await close()
  expect(rows().filter(r => r.order === '000000201').map(r => r.status)).toEqual(['sent'])
  expect(rows().filter(r => r.order === '000000202').map(r => r.status)).toEqual(['sent'])
})
