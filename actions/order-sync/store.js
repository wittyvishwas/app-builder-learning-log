/*
 * Order-sync bookkeeping in Database Storage (collection export_runs, from Ep 4), one row per order:
 *   { order, status: 'sent', at }                                  delivered; a redelivered event is skipped
 *   { order, status: 'retry', attempts, nextAt, lastError, httpStatus, mapped, at }
 *                                                                  transient failure; the scheduled action resends it
 *   { order, status: 'dead', attempts, lastError, httpStatus, lines, totals, at }
 *                                                                  permanent failure or retries exhausted, for a human
 * updateOne with upsert by { order } moves a row between the three, so normally an order has one row (two
 * writers racing, or Ep 6's insertOne, can leave two; markDone and the retry run settle them). The
 * sent row has the same shape Ep 6's order-placed writes, so both actions share the de-dup check
 * findOne({ order, status: 'sent' }).
 *
 * Personal data: `mapped` is the complete ERP order, because a retry has to resend it as is, so it holds
 * the customer and addresses while the order waits (minutes: six runs, ten minutes apart). It is set to
 * null as soon as the row becomes sent or dead. A dead row keeps lines and totals only.
 *
 * No TTL: Database Storage rows stay until someone deletes them (State kept done/retry/dead for
 * 30 days / 7 days / 1 year). See the README for a cleanup suggestion.
 *
 * State keeps only the retry-run lock (seconds, ifNotExists), which is a flag with a lifetime.
 */
const libDb = require('@adobe/aio-lib-db')
const stateLib = require('@adobe/aio-lib-state')
const { Core } = require('@adobe/aio-sdk')

const COLLECTION = 'export_runs'
// The region must match the provisioned one (app.config.yaml: database.region).
const REGION = 'emea'

const safe = n => String(n).replace(/[^a-zA-Z0-9-_.]/g, '_')

// One connection per invocation: the caller passes `store` into the export logic and calls close() in finally.
async function connect (params) {
  const token = await Core.AuthClient.generateAccessToken(params)
  const client = await (await libDb.init({ token: token.access_token, region: REGION })).connect()
  let runs
  try { runs = await client.collection(COLLECTION) } catch (e) { await client.close(); throw e }
  const now = () => new Date().toISOString()
  // A retry or dead row being replaced: its leftovers (the mapped order, the schedule) are cleared.
  const leftovers = async n => (
    await runs.findOne({ order: n, status: { $in: ['retry', 'dead'] } })
  ) ? { mapped: null, nextAt: null } : {}

  const store = {
    isDone: async n => Boolean(await runs.findOne({ order: n, status: 'sent' })),
    // Every row for the order (a stray retry row next to a sent one, Ep 6's insertOne) becomes sent, and the
    // mapped order and schedule are cleared; a new sent row, in Ep 6's shape, only when there was none.
    async markDone (n) {
      await runs.updateMany({ order: n }, { $set: { status: 'sent', at: now(), mapped: null, nextAt: null } })
      // Don't rely on the shape of updateMany's result (aio-lib-db passes the service response through): look.
      if (!(await store.isDone(n))) await runs.insertOne({ order: n, status: 'sent', at: now() })
    },
    // A retry row left next to a sent row (a race): settle it so it is not picked up again and holds no order.
    settleRetry: n => runs.updateMany({ order: n, status: 'retry' }, { $set: { status: 'sent', mapped: null, nextAt: null } }),
    // putRetry and putDead never touch a sent row: they re-check right before writing and skip (return false)
    // if the order is sent, and their filter excludes sent rows. A tiny window remains between the check and
    // the write; a duplicate POST in it is covered by the ERP's Idempotency-Key.
    async putRetry (n, { mapped, attempts, lastError, httpStatus }) {
      if (await store.isDone(n)) return false
      // nextAt is now: the 10-minute alarm is the backoff, so a queued order is due at the next run.
      const at = now()
      await runs.updateOne({ order: n, status: { $ne: 'sent' } }, { $set: { status: 'retry', attempts, nextAt: at, lastError, httpStatus, mapped, at } }, { upsert: true })
      return true
    },
    async putDead (n, { lines, totals, attempts, lastError, httpStatus }) {
      if (await store.isDone(n)) return false
      await runs.updateOne({ order: n, status: { $ne: 'sent' } }, {
        $set: { status: 'dead', attempts, lastError, httpStatus, lines, totals, at: now(), ...await leftovers(n) }
      }, { upsert: true })
      return true
    },
    // Orders due for a retry, oldest first, at most `limit`; `total` is how many are due in all.
    async dueRetries (limit, at = now()) {
      const filter = { status: 'retry', nextAt: { $lte: at } }
      const rows = await runs.find(filter).sort({ nextAt: 1 }).limit(limit).toArray()
      return { rows, total: await runs.countDocuments(filter) }
    },
    getRetry: n => runs.findOne({ order: n, status: 'retry' })
  }
  return { store, close: () => client.close() }
}

// State: only the lock that stops a manual invoke from overlapping the scheduled run.
// put with ifNotExists resolves to null when the key already exists (aio-lib-state >= 5.4), so it is atomic.
async function openLock () {
  const state = await stateLib.init()
  const key = name => `order-sync.lock.${safe(name)}`
  return {
    async acquire (name, seconds) {
      const got = await state.put(key(name), String(Date.now()), { ttl: seconds, ifNotExists: true })
      return got !== null
    },
    release: name => state.delete(key(name))
  }
}

module.exports = { connect, openLock, COLLECTION }
