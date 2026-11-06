/*
 * Ep 9: marks one stuck alert as handled (the "Mark handled" button). Needs `order`, the order number.
 * Answers 404 when there is no such alert, so the page can tell. Same auth and error rules as list-alerts.
 */
const { Core } = require('@adobe/aio-sdk')
const libDb = require('@adobe/aio-lib-db')

async function main (params) {
  const logger = Core.Logger('mark-handled', { level: params.LOG_LEVEL || 'info' })
  if (typeof params.order !== 'string' || !params.order.trim()) {
    return { statusCode: 400, body: { error: 'order is required' } }
  }
  let client
  try {
    const token = await Core.AuthClient.generateAccessToken(params)
    const db = await libDb.init({ token: token.access_token, region: 'emea' })
    client = await db.connect()
    const alerts = await client.collection('stuck_alerts')
    const res = await alerts.updateOne(
      { order: params.order },
      { $set: { handled: true, handledAt: new Date().toISOString() } }
    )
    if (!res.matchedCount) return { statusCode: 404, body: { error: 'no such alert' } }
    return { statusCode: 200, body: { order: params.order, handled: true } }
  } catch (e) {
    logger.error(e.message)
    return { statusCode: 500, body: { error: e.name === 'DbError' ? 'database error' : e.message } }
  } finally {
    if (client) await client.close()
  }
}
exports.main = main
