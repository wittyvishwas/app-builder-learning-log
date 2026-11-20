/*
 * Test helper for the Ep 8 run, not part of the order-sync design: fake review and stock sources for API Mesh, as a
 * public web action, so a real-workspace run has something to batch against and count calls on. Test workspaces only.
 * It deploys with every `aio app deploy`, Production workspaces too.
 *
 * Source routes (answer shapes follow the mesh's reviews schema):
 *   GET /reviews?skus=...  array of arrays, one inner array per SKU, in order (the batched source)
 *   GET /stock?skus=...    array with one object per SKU, in order
 *   GET /review?sku=...    flat array with one review (the one-SKU source)
 * Control routes:
 *   POST /config           replaces the whole stored config of one route: { route, cacheControl?, mode?, delayMs? }
 *   GET /calls?since=<ms>  call records with at >= since; DELETE /calls removes them all
 *
 * The URL is public, so every request needs header `x-mm-key: <FAKE_REVIEWS_API_KEY>`. An unset, empty or short
 * (< 16 characters) key refuses everything. Keys are compared as SHA-256 digests with crypto.timingSafeEqual.
 * Logs carry only route, call id, SKU count and mode, never the key or headers.
 *
 * `raw-http: true` in app.config.yaml gives the action the unparsed query string (__ow_query), which it parses itself
 * (the mesh may send the SKUs as a JSON array, a JS literal, repeated parameters or a comma list). POST bodies arrive
 * base64 encoded in __ow_body. `final: true` stops a caller overriding FAKE_REVIEWS_API_KEY: keep that annotation.
 */
const crypto = require('crypto')
const stateLib = require('@adobe/aio-lib-state')
const { Core } = require('@adobe/aio-sdk')

const MIN_KEY_LENGTH = 16
const TTL_SECONDS = 86400
const MAX_DELAY_MS = 55000
const DEFAULT_CONFIG = { cacheControl: 'no-store', mode: 'ok', delayMs: 0 }
const MODES = {
  reviews: ['ok', 'http500', 'slow', 'badjson', 'reverse', 'short', 'badschema'],
  stock: ['ok', 'http500', 'slow', 'badjson', 'reverse', 'short'],
  review: ['ok', 'http500', 'slow', 'badjson', 'badschema']
}
const CALL_PREFIX = 'fake-reviews.call.'
const configKey = route => `fake-reviews.config.${route}`
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// Answers of the control routes, errors and 401: never cacheable, so the Runtime gateway never caches them.
const reply = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body
})

const digest = s => crypto.createHash('sha256').update(String(s)).digest()

function authorized (params) {
  const key = params.FAKE_REVIEWS_API_KEY
  if (typeof key !== 'string' || key.length < MIN_KEY_LENGTH) return false
  const header = (params.__ow_headers || {})['x-mm-key']
  if (typeof header !== 'string') return false
  return crypto.timingSafeEqual(digest(header), digest(key))
}

/*
 * Reads the SKUs named `name` from a raw query string. Returns { skus, parseForm }, where parseForm is one of
 * repeat, json, js-literal, comma, single or unparsed (skus is [] then).
 */
