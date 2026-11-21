/*
 * Ep 11 test helper, never deploy it to Production: runs the State, Files or Database Storage calls inside the
 * runtime (or under `aio app dev`) and says which ones worked. ?op=state | files | db.
 * The answer holds call names and error messages only, never params, keys or tokens.
 * The calls live in probe.js, which dev/run-ep11/state-probe.js shares.
 */
const { Core } = require('@adobe/aio-sdk')
const stateLib = require('@adobe/aio-lib-state')
const filesLib = require('@adobe/aio-lib-files')
const libDb = require('@adobe/aio-lib-db')
const { probeState, probeFiles, probeDb } = require('./probe')

async function main (params) {
  const op = params && params.op
  let results
  if (op === 'state') results = await probeState(stateLib)
  else if (op === 'files') results = await probeFiles(filesLib)
  else if (op === 'db') {
    // Needs include-ims-credentials: true in app.config.yaml (the OAuth credentials generateAccessToken uses).
    results = await probeDb(libDb, async () => {
      const token = await Core.AuthClient.generateAccessToken(params)
      return { token: token.access_token }
    })
  } else {
    return { statusCode: 400, body: { error: 'op must be state, files or db' } }
  }
  return { statusCode: 200, body: { op, results } }
}
exports.main = main
