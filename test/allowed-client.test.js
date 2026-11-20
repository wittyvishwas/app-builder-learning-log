/*
 * Unit tests for the Admin UI actions' client_id allowlist (src/commerce-backend-ui-1/actions/allowed-client.js).
 */
const { checkClient, clientIdOf } = require('../src/commerce-backend-ui-1/actions/allowed-client')
const { tokenFor, authed } = require('./helpers')

const withHeader = (authorization, extra = {}) => ({ ALLOWED_CLIENT_IDS: 'client-a', __ow_headers: { authorization }, ...extra })

test('an allowed client passes (null: nothing to return)', () => {
  expect(checkClient(authed('client-a'))).toBeNull()
})

test('the allowlist is comma-separated and trimmed, and the match is exact', () => {
  const list = ' client-a , client-b,,'
  expect(checkClient(authed('client-b', { ALLOWED_CLIENT_IDS: list }))).toBeNull()
  expect(checkClient(authed('client-a', { ALLOWED_CLIENT_IDS: list }))).toBeNull()
  expect(checkClient(authed('client', { ALLOWED_CLIENT_IDS: list })).statusCode).toBe(403)
  expect(checkClient(authed('CLIENT-A', { ALLOWED_CLIENT_IDS: list })).statusCode).toBe(403)
})

test('another client is refused with 403', () => {
  expect(checkClient(authed('client-x'))).toEqual({ statusCode: 403, body: { error: 'forbidden' } })
})

test('an unset, empty or blank allowlist refuses everyone with a 500 config error (fail closed)', () => {
  for (const v of [undefined, '', ' , ,']) {
    expect(checkClient(authed('client-a', { ALLOWED_CLIENT_IDS: v }))).toEqual({ statusCode: 500, body: { error: 'ALLOWED_CLIENT_IDS is not set' } })
  }
})

test('a missing or garbled token is refused with 401', () => {
  const good = tokenFor({ client_id: 'client-a' })
  const bad = [
    {}, // no headers at all
    { ALLOWED_CLIENT_IDS: 'client-a', __ow_headers: {} },
    withHeader(undefined),
    withHeader(''),
    withHeader('Bearer'),
    withHeader(`Basic ${good}`),
    withHeader(good), // no Bearer scheme
    withHeader('Bearer not-a-jwt'),
    withHeader('Bearer a.b.c'), // payload is not JSON
    withHeader(`Bearer a.${Buffer.from('[1]').toString('base64url')}.c`), // JSON without a client_id
    withHeader(`Bearer ${tokenFor({ client_id: 42 })}`),
    withHeader(`Bearer ${tokenFor({ client_id: '' })}`),
    withHeader(`Bearer ${tokenFor({ sub: 'someone' })}`),
    withHeader(`Bearer a.${Buffer.from('null').toString('base64url')}.c`),
    withHeader(`Bearer ${good}.extra`)
  ]
  for (const p of bad) expect(checkClient(p)).toEqual({ statusCode: 401, body: { error: 'unauthorized' } })
})

test('a missing token is 401 even when the allowlist is empty (the caller is not told about the config)', () => {
  expect(checkClient({}).statusCode).toBe(401)
})

test('the scheme is case-insensitive and clientIdOf returns the claim', () => {
  const t = tokenFor({ client_id: 'client-a', other: 1 })
  expect(clientIdOf(withHeader(`bearer ${t}`))).toBe('client-a')
  expect(clientIdOf({})).toBeNull()
})

test('a refusal is logged at warn level with the client_id and never the token', () => {
  const warns = []
  const logger = { warn: m => warns.push(m) }

  const other = authed('client-x')
  expect(checkClient(other, logger).statusCode).toBe(403)
  const unset = authed('client-y', { ALLOWED_CLIENT_IDS: '' })
  expect(checkClient(unset, logger).statusCode).toBe(500)
  expect(checkClient(authed('client-a'), logger)).toBeNull()
  expect(checkClient({}, logger).statusCode).toBe(401)

  expect(warns).toEqual(['client client-x not allowed', 'ALLOWED_CLIENT_IDS is not set (caller client client-y)'])
  for (const p of [other, unset]) {
    const token = p.__ow_headers.authorization.replace(/^Bearer\s+/i, '')
    for (const m of warns) expect(m).not.toContain(token)
  }
})
