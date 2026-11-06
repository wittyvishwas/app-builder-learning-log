/*
 * Ep 4: Database Storage. Writes one row per export attempt into the export_runs collection
 * and answers with the latest failure for the same SKU. Needs include-ims-credentials: true
 * in app.config.yaml, so the action receives the OAuth credentials that generateAccessToken uses.
 *
 * Difference from the post: the post's snippet reads the failure with findOne({ sku, status: 'failed' }),
 * which returns *a* matching row, not necessarily the newest. Because the field is called lastFailure,
 * this version sorts by `at` descending and takes one, which is what the name promises. Same query, same result shape.
 * It also returns 400 when sku or status is missing, which the post's snippet omits: an undefined field is dropped
 * when the document and the filter are serialised, so the lookup would match any SKU's latest failure.
 */
const { Core } = require('@adobe/aio-sdk')
const libDb = require('@adobe/aio-lib-db')

async function main (params) {
  const logger = Core.Logger('sync-log', { level: params.LOG_LEVEL || 'info' })
  if (!params.sku || !params.status) {
    return { statusCode: 400, body: { error: 'sku and status are required' } }
  }
  let client
  try {
    const token = await Core.AuthClient.generateAccessToken(params)
    // The region must match the provisioned one (app.config.yaml: database.region).
    const db = await libDb.init({ token: token.access_token, region: 'emea' })
    client = await db.connect()
    const runs = await client.collection('export_runs')

    await runs.insertOne({
      sku: params.sku,
      status: params.status,
      error: params.error || null,
      at: new Date().toISOString()
    })
    const [failed = null] = await runs.find({ sku: params.sku, status: 'failed' }).sort({ at: -1 }).limit(1).toArray()
    return { statusCode: 200, body: { lastFailure: failed } }
  } catch (e) {
    // Message only: never the whole error object.
    logger.error(e.message)
    return { statusCode: 500, body: { error: e.name === 'DbError' ? 'database error' : e.message } }
  } finally {
    if (client) await client.close()
  }
}
exports.main = main
