/*
 * Ep 11 probe: the State, Files and Database Storage calls, shared by the ep11-probe action and by
 * dev/run-ep11/state-probe.js (which runs them straight from Node). Each function takes the library as an argument,
 * so the caller decides where the credentials come from. A failing call is recorded as
 * { call, ok: false, error: <message> } and ends that op; only the message is kept, never the error object.
 * State key and DB document carry a random suffix, so two runs (or a leftover) never collide.
 */
const crypto = require('crypto')
const STATE_KEY_PREFIX = 'ep11-probe-'
const FILES_PATH = 'ep11/probe.txt'
const DB_COLLECTION = 'ep11_probe'
const DB_REGION = 'emea' // must match app.config.yaml database.region, like the other db actions

const suffix = () => crypto.randomBytes(6).toString('hex')

// Runs the steps in order; the first failure is recorded and stops the op. Then `cleanup` runs once, errors ignored
// and unrecorded, so a failure half-way does not leave a State key, file, row or collection behind (as far as the
// cleanup calls themselves work).
async function runSteps (steps, cleanup) {
  const results = []
  for (const [call, fn] of steps) {
    try {
      await fn()
      results.push({ call, ok: true })
    } catch (err) {
      results.push({ call, ok: false, error: String(err && err.message) })
      if (cleanup) { try { await cleanup() } catch (e) { /* best effort */ } }
      break
    }
  }
  return results
}

async function probeState (stateLib, initArg) {
  let state
  const key = STATE_KEY_PREFIX + suffix()
  const value = new Date().toISOString()
  return runSteps([
    ['init', async () => { state = await stateLib.init(initArg) }],
    ['put', async () => { await state.put(key, value, { ttl: 300 }) }],
    ['get', async () => {
      const got = await state.get(key)
      if (!got || got.value !== value) throw new Error('get did not return the value that was put')
    }],
    ['delete', async () => { await state.delete(key) }]
  ], async () => { if (state) await state.delete(key) })
}

async function probeFiles (filesLib, initArg) {
  let files
  const content = new Date().toISOString()
  return runSteps([
    ['init', async () => { files = await filesLib.init(initArg) }],
    ['write', async () => { await files.write(FILES_PATH, content) }],
    ['read', async () => {
      const buf = await files.read(FILES_PATH)
      if (String(buf) !== content) throw new Error('read did not return the content that was written')
    }],
    ['delete', async () => { await files.delete(FILES_PATH) }]
  ], async () => { if (files) await files.delete(FILES_PATH) })
}

// getInitOptions: async () => options for libDb.init (it holds the token; the action and the script build it
// differently). Its failure is recorded as the `token` call.
async function probeDb (libDb, getInitOptions) {
  let options
  let client
  let coll
  const id = suffix()
  const doc = { id, probe: 'ep11', at: new Date().toISOString() }
  const results = await runSteps([
    ['token', async () => { options = await getInitOptions() }],
    ['init', async () => { client = await (await libDb.init({ region: DB_REGION, ...options })).connect() }],
    ['insertOne', async () => { coll = await client.collection(DB_COLLECTION); await coll.insertOne(doc) }],
    ['findOne', async () => {
      const found = await coll.findOne({ id })
      if (!found) throw new Error('findOne did not return the document that was inserted')
    }],
    ['deleteOne', async () => { await coll.deleteOne({ id }) }],
    // aio-lib-db 1.1.0 has DbCollection.drop(); the unique collection name keeps this away from the app's own data.
    ['drop', async () => { await coll.drop() }]
  ], async () => {
    // Part-way failure: try to remove the row, then the collection; each on its own, so one failing does not skip the other.
    if (!coll) return
    try { await coll.deleteOne({ id }) } catch (e) { /* best effort */ }
    try { await coll.drop() } catch (e) { /* best effort */ }
  })
  if (client) { try { await client.close() } catch (e) { /* best effort */ } }
  return results
}

module.exports = { probeState, probeFiles, probeDb, DB_REGION }
