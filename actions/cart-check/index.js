/*
 * Ep 7: replace a plugin with a webhook. Commerce calls this action from observer.checkout_cart_product_add_before
 * and waits for the answer: { op: 'success' } lets the item in, { op: 'exception' } stops it.
 *
 * The URL is public, so the call is verified first: Commerce signs the request and sends the signature (base64) in
 * x-adobe-commerce-webhook-signature. With `raw-http: true` (app.config.yaml) __ow_body arrives base64-encoded.
 * Adobe's App Builder sample verifies over that body as received, the base64 string, and only then decodes it
 * (JSON.parse(atob(params.__ow_body))); its Express sample verifies over Buffer.from(JSON.stringify(body)).toString('base64').
 * So: a base64 __ow_body is verified as-is; if it arrives as JSON text instead, it is verified over its base64
 * encoding. Either way the same body is then decoded and parsed. Not verified against a real Commerce yet.
 *
 * The hook's field is declared as name="product.sku", and `name` is the path Commerce sends, so the payload is
 * { product: { sku } } (the post's snippet reads data.product.sku, which is the `source` path inside Commerce).
 *
 * Answers: a missing or invalid signature gives 200 with { op: 'exception' } (a forged call is blocked). A missing or
 * unusable PUBLIC_KEY is our own misconfiguration, so it answers 500: required="false" in webhooks.xml then lets
 * Commerce fail open, whereas an `exception` would block every add-to-cart. A payload without a SKU is refused without
 * a message. Logs carry messages only, never the body or the key.
 */
const crypto = require('crypto')
const { Core } = require('@adobe/aio-sdk')

const SIGNATURE_HEADER = 'x-adobe-commerce-webhook-signature'
const BLOCKED_MESSAGE = "This item can't be added to your cart."

const reply = (op, statusCode = 200) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(op)
})

// Returns { signed, json }: the string the signature covers, and the JSON text of the body.
function readBody (body) {
  if (Buffer.isBuffer(body)) body = body.toString('utf8')
  if (typeof body !== 'string' || body === '') return null
  if (/^\s*[{[]/.test(body)) return { signed: Buffer.from(body, 'utf8').toString('base64'), json: body }
  return { signed: body, json: Buffer.from(body, 'base64').toString('utf8') }
}

// A PEM kept on one line in .env has literal "\n" sequences: turn them back into newlines.
const normalisePem = key => String(key).replace(/\\n/g, '\n')

function verifySignature (signed, signature, key) {
  const verifier = crypto.createVerify('SHA256')
  verifier.update(signed)
  return verifier.verify(key, signature, 'base64')
}

// Not allowed when the SKU is on the comma-separated RESTRICTED_SKUS list (trimmed, case-sensitive).
function isAllowed (sku, restricted = '') {
  const list = String(restricted).split(',').map(s => s.trim()).filter(Boolean)
  return !list.includes(sku)
}

async function main (params) {
  const logger = Core.Logger('cart-check', { level: params.LOG_LEVEL || 'info' })

  let key
  try {
    if (!params.PUBLIC_KEY) throw new Error('empty')
    key = crypto.createPublicKey(normalisePem(params.PUBLIC_KEY))
  } catch (e) {
    logger.error('PUBLIC_KEY missing or invalid')
    return reply({ error: 'cart-check is not configured' }, 500)
  }

  const signature = (params.__ow_headers || {})[SIGNATURE_HEADER]
  const body = readBody(params.__ow_body)
  if (!signature || !body) {
    logger.warn('request has no signature or no body: refused')
    return reply({ op: 'exception' })
  }
  let valid = false
  try {
    valid = verifySignature(body.signed, signature, key)
  } catch (e) {
    logger.warn(`signature check failed: ${e.message}`)
  }
  if (!valid) {
    logger.warn('signature does not match: refused')
    return reply({ op: 'exception' })
  }

  let payload
  try {
    payload = JSON.parse(body.json)
  } catch (e) {
    logger.warn('signed body is not valid JSON: refused')
    return reply({ op: 'exception' })
  }
  const sku = payload?.product?.sku
  if (typeof sku !== 'string' || sku === '') {
    logger.warn('payload has no product.sku: refused')
    return reply({ op: 'exception' })
  }
  if (!isAllowed(sku, params.RESTRICTED_SKUS)) {
    logger.info('item blocked: SKU is restricted')
    return reply({ op: 'exception', message: BLOCKED_MESSAGE })
  }
  return reply({ op: 'success' })
}

exports.main = main
exports.isAllowed = isAllowed
