/*
 * Renders the Ep 8 run's mesh variants from mesh/mesh.json (README, "Variants").
 *   node dev/run-ep8/render.js <variant|all>
 * The env is injected: the CLI reads .env once and passes it to render(); tests pass a fake object.
 * Needs FAKE_REVIEWS_URL, FAKE_REVIEWS_API_KEY and COMMERCE_GRAPHQL_URL. Output goes to out/<variant>/mesh.json with the
 * schema files next to it (paths stay relative and short). out/ is gitignored because the files hold the fake key.
 */
const fs = require('fs')
const path = require('path')
const { ROOT, loadEnv, need } = require('./env')

const REQUIRED = ['FAKE_REVIEWS_URL', 'FAKE_REVIEWS_API_KEY', 'COMMERCE_GRAPHQL_URL']
const OUT = path.join(__dirname, 'out')
const SCHEMAS = {
  'reviews-schema.json': path.join(ROOT, 'mesh/reviews-schema.json'),
  'stock-schema.json': path.join(__dirname, 'templates/stock-schema.json'),
  'review-one.json': path.join(__dirname, 'templates/review-one.json')
}
const CORS = { origin: 'https://mmtest.example.com', methods: ['GET', 'POST'] }

const listArg = name => ({ [name]: { type: 'array', items: { type: 'string' } } })
const source = (name, env, operation) => ({
  name,
  handler: { JsonSchema: { baseUrl: env.FAKE_REVIEWS_URL, operationHeaders: { 'x-mm-key': env.FAKE_REVIEWS_API_KEY }, operations: [operation] } }
})

// bad-name-* rename the Reviews source; the three path-* variants move the Reviews schema file (see README).
const BAD_NAMES = { 'bad-name-hyphen': 'Reviews-2', 'bad-name-underscore': 'Reviews_2', 'bad-name-space': 'Reviews 2' }
const PATHS = {
  'path-b25': './abcdefghijklmnopqrst.json',
  'path-b26': './abcdefghijklmnopqrstu.json',
  'path-b24-long': './s/abcdefghijklmnopqrs.json'
}
const VARIANTS = ['v0-lower', 'v1', 'v2', 'v3', ...Object.keys(BAD_NAMES), ...Object.keys(PATHS)]

const clone = o => JSON.parse(JSON.stringify(o))

function v1Config (env) {
  const config = clone(JSON.parse(fs.readFileSync(path.join(ROOT, 'mesh/mesh.json'), 'utf8')))
  const mesh = config.meshConfig
  mesh.sources[0].handler.graphql.endpoint = env.COMMERCE_GRAPHQL_URL
  const reviews = mesh.sources[1].handler.JsonSchema
  reviews.baseUrl = env.FAKE_REVIEWS_URL
  reviews.operationHeaders = { 'x-mm-key': env.FAKE_REVIEWS_API_KEY }
  mesh.sources.push(
    source('Stock', env, { type: 'Query', field: 'stockBySkus', path: '/stock?skus={args.skus}', method: 'GET', argTypeMap: listArg('skus'), responseSchema: './stock-schema.json' }),
    source('ReviewOne', env, { type: 'Query', field: 'reviewOne', path: '/review?sku={args.sku}', method: 'GET', argTypeMap: { sku: { type: 'string' } }, responseSchema: './review-one.json' })
  )
  mesh.additionalTypeDefs = 'extend type SimpleProduct {\n  externalReviews: [Review]\n  externalReviewsEach: [Review]\n}\n'
  mesh.additionalResolvers.push({
    targetTypeName: 'SimpleProduct',
    targetFieldName: 'externalReviewsEach',
    sourceName: 'ReviewOne',
    sourceTypeName: 'Query',
    sourceFieldName: 'reviewOne',
    sourceArgs: { sku: '{root.sku}' },
    requiredSelectionSet: '{ sku }'
  })
  mesh.responseConfig = { includeHTTPDetails: true }
  return config
}

function build (variant, env) {
  let extraFiles = {}
  if (variant === 'v0-lower') {
    // The tag's own config, with the handler key in lower case; nothing from v1 is added.
    const config = v1Config(env)
    const mesh = config.meshConfig
    mesh.sources.length = 2
    mesh.additionalResolvers.length = 1
    mesh.additionalTypeDefs = 'extend type SimpleProduct {\n  externalReviews: [Review]\n}\n'
    mesh.responseConfig = { cache: true }
    mesh.sources[1].handler = { jsonSchema: mesh.sources[1].handler.JsonSchema }
    return { config, extraFiles }
  }
  const config = v1Config(env)
  const mesh = config.meshConfig
  if (variant === 'v2' || variant === 'v3') {
    mesh.responseConfig = { cache: true, CORS: clone(CORS) }
  }
  if (variant === 'v3') mesh.sources[1].responseConfig = { cache: { cacheControl: 'public, max-age=100' } }
  if (BAD_NAMES[variant]) {
    const name = BAD_NAMES[variant]
    mesh.sources[1].name = name
    mesh.additionalResolvers[0].sourceName = name
  }
  if (PATHS[variant]) {
    const p = PATHS[variant]
    mesh.sources[1].handler.JsonSchema.operations[0].responseSchema = p
    extraFiles = { [p.slice(2)]: SCHEMAS['reviews-schema.json'] }
  }
  return { config, extraFiles }
}

// Writes out/<variant>/mesh.json and the schema files; returns the config object.
function render (variant, env, { outDir = OUT } = {}) {
  if (!VARIANTS.includes(variant)) throw new Error(`unknown variant ${variant} (one of ${VARIANTS.join(', ')})`)
  need(env, REQUIRED)
  const { config, extraFiles } = build(variant, env)
  const dir = path.join(outDir, variant)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'mesh.json'), JSON.stringify(config, null, 2) + '\n')
  for (const [rel, from] of [...Object.entries(SCHEMAS), ...Object.entries(extraFiles)]) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.copyFileSync(from, path.join(dir, rel))
  }
  return config
}

module.exports = { render, VARIANTS }

if (require.main === module) {
  const arg = process.argv[2]
  if (!arg) { console.error(`usage: node dev/run-ep8/render.js <${VARIANTS.join('|')}|all>`); process.exit(2) }
  try {
    const env = loadEnv()
    for (const v of arg === 'all' ? VARIANTS : [arg]) {
      render(v, env)
      console.log(`rendered ${path.relative(ROOT, path.join(OUT, v, 'mesh.json'))}`)
    }
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
}
