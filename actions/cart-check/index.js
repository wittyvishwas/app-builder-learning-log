/*
 * Ep 7: replace a plugin with a webhook. Commerce calls this action from observer.checkout_cart_product_add_before
 * and waits for the answer: { op: 'success' } lets the item in, { op: 'exception' } stops it.
 *
 * The URL is public, so the call is verified first: Commerce signs the exact raw request body and sends the
 * signature (base64) in x-adobe-commerce-webhook-signature. That needs `raw-http: true` in app.config.yaml.
 * With raw-http, __ow_body can arrive base64-encoded instead of as JSON text. We decode it to a Buffer when it
 * isn't JSON text, verify the signature over those exact bytes, and JSON.parse the same bytes. Never re-serialise
 * a parsed body: one changed byte breaks the signature.
 *
 * A missing or invalid signature answers 200 with { op: 'exception' } (fail closed for a forged call, as the post
 * does). A payload without a SKU is not what we expect, so it is refused the same way, without a message.
 * Logs carry messages only, never the body or the key.
 */
const crypto = require('crypto')
const { Core } = require('@adobe/aio-sdk')

const SIGNATURE_HEADER = 'x-adobe-commerce-webhook-signature'
const BLOCKED_MESSAGE = "This item can't be added to your cart."

const reply = op => ({ statusCode: 200, body: JSON.stringify(op) })

// The exact bytes Commerce signed. A body that starts like JSON is text; anything else is base64.
function rawBytes (body) {
  if (Buffer.isBuffer(body)) return body
  if (typeof body !== 'string' || body === '') return null
  return /^\s*[{[]/.test(body) ? Buffer.from(body, 'utf8') : Buffer.from(body, 'base64')
}

// A PEM kept on one line in .env has literal "\n" sequences: turn them back into newlines.
const normalisePem = key => String(key).replace(/\\n/g, '\n')

function verifySignature (bytes, signature, publicKey) {
  const verifier = crypto.createVerify('SHA256')
  verifier.update(bytes)
  return verifier.verify(normalisePem(publicKey), signature, 'base64')
}

// Not allowed when the SKU is on the comma-separated RESTRICTED_SKUS list (trimmed, case-sensitive).
function isAllowed (sku, restricted = '') {
  const list = String(restricted).split(',').map(s => s.trim()).filter(Boolean)
  return !list.includes(sku)
}

async function main (params) {
  const logger = Core.Logger('cart-check', { level: params.LOG_LEVEL || 'info' })
  const signature = (params.__ow_headers || {})[SIGNATURE_HEADER]
  const bytes = rawBytes(params.__ow_body)

  if (!params.PUBLIC_KEY) {
    logger.error('PUBLIC_KEY is not set: refusing every call')
    return reply({ op: 'exception' })
  }
  if (!signature || !bytes) {
    logger.warn('request has no signature or no body: refused')
    return reply({ op: 'exception' })
  }
  let valid = false
  try {
    valid = verifySignature(bytes, signature, params.PUBLIC_KEY)
  } catch (e) {
    logger.error(`signature check failed: ${e.message}`)
  }
  if (!valid) {
    logger.warn('signature does not match: refused')
    return reply({ op: 'exception' })
  }

  let payload
  try {
    payload = JSON.parse(bytes.toString('utf8'))
  } catch (e) {
    logger.warn('signed body is not valid JSON: refused')
    return reply({ op: 'exception' })
  }
  const sku = payload?.data?.product?.sku
  if (typeof sku !== 'string' || sku === '') {
    logger.warn('payload has no data.product.sku: refused')
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
