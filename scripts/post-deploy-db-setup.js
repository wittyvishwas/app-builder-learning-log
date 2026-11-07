/*
 * Ep 4: post-app-deploy hook. Creates the indexes of the collections this app uses, so every
 * workspace gets the same ones. Safe to run on every deploy: indexes that exist are skipped.
 *
 * Collections and what they hold: see "Collections" in the README.
 * Index only small fields (the indexed fields of one document can't exceed 2,048 bytes combined):
 * the SKU, not the error message.
 */
const fs = require('fs')
const path = require('path')

// name is spelled out so a second run can tell the index already exists.
const INDEXES = {
  export_runs: [
    { name: 'sku_1_at_-1', spec: { sku: 1, at: -1 }, options: {} },
    { name: 'order_1_status_1', spec: { order: 1, status: 1 }, options: {} }
  ],
  // One claim per order, so two deliveries of the same order can't both send (actions/order-placed).
  // Not on export_runs: Ep 4 rows have no `order` field, and a unique index treats missing values as equal.
  order_claims: [
    { name: 'order_1', spec: { order: 1 }, options: { unique: true } }
  ],
  stuck_alerts: [
    { name: 'order_1', spec: { order: 1 }, options: { unique: true } },
    { name: 'handled_1_at_-1', spec: { handled: 1, at: -1 }, options: {} }
  ]
}

// Pure: takes a connected aio-lib-db client, returns { created: [...], skipped: [...] } as 'collection.index'.
async function ensureIndexes (client) {
  const created = []
  const skipped = []
  for (const [collection, wanted] of Object.entries(INDEXES)) {
    const coll = await client.collection(collection)
    const existing = new Set((await coll.getIndexes()).map(i => i.name))
    for (const { name, spec, options } of wanted) {
      const label = `${collection}.${name}`
      if (existing.has(name)) { skipped.push(label); continue }
      await coll.createIndex(spec, { ...options, name })
      created.push(label)
    }
  }
  return { created, skipped }
}

// The same OAuth server-to-server credential the workspace uses (.env, see .env.dist).
async function getToken (env) {
  const { Core } = require('@adobe/aio-sdk')
  const missing = ['IMS_OAUTH_S2S_CLIENT_ID', 'IMS_OAUTH_S2S_CLIENT_SECRET', 'IMS_OAUTH_S2S_ORG_ID', 'IMS_OAUTH_S2S_SCOPES']
    .filter(k => !env[k])
  if (missing.length) throw new Error(`Missing in .env: ${missing.join(', ')}`)
  const token = await Core.AuthClient.generateAccessToken({
    clientId: env.IMS_OAUTH_S2S_CLIENT_ID,
    clientSecret: env.IMS_OAUTH_S2S_CLIENT_SECRET,
    orgId: env.IMS_OAUTH_S2S_ORG_ID,
    scopes: env.IMS_OAUTH_S2S_SCOPES.split(',').map(s => s.trim()).filter(Boolean)
  })
  return token.access_token
}

async function run (env = process.env) {
  const libDb = require('@adobe/aio-lib-db')
  // aio-lib-db falls back to __OW_NAMESPACE, which is not set when aio runs this hook as a child process.
  if (!env.AIO_RUNTIME_NAMESPACE) throw new Error('Missing in .env: AIO_RUNTIME_NAMESPACE')
  const token = await getToken(env)
  // aio-lib-db reads the region from app.config.yaml in the working directory (database.region);
  // 'emea' here is only its fallback.
  const db = await libDb.init({ token, region: 'emea', ow: { namespace: env.AIO_RUNTIME_NAMESPACE } })
  const client = await db.connect()
  try {
    return await ensureIndexes(client)
  } finally {
    await client.close()
  }
}

module.exports = { ensureIndexes, INDEXES, run }

if (require.main === module) {
  const envFile = path.join(process.cwd(), '.env')
  if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile)
  run().then(({ created, skipped }) => {
    console.log(`Indexes created: ${created.join(', ') || 'none'}; already there: ${skipped.join(', ') || 'none'}`)
  }).catch(e => {
    console.error(`Index setup failed: ${e.message}`)
    process.exit(1)
  })
}
