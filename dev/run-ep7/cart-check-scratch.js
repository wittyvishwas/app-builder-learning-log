/*
 * Ep 7 run only: a scratch copy of webhooks/cart-check for timing and failure tests. Deployed by hand
 * (dev/run-ep7/README.md), never added to app.config.yaml, never part of the ep7 tag. Delete it after the run.
 *
 * It answers like cart-check ({ op: 'success' } or { op: 'exception', message }) with the same restricted-SKU rule
 * (the RESTRICTED_SKUS param). It does NOT check the signature: the URL is public, so use it with test SKUs only
 * (the MMTEST- rule in the webhooks.xml variants) and remove it afterwards. No dependencies: a single file works
 * with `aio rt action create`.
 *
 * MODE: normal | sleep3s (wait 3 s, then answer normally) | invalid-json (200, text/plain, a body that is not JSON) | http500.
 */
const BLOCKED_MESSAGE = "This item can't be added to your cart."
const SLEEP_MS = 3000

const reply = (body, statusCode = 200, type = 'application/json') => ({ statusCode, headers: { 'Content-Type': type }, body })
const json = op => reply(JSON.stringify(op))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// With `--web raw`, __ow_body is the JSON text or its base64 encoding (cart-check handles both the same way).
function readSku (params) {
  let body = params.__ow_body
  if (Buffer.isBuffer(body)) body = body.toString('utf8')
  if (typeof body !== 'string' || body === '') return params.product?.sku
  if (!/^\s*[{[]/.test(body)) body = Buffer.from(body, 'base64').toString('utf8')
  try { return JSON.parse(body)?.product?.sku } catch (e) { return undefined }
}

function isAllowed (sku, restricted = '') {
  return !String(restricted).split(',').map(s => s.trim()).filter(Boolean).includes(sku)
}

async function main (params) {
  const mode = params.MODE || 'normal'
  console.log(`cart-check-scratch: mode ${mode}`)
  if (mode === 'http500') return reply(JSON.stringify({ error: 'scratch failure' }), 500)
  if (mode === 'invalid-json') return reply('this is not json {', 200, 'text/plain')
  if (mode === 'sleep3s') await sleep(SLEEP_MS)
  else if (mode !== 'normal') return reply(JSON.stringify({ error: `unknown MODE ${mode}` }), 500)

  const sku = readSku(params)
  if (typeof sku !== 'string' || sku === '') return json({ op: 'exception' })
  if (!isAllowed(sku, params.RESTRICTED_SKUS)) return json({ op: 'exception', message: BLOCKED_MESSAGE })
  return json({ op: 'success' })
}

exports.main = main
