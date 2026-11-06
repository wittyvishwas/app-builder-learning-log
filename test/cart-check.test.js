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

const sign = (body, key = privateKey) => crypto.createSign('SHA256').update(body).sign(key, 'base64')
const bodyFor = sku => JSON.stringify({ data: { product: { sku } } })
const HEADER = 'x-adobe-commerce-webhook-signature'
const call = (body, { signature = sign(body), key = pem, headers, ...rest } = {}) => main({
  PUBLIC_KEY: key,
  RESTRICTED_SKUS: 'RESTRICTED-1, RESTRICTED-2',
  __ow_body: body,
  __ow_headers: headers || { [HEADER]: signature },
  ...rest
})
const result = async (...a) => { const r = await call(...a); return { status: r.statusCode, op: JSON.parse(r.body) } }

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

test('a base64-encoded __ow_body is verified over the decoded bytes', async () => {
  const body = bodyFor('RESTRICTED-1')
  const encoded = Buffer.from(body).toString('base64')
  expect(await result(encoded, { signature: sign(body) })).toEqual({
    status: 200,
    op: { op: 'exception', message: "This item can't be added to your cart." }
  })
  const ok = bodyFor('SKU-OK')
  expect(await result(Buffer.from(ok).toString('base64'), { signature: sign(ok) })).toEqual({ status: 200, op: { op: 'success' } })
})

test('the signature covers the exact bytes: reformatted JSON does not verify', async () => {
  const body = bodyFor('SKU-OK')
  const pretty = JSON.stringify(JSON.parse(body), null, 2)
  expect(await result(pretty, { signature: sign(body) })).toEqual({ status: 200, op: { op: 'exception' } })
})

test('a PEM kept on one line in .env with escaped \\n works', async () => {
  const oneLine = pem.trim().replace(/\n/g, '\\n')
  expect(oneLine).not.toContain('\n')
  expect(await result(bodyFor('SKU-OK'), { key: oneLine })).toEqual({ status: 200, op: { op: 'success' } })
})

test('a missing PUBLIC_KEY or an invalid one refuses every call', async () => {
  expect(await result(bodyFor('SKU-OK'), { key: '' })).toEqual({ status: 200, op: { op: 'exception' } })
  expect(await result(bodyFor('SKU-OK'), { key: 'not a key' })).toEqual({ status: 200, op: { op: 'exception' } })
})

test('a signed payload without a SKU is refused without a message and logs a warning', async () => {
  const body = JSON.stringify({ data: { product: {} } })
  expect(await result(body)).toEqual({ status: 200, op: { op: 'exception' } })
  expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('sku'))
})

test('signed non-JSON is refused', async () => {
  expect(await result('{not json')).toEqual({ status: 200, op: { op: 'exception' } })
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
  await call(JSON.stringify({ data: marker })) // no sku
  const logged = JSON.stringify(Object.values(mockLog).flatMap(f => f.mock.calls))
  expect(logged).not.toContain(marker)
  expect(logged).not.toContain('BEGIN PUBLIC KEY')
  expect(logged).not.toContain(pem.split('\n')[1])
  expect(logged).not.toContain('not a key')
})
