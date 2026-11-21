/*
 * Ep 11 test helper, never deploy it to Production: runs the State, Files or Database Storage calls inside the
 * runtime (or under `aio app dev`) and says which ones worked. ?op=state | files | db.
 * The answer holds call names and error messages only, never params, keys or tokens.
 * The calls live in probe.js, which dev/run-ep11/state-probe.js shares.
 * A non-web action (app.config.yaml), so deployed it needs the namespace auth to invoke; `aio app dev` serves it
 * over HTTP anyway. Second guard in code: it answers 403 unless EP11_PROBE_ENABLED is '1'. That input comes from
 * app.config.yaml ($EP11_PROBE_ENABLED), so set it only in the shell that starts `aio app dev`, never in .env.
 * An invoker can override inputs with params, so this gate alone is not a protection.
 */
const { Core } = require('@adobe/aio-sdk')
const stateLib = require('@adobe/aio-lib-state')
const filesLib = require('@adobe/aio-lib-files')
const libDb = require('@adobe/aio-lib-db')
const { probeState, probeFiles, probeDb } = require('./probe')

async function main (params) {
  if (!params || params.EP11_PROBE_ENABLED !== '1') return { statusCode: 403, body: { error: 'ep11-probe disabled' } }
  const op = params.op
  let results
  if (op === 'state') results = await probeState(stateLib)
  else if (op === 'files') results = await probeFiles(filesLib)
  else if (op === 'db') {
    // Needs include-ims-credentials: true in app.config.yaml (the OAuth credentials and IMS env generateAccessToken uses).
    results = await probeDb(libDb, async () => {
      const token = await Core.AuthClient.generateAccessToken({ __ims_oauth_s2s: params.__ims_oauth_s2s, __ims_env: params.__ims_env })
      return { token: token.access_token }
    })
  } else {
    return { statusCode: 400, body: { error: 'op must be state, files or db' } }
  }
  return { statusCode: 200, body: { op, results } }
}
exports.main = main
