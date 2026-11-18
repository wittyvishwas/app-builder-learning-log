/* Unit tests for the Ep 7 run's scratch action (dev/run-ep7/cart-check-scratch.js): every MODE. */
const { main } = require('../dev/run-ep7/cart-check-scratch')

const b64 = sku => Buffer.from(JSON.stringify({ product: { sku } })).toString('base64')
const call = (sku, extra = {}) => main({ RESTRICTED_SKUS: 'MMTEST-RESTRICTED-1, X', __ow_body: b64(sku), ...extra })
const op = r => JSON.parse(r.body)

beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => {}))
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks() })

test('normal: allowed SKU answers success, restricted SKU answers exception with the message', async () => {
  const ok = await call('MMTEST-OK-1')
  expect(ok.statusCode).toBe(200)
  expect(op(ok)).toEqual({ op: 'success' })
  expect(op(await call('MMTEST-RESTRICTED-1'))).toEqual({ op: 'exception', message: "This item can't be added to your cart." })
})

test('MODE defaults to normal and the body may be plain JSON text or already parsed', async () => {
  expect(op(await main({ __ow_body: JSON.stringify({ product: { sku: 'A' } }) }))).toEqual({ op: 'success' })
  expect(op(await main({ product: { sku: 'A' } }))).toEqual({ op: 'success' })
  expect(op(await main({ __ow_body: b64('') }))).toEqual({ op: 'exception' })
})

test('sleep3s: waits 3 s, then answers normally', async () => {
  jest.useFakeTimers()
  let done = false
  const p = call('MMTEST-RESTRICTED-1', { MODE: 'sleep3s' }).then(r => { done = true; return r })
  await jest.advanceTimersByTimeAsync(2999)
  expect(done).toBe(false)
  await jest.advanceTimersByTimeAsync(1)
  const r = await p
  expect(done).toBe(true)
  expect(op(r).op).toBe('exception')
  expect(op(r).message).toBeDefined()
})

test('invalid-json: answers 200 as text/plain with a body that is not JSON', async () => {
  const r = await call('MMTEST-OK-1', { MODE: 'invalid-json' })
  expect(r.statusCode).toBe(200)
  expect(r.headers['Content-Type']).toBe('text/plain')
  expect(() => JSON.parse(r.body)).toThrow()
})

test('http500: answers 500', async () => {
  const r = await call('MMTEST-OK-1', { MODE: 'http500' })
  expect(r.statusCode).toBe(500)
})

test('an unknown MODE answers 500 instead of passing silently', async () => {
  expect((await call('MMTEST-OK-1', { MODE: 'nope' })).statusCode).toBe(500)
})
