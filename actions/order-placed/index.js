/*
 * Ep 6: replace an observer with a Commerce event. Adobe I/O Events delivers
 * observer.sales_order_place_after (subscribed with only increment_id and grand_total) to this action.
 * Needs include-ims-credentials: true in app.config.yaml, like sync-log.
 *
 * Commerce retries delivery, and two deliveries of the same order can arrive together, so "look, then send"
 * is not enough: both would look before either wrote. The action claims the order first, in one atomic call:
 * the order_claims collection holds one document per order ({ order, status, at }) behind a unique index on
 * `order`, and an upsert that matches nothing claimable tries to insert, which the index rejects when a
 * `sent` or fresh `sending` claim exists. Only the delivery that wins the claim calls the ERP.
 *   - claim won: send, insert the sent row in export_runs (Ep 4 and Ep 10 read it), mark the claim `sent`.
 *   - claim lost: `sent` answers 200 skipped; a fresh `sending` answers 409 so I/O Events keeps retrying.
 *   - send failed: the claim becomes `failed` and the answer is 500, so a redelivery can claim it again.
 *   - a `sending` claim older than STALE_SENDING_MS (a run that died mid-send) is claimable again.
 * If the sent row or the `sent` mark fails after a successful send, the claim stays `sending` and becomes
 * claimable after the stale window; the ERP's Idempotency-Key (actions/order-sync/erp.js) is the backstop.
 * `at` is compared as a string, which only works because every writer uses toISOString().
 *
 * Differences from the post's snippet: sendToErp is defined here (the post leaves it out), and it reuses
 * actions/order-sync/erp.js, so the ERP gets the order number as Idempotency-Key and a 409 counts as success.
 * order-sync/export-order is the full version of this handler (Ep 10): register only one of the two for the event.
 */
const { Core } = require('@adobe/aio-sdk')
const libDb = require('@adobe/aio-lib-db')
const { sendOrder } = require('../order-sync/erp')

// Kept in this file on purpose: it is one small helper. The post's tip about a file of its own applies once it grows.
// Send the minimal order the Ep 6 subscription carries. erp.js reads the Idempotency-Key from
// `orderNumber`, so that field is added next to the two subscribed fields.
async function sendToErp (params, order) {
  if (!params.ERP_API_URL || !params.ERP_API_KEY) throw new Error('ERP_API_URL and ERP_API_KEY are required')
  return sendOrder(
    { orderNumber: order.increment_id, increment_id: order.increment_id, grand_total: order.grand_total },
    { url: params.ERP_API_URL, apiKey: params.ERP_API_KEY }
  )
}

// A claim left in `sending` this long ago belongs to a run that died, so it can be claimed again.
const STALE_SENDING_MS = 10 * 60 * 1000

// Only picks the log level: the decision is made from the claim document, not from the error text.
function isDuplicateKeyError (err) {
  for (let e = err, depth = 0; e && depth < 5; e = e.cause, depth++) {
    if (e.code === 11000 || e.code === '11000' || /E11000|duplicate key/i.test(e.message || '')) return true
  }
  return false
}

async function main (params) {
  const logger = Core.Logger('order-placed', { level: params.LOG_LEVEL || 'info' })
  const order = params.data?.value ?? params.data ?? {}
  const id = order.increment_id
  // A plain token, so nothing but a string ever reaches a database filter.
  if (typeof id !== 'string' || !/^\S{1,64}$/.test(id)) {
    logger.warn(`no order number in event: ${JSON.stringify(Object.keys(params.data || {}))}`)
    return { statusCode: 400, body: { error: 'no order number' } }
  }

  let client
  try {
    const token = await Core.AuthClient.generateAccessToken(params)
    // The region must match the provisioned one (app.config.yaml: database.region).
    client = await (await libDb.init({ token: token.access_token, region: 'emea' })).connect()
    const claims = await client.collection('order_claims')
    const runs = await client.collection('export_runs')
    const staleBefore = new Date(Date.now() - STALE_SENDING_MS).toISOString()

    try {
      // One atomic call. It matches a claimable claim (failed, or sending since before staleBefore) or, when there
      // is none, upserts a new one. If a sent or fresh sending claim exists, the upsert's insert hits the unique
      // index and throws: this delivery did not win.
      await claims.updateOne(
        { order: id, $or: [{ status: 'failed' }, { status: 'sending', at: { $lt: staleBefore } }] },
        { $set: { status: 'sending', at: new Date().toISOString() } },
        { upsert: true }
      )
    } catch (e) {
      // Any claim error: look at the claim itself and decide from that, never from the error text.
      const claim = await claims.findOne({ order: id })
      if (claim?.status === 'sent') {
        logger[isDuplicateKeyError(e) ? 'info' : 'warn'](`order ${id} already claimed (sent)`)
        return { statusCode: 200, body: { skipped: true } }
      }
      if (claim?.status === 'sending' && claim.at >= staleBefore) {
        logger[isDuplicateKeyError(e) ? 'info' : 'warn'](`order ${id} already claimed (sending)`)
        // Not 200: the delivery that holds the claim may still fail, and a retry has to stay possible.
        return { statusCode: 409, body: { error: 'in progress, retry later' } }
      }
      throw e
    }

    try {
      await sendToErp(params, order)
    } catch (e) {
      try {
        await claims.updateOne({ order: id, status: 'sending' }, { $set: { status: 'failed', at: new Date().toISOString() } })
      } catch (e2) {
        logger.warn(`order ${id}: could not release the claim: ${e2.message}`)
      }
      throw e
    }
    const at = new Date().toISOString()
    await runs.insertOne({ order: id, status: 'sent', at })
    await claims.updateOne({ order: id, status: 'sending' }, { $set: { status: 'sent', at } })
    return { statusCode: 200, body: { sent: id } }
  } catch (e) {
    // Message only: never the whole error or an ERP response body.
    logger.error(`order ${id}: ${e.message}`)
    // 500 so a retry is possible (as in the post). Whether I/O Events retries a Runtime action on its
    // returned statusCode is not verified on Stage yet. A permanent ERP error (400/422) also lands here.
    return { statusCode: 500, body: { error: e.message } }
  } finally {
    if (client) await client.close()
  }
}
exports.main = main
exports.sendToErp = sendToErp
