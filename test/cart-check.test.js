/*
 * Unit tests for the Ep 7 cart-check webhook. A real RSA key pair signs the bodies, so the signature check is the
 * real crypto.createVerify; only the logger is faked. This proves the logic, not a call from a real Commerce.
 */
const crypto = require('crypto')
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
jest.mock('@adobe/aio-sdk', () => ({ Core: { Logger: () => mockLog } }))

const { main, isAllowed } = require('../actions/cart-check')

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const pem = publicKey.export({ type: 'spki', format: 'pem' })
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })

// Commerce sends the field by its `name` ({ product: { sku } }); raw-http delivers __ow_body base64-encoded and
// the signature covers that base64 string, as in Adobe's App Builder sample.
const sign = (signed, key = privateKey) => crypto.createSign('SHA256').update(signed).sign(key, 'base64')
const json = sku => JSON.stringify({ product: { sku } })
const b64 = text => Buffer.from(text).toString('base64')
const bodyFor = sku => b64(json(sku))
const HEADER = 'x-adobe-commerce-webhook-signature'
const call = (body, { signature = sign(body), key = pem, headers, ...rest } = {}) => main({
  PUBLIC_KEY: key,
  RESTRICTED_SKUS: 'RESTRICTED-1, RESTRICTED-2',
  __ow_body: body,
  __ow_headers: headers || { [HEADER]: signature },
  ...rest
})
const result = async (...a) => { const r = await call(...a); return { status: r.statusCode, op: JSON.parse(r.body) } }
const NOT_CONFIGURED = { status: 500, op: { error: 'cart-check is not configured' } }

beforeEach(() => Object.values(mockLog).forEach(f => f.mockClear()))

test('a signed call for an allowed SKU answers success', async () => {
  expect(await result(bodyFor('SKU-OK'))).toEqual({ status: 200, op: { op: 'success' } })
})

test('a restricted SKU is blocked with the message', async () => {
  expect(await result(bodyFor('RESTRICTED-2'))).toEqual({
    status: 200,
    op: { op: 'exception', message: "This item can't be added to your cart." }
  })
})

test('a missing signature header is refused without a message', async () => {
  expect(await result(bodyFor('SKU-OK'), { headers: {} })).toEqual({ status: 200, op: { op: 'exception' } })
})

test('a missing __ow_headers is refused, not a crash', async () => {
  const r = await main({ PUBLIC_KEY: pem, __ow_body: bodyFor('SKU-OK') })
  expect(JSON.parse(r.body)).toEqual({ op: 'exception' })
})

test('a signature from another key is refused', async () => {
  const body = bodyFor('SKU-OK')
  expect(await result(body, { signature: sign(body, other.privateKey) })).toEqual({ status: 200, op: { op: 'exception' } })
})

test('a garbage signature is refused', async () => {
  expect(await result(bodyFor('SKU-OK'), { signature: 'not-a-signature' })).toEqual({ status: 200, op: { op: 'exception' } })
})

test('a tampered body with the signature of the original body is refused', async () => {
  const signature = sign(bodyFor('RESTRICTED-1'))
  // Someone swaps in an allowed SKU but keeps the header that was valid for the restricted one.
  expect(await result(bodyFor('SKU-OK'), { signature })).toEqual({ status: 200, op: { op: 'exception' } })
})

test('a JSON-text __ow_body is verified over its base64 encoding', async () => {
  const text = json('RESTRICTED-1')
  expect(await result(text, { signature: sign(b64(text)) })).toEqual({
    status: 200,
    op: { op: 'exception', message: "This item can't be added to your cart." }
  })
  expect(await result(json('SKU-OK'), { signature: sign(b64(json('SKU-OK'))) })).toEqual({ status: 200, op: { op: 'success' } })
})

test('a signature made over the decoded JSON instead of the base64 body is refused', async () => {
  expect(await result(bodyFor('SKU-OK'), { signature: sign(json('SKU-OK')) })).toEqual({ status: 200, op: { op: 'exception' } })
})

test('replies are JSON', async () => {
  expect((await call(bodyFor('SKU-OK'))).headers).toEqual({ 'Content-Type': 'application/json' })
  expect((await call(bodyFor('SKU-OK'), { key: '' })).headers).toEqual({ 'Content-Type': 'application/json' })
})

test('a PEM kept on one line in .env with escaped \\n works', async () => {
  const oneLine = pem.trim().replace(/\n/g, '\\n')
  expect(oneLine).not.toContain('\n')
  expect(await result(bodyFor('SKU-OK'), { key: oneLine })).toEqual({ status: 200, op: { op: 'success' } })
})

test('a missing, empty or unparseable PUBLIC_KEY answers 500 so the hook fails open, and logs why', async () => {
  for (const key of ['', null, 'not a key', '-----BEGIN PUBLIC KEY-----\\nabc\\n-----END PUBLIC KEY-----']) {
    mockLog.error.mockClear()
    expect(await result(bodyFor('SKU-OK'), { key })).toEqual(NOT_CONFIGURED)
    expect(mockLog.error).toHaveBeenCalledWith('PUBLIC_KEY missing or invalid')
  }
})

test('a signed payload without a SKU is refused without a message and logs a warning', async () => {
  const body = b64(JSON.stringify({ product: {} }))
  expect(await result(body)).toEqual({ status: 200, op: { op: 'exception' } })
  expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('sku'))
})

test('the old data.product.sku shape is not accepted', async () => {
  expect(await result(b64(JSON.stringify({ data: { product: { sku: 'SKU-OK' } } })))).toEqual({ status: 200, op: { op: 'exception' } })
})

test('signed non-JSON is refused', async () => {
  expect(await result(b64('{not json'))).toEqual({ status: 200, op: { op: 'exception' } })
})

test('isAllowed: comma list, trimmed, case-sensitive; empty list allows everything', () => {
  expect(isAllowed('A', 'A,B')).toBe(false)
  expect(isAllowed('B', ' A , B ')).toBe(false)
  expect(isAllowed('a', 'A,B')).toBe(true)
  expect(isAllowed('A', '')).toBe(true)
  expect(isAllowed('A', undefined)).toBe(true)
})

test('the logger never receives the body or the key', async () => {
  const marker = 'SECRET-SKU-MARKER'
  const body = bodyFor(marker)
  await call(body, { signature: sign(body, other.privateKey) }) // refused
  await call(body, { headers: {} }) // refused
  await call(body, { key: 'not a key' }) // key error path
  await call(bodyFor('RESTRICTED-1')) // blocked
  await call(bodyFor('SKU-OK')) // allowed
  await call(b64(JSON.stringify({ product: marker }))) // no sku
  const logged = JSON.stringify(Object.values(mockLog).flatMap(f => f.mock.calls))
  expect(logged).not.toContain(marker)
  expect(logged).not.toContain('BEGIN PUBLIC KEY')
  expect(logged).not.toContain(pem.split('\n')[1])
  expect(logged).not.toContain('not a key')
})
