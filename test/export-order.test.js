/*
 * Event handler + scheduled retry, end to end against fakes:
 * I/O Events payload in, ERP calls out, State bookkeeping checked.
 */
const mockStore = new Map()
jest.mock('@adobe/aio-lib-state', () => ({ init: async () => require('./helpers').fakeState(mockStore) }))
jest.mock('@adobe/aio-sdk', () => ({
  Core: { Logger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) }
}))
jest.mock('../actions/order-sync/erp', () => {
  const real = jest.requireActual('../actions/order-sync/erp')
  return { ...real, sendOrder: (o, opts) => real.sendOrder(o, { ...opts, baseDelayMs: 0 }) }
})

const { main } = require('../actions/export-order')
const { main: retry } = require('../actions/export-order-retry')
const { scriptedFetch, order } = require('./helpers')

const params = { ERP_API_URL: 'https://erp.example/api', ERP_API_KEY: 'k' }
const event = { ...params, event_id: 'e1', data: { value: order } }
const keys = () => [...mockStore.keys()].sort()

beforeEach(() => mockStore.clear())

test('400 when ERP settings are missing', async () => {
  const res = await main({ data: { value: order } })
  expect(res.error.statusCode).toBe(400)
})

test('exports the order from an I/O Events payload and records it', async () => {
  global.fetch = scriptedFetch([201])
  const res = await main(event)
  expect(res).toEqual({ statusCode: 200, body: { orderNumber: '000000201', outcome: 'exported' } })
  expect(keys()).toEqual(['order-sync.done.000000201'])
})

test('a redelivered event is skipped, not sent twice', async () => {
  global.fetch = scriptedFetch([201])
  await main(event)
  global.fetch = scriptedFetch([201])
  const res = await main(event)
  expect(res.body.outcome).toBe('skipped')
  expect(global.fetch).not.toHaveBeenCalled()
})

test('an event without an order is acknowledged and ignored (no redelivery loop)', async () => {
  global.fetch = scriptedFetch([201])
  const res = await main({ ...params, data: { value: {} } })
  expect(res.statusCode).toBe(200)
  expect(res.body.outcome).toBe('ignored')
  expect(global.fetch).not.toHaveBeenCalled()
})

test('ERP down: queued for retry, then the scheduled run exports it', async () => {
  global.fetch = scriptedFetch([503])
  expect((await main(event)).body.outcome).toBe('queued')
  expect(keys()).toEqual(['order-sync.retry.000000201'])
  expect(JSON.parse(mockStore.get('order-sync.retry.000000201'))).toMatchObject({ runs: 1, lastError: expect.stringContaining('503') })

  global.fetch = scriptedFetch([201])
  const res = await retry(params)
  expect(res.body).toEqual({ exported: 1, skipped: 0, queued: 0, dead: 0 })
  expect(keys()).toEqual(['order-sync.done.000000201'])
})

test('permanent ERP rejection goes straight to the dead-letter list', async () => {
  global.fetch = scriptedFetch([422])
  expect((await main(event)).body.outcome).toBe('dead')
  expect(keys()).toEqual(['order-sync.dead.000000201'])
})

test('after the last scheduled run a still-failing order goes to dead-letter', async () => {
  global.fetch = scriptedFetch([503])
  await main(event)
  for (let i = 0; i < 5; i++) await retry(params)
  expect(keys()).toEqual(['order-sync.dead.000000201'])
  expect(JSON.parse(mockStore.get('order-sync.dead.000000201')).runs).toBe(6)
})

test('order numbers with unusual characters make valid State keys', async () => {
  global.fetch = scriptedFetch([201])
  await main({ ...params, data: { value: { ...order, increment_id: 'WEB/2027#7' } } })
  expect(keys()).toEqual(['order-sync.done.WEB_2027_7'])
})
