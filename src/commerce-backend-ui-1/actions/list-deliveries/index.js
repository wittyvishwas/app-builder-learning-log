/*
 * Ep 10: recent order deliveries for the admin page, from export_runs (the order-sync bookkeeping). Only rows with an
 * `order` field: Ep 4's sync-log rows (sku, status) share the collection and are left out. Failures first: dead, then
 * retry, then sent; newest first within each; at most 50 in all. A retry or dead row of an order that also has a sent row
 * is left out (the order was delivered). Only the columns the page shows are returned, never
 * `mapped` (the ERP order holds the customer and addresses). Same auth and error rules as list-alerts.
 */
const { Core } = require('@adobe/aio-sdk')
const libDb = require('@adobe/aio-lib-db')

const LIMIT = 50
const FIELDS = ['order', 'status', 'attempts', 'lastError', 'httpStatus', 'at', 'nextAt']
const pick = row => Object.fromEntries(FIELDS.map(f => [f, row[f] ?? null]))

async function main (params) {
  const logger = Core.Logger('list-deliveries', { level: params.LOG_LEVEL || 'info' })
  let client
  try {
    const token = await Core.AuthClient.generateAccessToken(params)
    // The region must match the provisioned one (app.config.yaml: database.region).
    const db = await libDb.init({ token: token.access_token, region: 'emea' })
    client = await db.connect()
    const runs = await client.collection('export_runs')
    const find = status => runs.find({ status, order: { $ne: null } }).sort({ at: -1 }).limit(LIMIT).toArray()
    const failing = [...await find('dead'), ...await find('retry')]
    // A stray retry or dead row next to a sent row (a race) is not a failure: the order was delivered.
    const sent = failing.length ? await runs.find({ status: 'sent', order: { $in: failing.map(r => r.order) } }).toArray() : []
    const delivered = new Set(sent.map(r => r.order))
    const out = failing.filter(r => !delivered.has(r.order)).slice(0, LIMIT).map(pick)
    if (out.length < LIMIT) out.push(...(await find('sent')).slice(0, LIMIT - out.length).map(pick))
    return { statusCode: 200, body: out }
  } catch (e) {
    logger.error(e.message)
    return { statusCode: 500, body: { error: e.name === 'DbError' ? 'database error' : 'internal error' } }
  } finally {
    if (client) await client.close()
  }
}
exports.main = main