function parseSkus (rawQuery, name) {
  const values = []
  try {
    for (const pair of String(rawQuery || '').replace(/^\?/, '').split('&')) {
      if (!pair) continue
      const i = pair.indexOf('=')
      const k = decodeURIComponent((i < 0 ? pair : pair.slice(0, i)).replace(/\+/g, ' '))
      if (k !== name) continue
      values.push(decodeURIComponent((i < 0 ? '' : pair.slice(i + 1)).replace(/\+/g, ' ')))
    }
  } catch (e) {
    return { skus: [], parseForm: 'unparsed' }
  }
  if (values.length > 1) return { skus: values, parseForm: 'repeat' }
  if (values.length === 1 && values[0] !== '') {
    const v = values[0]
    if (v.startsWith('[')) {
      for (const [text, parseForm] of [[v, 'json'], [v.replace(/'/g, '"'), 'js-literal']]) {
        try {
          const parsed = JSON.parse(text)
          if (Array.isArray(parsed) && parsed.every(s => typeof s === 'string')) return { skus: parsed, parseForm }
        } catch (e) { /* try the next form */ }
      }
    } else if (v.includes(',')) {
      return { skus: v.split(',').map(s => s.trim()), parseForm: 'comma' }
    } else {
      return { skus: [v], parseForm: 'single' }
    }
  }
  return { skus: [], parseForm: 'unparsed' }
}

const review = (sku, callId) => ({
  sku,
  rating: 1 + ([...sku].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 5),
  title: 'MMTEST review',
  author: 'mmtest',
  body: `call ${callId}`
})

function sourceBody (route, mode, skus, callId) {
  let body
  if (route === 'reviews') body = skus.map(sku => [review(sku, callId)])
  else if (route === 'stock') body = skus.map(sku => ({ sku, qty: 7, callId }))
  else body = skus.map(sku => review(sku, callId))
  if (mode === 'reverse') body = body.reverse()
  if (mode === 'short') body = body.slice(0, -1)
  if (mode === 'badschema') {
    const bad = r => { const { sku, ...rest } = r; return { ...rest, rating: 7 } } // eslint-disable-line no-unused-vars
    body = route === 'reviews' ? body.map(inner => inner.map(bad)) : body.map(bad)
  }
  return body
}

function validConfig (b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return 'body must be a JSON object'
  if (!Object.keys(MODES).includes(b.route)) return 'route must be reviews, stock or review'
  const cc = 'cacheControl' in b ? b.cacheControl : DEFAULT_CONFIG.cacheControl
  if (cc !== null && !(typeof cc === 'string' && /^[\x20-\x7e]{1,200}$/.test(cc))) return 'cacheControl must be null or 1-200 printable ASCII characters'
  const mode = 'mode' in b ? b.mode : DEFAULT_CONFIG.mode
  if (!MODES[b.route].includes(mode)) return `mode ${JSON.stringify(mode)} is not supported by route ${b.route}`
  const delayMs = 'delayMs' in b ? b.delayMs : DEFAULT_CONFIG.delayMs
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > MAX_DELAY_MS) return `delayMs must be an integer from 0 to ${MAX_DELAY_MS}`
  return null
}

function readBody (params) {
  const raw = params.__ow_body
  if (typeof raw !== 'string' || raw === '') return undefined
  for (const text of [Buffer.from(raw, 'base64').toString('utf8'), raw]) {
    try { return JSON.parse(text) } catch (e) { /* try the next reading */ }
  }
  return undefined
}

async function sourceRequest (route, params, logger) {
  const rawQuery = String(params.__ow_query || '')
  const { skus, parseForm } = parseSkus(rawQuery, route === 'review' ? 'sku' : 'skus')
  const at = Date.now()
  const callId = `${at}-${crypto.randomBytes(3).toString('hex')}`

  // A State failure must not fail the answer: fall back to the default config and carry on.
  let state = null
  let config = { ...DEFAULT_CONFIG }
  try {
    state = await stateLib.init()
    const found = await state.get(configKey(route))
    if (found) config = { ...DEFAULT_CONFIG, ...JSON.parse(found.value) }
  } catch (e) {
    logger.error(`${route}: reading config failed (${e.code || e.name})`)
  }

  if (state) {
    const record = {
      callId,
      at,
      route,
      rawQuery: rawQuery.slice(0, 3000),
      skus,
      parseForm,
      mode: config.mode,
      cacheControlSent: config.cacheControl,
      delayMs: config.delayMs,
      userAgent: (params.__ow_headers || {})['user-agent'] || null
    }
    try {
      await state.put(`${CALL_PREFIX}${route}.${callId}`, JSON.stringify(record), { ttl: TTL_SECONDS })
    } catch (e) {
      logger.error(`${route} ${callId}: recording failed (${e.code || e.name})`)
    }
  }
  logger.info(`${route} ${callId}: ${skus.length} SKUs, mode ${config.mode}`)

  if (config.mode === 'slow') await sleep(config.delayMs)

  const headers = { 'Content-Type': 'application/json', 'X-MM-Call-Id': callId }
  if (typeof config.cacheControl === 'string') headers['Cache-Control'] = config.cacheControl
  if (config.mode === 'http500') return { statusCode: 500, headers, body: JSON.stringify({ error: 'mmtest failure' }) }
  if (config.mode === 'badjson') return { statusCode: 200, headers, body: 'not json {' }
  return { statusCode: 200, headers, body: JSON.stringify(sourceBody(route, config.mode, skus, callId)) }
}

async function main (params) {
  const logger = Core.Logger('fake-reviews', { level: params.LOG_LEVEL || 'info' })
  if (!authorized(params)) return reply(401, { error: 'unauthorized' })

  const method = String(params.__ow_method || '').toLowerCase()
  const path = String(params.__ow_path || '').replace(/\/$/, '')

  if (method === 'get' && ['/reviews', '/stock', '/review'].includes(path)) return sourceRequest(path.slice(1), params, logger)

  const control = (method === 'post' && path === '/config') || (path === '/calls' && (method === 'get' || method === 'delete'))
  if (!control) return reply(404, { error: 'not found' })

  if (path === '/config') {
    const body = readBody(params)
    const problem = validConfig(body)
    if (problem) return reply(400, { error: problem })
    const stored = {
      route: body.route,
      cacheControl: 'cacheControl' in body ? body.cacheControl : DEFAULT_CONFIG.cacheControl,
      mode: 'mode' in body ? body.mode : DEFAULT_CONFIG.mode,
      delayMs: 'delayMs' in body ? body.delayMs : DEFAULT_CONFIG.delayMs
    }
    try {
      const state = await stateLib.init()
      await state.put(configKey(body.route), JSON.stringify(stored), { ttl: TTL_SECONDS })
    } catch (e) {
      logger.error(`config ${body.route}: storage failed (${e.code || e.name})`)
      return reply(503, { error: 'storage unavailable' })
    }
    return reply(200, stored)
  }

  try {
    const state = await stateLib.init()
    const keys = []
    for await (const page of state.list({ match: `${CALL_PREFIX}*` })) keys.push(...page.keys)
    const unique = [...new Set(keys)]
    if (method === 'delete') {
      for (const k of unique) await state.delete(k)
      return reply(200, { deleted: unique.length })
    }
    // raw-http: the query string is not parsed into params, so read `since` from __ow_query.
    const sinceRaw = parseSkus(params.__ow_query, 'since').skus[0]
    const since = Number.isFinite(Number(sinceRaw)) ? Number(sinceRaw) : 0
    const calls = []
    for (const k of unique) {
      // The key ends in `<route>.<at>-<hex>`: skip records older than `since` without reading them. A key without
      // a readable timestamp is read and checked by the record's own `at`.
      const keyAt = /\.(\d+)-[0-9a-f]+$/.exec(k)
      if (keyAt && Number(keyAt[1]) < since) continue
      const found = await state.get(k)
      if (!found) continue
      const call = JSON.parse(found.value)
      if (call.at >= since) calls.push(call)
    }
    calls.sort((a, b) => a.at - b.at)
    return reply(200, { count: calls.length, calls })
  } catch (e) {
    logger.error(`calls: storage failed (${e.code || e.name})`)
    return reply(503, { error: 'storage unavailable' })
  }
}

module.exports = { main, parseSkus }
