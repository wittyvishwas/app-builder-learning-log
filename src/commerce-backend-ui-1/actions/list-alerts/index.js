/*
 * Ep 9: the open alerts for the admin page: stuck_alerts rows that aren't handled, newest first, at most 50.
 * Same query as the post. Called by the page with the admin's Adobe identity (require-adobe-auth: true).
 * v1 has no per-action ACL: anyone with a valid Adobe token for this org can call it.
 * Errors are logged by message only (never the whole error object) and answered without detail.
 */
const { Core } = require('@adobe/aio-sdk')
const libDb = require('@adobe/aio-lib-db')

async function main (params) {
  const logger = Core.Logger('list-alerts', { level: params.LOG_LEVEL || 'info' })
  let client
  try {
    const token = await Core.AuthClient.generateAccessToken(params)
    // The region must match the provisioned one (app.config.yaml: database.region).
    const db = await libDb.init({ token: token.access_token, region: 'emea' })
    client = await db.connect()
    const alerts = await client.collection('stuck_alerts')
    const rows = await alerts.find({ handled: { $ne: true } }).sort({ at: -1 }).limit(50).toArray()
    return { statusCode: 200, body: rows }
  } catch (e) {
    logger.error(e.message)
    return { statusCode: 500, body: { error: e.name === 'DbError' ? 'database error' : 'internal error' } }
  } finally {
    if (client) await client.close()
  }
}
exports.main = main
