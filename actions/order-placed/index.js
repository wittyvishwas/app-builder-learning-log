/*
 * Ep 6: replace an observer with a Commerce event. Adobe I/O Events delivers
 * observer.sales_order_place_after (subscribed with only increment_id and grand_total) to this action.
 * Commerce retries delivery, so the same order can arrive more than once: the order number is the key,
 * and the export_runs collection (Ep 4) remembers what was already sent. Needs include-ims-credentials: true
 * in app.config.yaml, like sync-log.
 *
 * Differences from the post's snippet: sendToErp is defined here (the post leaves it out), and it reuses
 * actions/order-sync/erp.js, so the ERP gets the order number as Idempotency-Key and a 409 counts as success.
 * order-sync/export-order is the full version of this handler (Ep 10): register only one of the two for the event.
 */
const { Core } = require('@adobe/aio-sdk')
const libDb = require('@adobe/aio-lib-db')
const { sendOrder } = require('../order-sync/erp')

// Send the minimal order the Ep 6 subscription carries. erp.js reads the Idempotency-Key from
// `orderNumber`, so that field is added next to the two subscribed fields.
async function sendToErp (params, order) {
  if (!params.ERP_API_URL || !params.ERP_API_KEY) throw new Error('ERP_API_URL and ERP_API_KEY are required')
  return sendOrder(
    { orderNumber: order.increment_id, increment_id: order.increment_id, grand_total: order.grand_total },
    { url: params.ERP_API_URL, apiKey: params.ERP_API_KEY }
  )
}

async function main (params) {
  const logger = Core.Logger('order-placed', { level: params.LOG_LEVEL || 'info' })
  const order = params.data?.value ?? params.data ?? {}
  if (!order.increment_id) {
    logger.warn(`no order number in event: ${JSON.stringify(Object.keys(params.data || {}))}`)
    return { statusCode: 400, body: { error: 'no order number' } }
  }

  let client
  try {
    const token = await Core.AuthClient.generateAccessToken(params)
    // The region must match the provisioned one (app.config.yaml: database.region).
    client = await (await libDb.init({ token: token.access_token, region: 'emea' })).connect()
    const runs = await client.collection('export_runs')
    if (await runs.findOne({ order: order.increment_id, status: 'sent' })) {
      logger.info(`order ${order.increment_id} already sent, skipping`)
      return { statusCode: 200, body: { skipped: true } }
    }
    await sendToErp(params, order)
    await runs.insertOne({ order: order.increment_id, status: 'sent', at: new Date().toISOString() })
    return { statusCode: 200, body: { sent: order.increment_id } }
  } catch (e) {
    // Message only: never the whole error or an ERP response body.
    logger.error(`order ${order.increment_id}: ${e.message}`)
    // A 500 makes I/O Events deliver the event again.
    return { statusCode: 500, body: { error: e.message } }
  } finally {
    if (client) await client.close()
  }
}
exports.main = main
exports.sendToErp = sendToErp
