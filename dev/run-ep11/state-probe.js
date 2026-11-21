/*
 * Runs the Ep 11 probe calls straight from Node (what the ep11-probe action runs in the runtime), so the result shows
 * what State, Files and Database Storage answer to a call from your machine.
 *   node dev/run-ep11/state-probe.js          State and Files
 *   node dev/run-ep11/state-probe.js --db     Database Storage (insert, find, delete, drop on collection ep11_probe)
 * Reads .env with dev/run-ep8/env.js. The DB probe WRITES to the workspace's database: run dev/run-ep11/guard.sh first.
 * One line per call: `<lib> <call> ok|error <message>`. Exit 0 when every failure was an error the service or the
 * library reported (recorded as a line); non-zero on anything unexpected (a missing .env key, a crash).
 */
const { loadEnv, need } = require('../run-ep8/env')
const { parseScopes } = require('../../scripts/post-deploy-db-setup')
const { probeState, probeFiles, probeDb } = require('../../actions/ep11-probe/probe')

// Messages are printed as they are, except that any .env value of 8+ characters is blanked out.
function scrubber (env) {
  const secrets = Object.values(env).filter(v => v.length >= 8)
  return text => secrets.reduce((t, s) => t.split(s).join('***'), String(text))
}

async function main (argv, env) {
  const scrub = scrubber(env)
  const lines = []
  const report = (lib, results) => {
    for (const r of results) lines.push(`${lib} ${r.call} ${r.ok ? 'ok' : 'error'}${r.ok ? '' : ' ' + scrub(r.error)}`)
  }
  if (argv.includes('--db')) {
    need(env, ['IMS_OAUTH_S2S_CLIENT_ID', 'IMS_OAUTH_S2S_CLIENT_SECRET', 'IMS_OAUTH_S2S_ORG_ID', 'IMS_OAUTH_S2S_SCOPES'])
    const namespace = env.AIO_RUNTIME_NAMESPACE || env.AIO_runtime_namespace
    if (!namespace) throw new Error('missing in .env: AIO_runtime_namespace')
    const { Core } = require('@adobe/aio-sdk')
    report('db', await probeDb(require('@adobe/aio-lib-db'), async () => {
      const token = await Core.AuthClient.generateAccessToken({
        clientId: env.IMS_OAUTH_S2S_CLIENT_ID,
        clientSecret: env.IMS_OAUTH_S2S_CLIENT_SECRET,
        orgId: env.IMS_OAUTH_S2S_ORG_ID,
        scopes: parseScopes(env.IMS_OAUTH_S2S_SCOPES)
      })
      return { token: token.access_token, ow: { namespace } }
    }))
  } else {
    need(env, ['AIO_runtime_namespace', 'AIO_runtime_auth'])
    const init = { ow: { namespace: env.AIO_runtime_namespace, auth: env.AIO_runtime_auth } }
    report('state', await probeState(require('@adobe/aio-lib-state'), init))
    report('files', await probeFiles(require('@adobe/aio-lib-files'), init))
  }
  return lines
}

module.exports = { main, scrubber }

if (require.main === module) {
  let env
  try { env = loadEnv() } catch (e) { console.error(`state-probe: cannot read .env (${e.code || e.message})`); process.exit(2) }
  main(process.argv.slice(2), env).then(lines => lines.forEach(l => console.log(l))).catch(e => {
    console.error(`state-probe: unexpected failure: ${e.message}`)
    process.exit(1)
  })
}
