/*
 * Tests for dev/run-ep8: render.js with an injected fake env (no .env, no network), the query padding, and mesh.sh's
 * guard with a stubbed `aio` on PATH (the real aio is never run).
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { render, VARIANTS } = require('../dev/run-ep8/render')
const { resolveQuery } = require('../dev/run-ep8/query')
const { parseEnv } = require('../dev/run-ep8/env')

const ENV = { FAKE_REVIEWS_URL: 'https://fake.example.test/api/v1/web/dev/fake-reviews', FAKE_REVIEWS_API_KEY: 'k'.repeat(16), COMMERCE_GRAPHQL_URL: 'https://shop.example.test/graphql' }
let tmp
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'run-ep8-')) })
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

const mesh = v => render(v, ENV, { outDir: tmp }).meshConfig
const src = (m, name) => m.sources.find(s => s.name === name)

describe('render', () => {
  test('the variants of the plan', () => {
    expect(VARIANTS).toEqual(['v0-lower', 'v1', 'v2', 'v3', 'bad-name-hyphen', 'bad-name-underscore', 'bad-name-space', 'path-b25', 'path-b26', 'path-b24-long'])
  })

  test('needs all three env vars and a known variant', () => {
    expect(() => render('v1', {}, { outDir: tmp })).toThrow(/FAKE_REVIEWS_URL.*FAKE_REVIEWS_API_KEY.*COMMERCE_GRAPHQL_URL/)
    expect(() => render('v1', { ...ENV, FAKE_REVIEWS_API_KEY: '' }, { outDir: tmp })).toThrow(/FAKE_REVIEWS_API_KEY/)
    expect(() => render('nope', ENV, { outDir: tmp })).toThrow(/unknown variant/)
  })

  test('v1: endpoints from env, key header on the fake sources, Stock, ReviewOne, externalReviewsEach, HTTP details, no cache', () => {
    const m = mesh('v1')
    expect(src(m, 'Commerce').handler.graphql.endpoint).toBe(ENV.COMMERCE_GRAPHQL_URL)
    for (const name of ['Reviews', 'Stock', 'ReviewOne']) {
      const h = src(m, name).handler.JsonSchema
      expect(h.baseUrl).toBe(ENV.FAKE_REVIEWS_URL)
      expect(h.operationHeaders).toEqual({ 'x-mm-key': ENV.FAKE_REVIEWS_API_KEY })
    }
    expect(src(m, 'Commerce').handler.graphql.operationHeaders).toBeUndefined()
    expect(src(m, 'Stock').handler.JsonSchema.operations[0]).toMatchObject({ field: 'stockBySkus', path: '/stock?skus={args.skus}', responseSchema: './stock-schema.json' })
    expect(src(m, 'ReviewOne').handler.JsonSchema.operations[0]).toMatchObject({ field: 'reviewOne', path: '/review?sku={args.sku}', responseSchema: './review-one.json' })
    expect(m.additionalResolvers).toHaveLength(2)
    expect(m.additionalResolvers[0]).toMatchObject({ targetFieldName: 'externalReviews', keyField: 'sku', keysArg: 'skus' })
    expect(m.additionalResolvers[1]).toMatchObject({ targetFieldName: 'externalReviewsEach', sourceName: 'ReviewOne', sourceArgs: { sku: '{root.sku}' }, requiredSelectionSet: '{ sku }' })
    expect(m.additionalTypeDefs).toMatch(/externalReviewsEach: \[Review\]/)
    expect(m.responseConfig).toEqual({ includeHTTPDetails: true })
  })

  test('v0-lower: the tag config with a lower-case handler key', () => {
    const m = mesh('v0-lower')
    expect(src(m, 'Reviews').handler.jsonSchema).toBeDefined()
    expect(src(m, 'Reviews').handler.JsonSchema).toBeUndefined()
    expect(m.sources).toHaveLength(2)
    expect(m.responseConfig).toEqual({ cache: true })
  })

  test('v2: cache and CORS, no HTTP details; v3 adds the per-source default', () => {
    const v2 = mesh('v2')
    expect(v2.responseConfig).toEqual({ cache: true, CORS: { origin: 'https://mmtest.example.com', methods: ['GET', 'POST'] } })
    expect(src(v2, 'Reviews').responseConfig).toBeUndefined()
    const v3 = mesh('v3')
    expect(v3.responseConfig).toEqual(v2.responseConfig)
    expect(src(v3, 'Reviews').responseConfig).toEqual({ cache: { cacheControl: 'public, max-age=100' } })
  })

  test('bad-name-*: the source is renamed everywhere it is referenced', () => {
    for (const [v, name] of [['bad-name-hyphen', 'Reviews-2'], ['bad-name-underscore', 'Reviews_2'], ['bad-name-space', 'Reviews 2']]) {
      const m = mesh(v)
      expect(m.sources.map(s => s.name)).toEqual(['Commerce', name, 'Stock', 'ReviewOne'])
      expect(m.additionalResolvers[0].sourceName).toBe(name)
    }
  })

  test('path-*: the Reviews schema is renamed and the file sits next to the mesh file', () => {
    for (const [v, p, base, whole] of [['path-b25', './abcdefghijklmnopqrst.json', 25, 27], ['path-b26', './abcdefghijklmnopqrstu.json', 26, 28], ['path-b24-long', './s/abcdefghijklmnopqrs.json', 24, 28]]) {
      const m = mesh(v)
      expect(src(m, 'Reviews').handler.JsonSchema.operations[0].responseSchema).toBe(p)
      expect(path.basename(p)).toHaveLength(base)
      expect(p).toHaveLength(whole)
      expect(fs.existsSync(path.join(tmp, v, p))).toBe(true)
    }
  })

  test('writes mesh.json and the schema files next to it', () => {
    mesh('v1')
    for (const f of ['mesh.json', 'reviews-schema.json', 'stock-schema.json', 'review-one.json']) expect(fs.existsSync(path.join(tmp, 'v1', f))).toBe(true)
    expect(JSON.parse(fs.readFileSync(path.join(tmp, 'v1', 'mesh.json'), 'utf8')).meshConfig.sources).toHaveLength(4)
  })

  test('every variant renders', () => {
    for (const v of VARIANTS) expect(() => mesh(v)).not.toThrow()
  })
})

describe('query padding', () => {
  const queries = JSON.parse(fs.readFileSync(path.join(__dirname, '../dev/run-ep8/queries.json'), 'utf8'))
  test('long2000 and long2100 make the GET URL exactly that long', () => {
    for (const [name, len] of [['long2000', 2000], ['long2100', 2100]]) {
      const url = 'https://mesh.example.test/graphql'
      const q = resolveQuery(queries, name, url)
      expect(`${url}?query=${encodeURIComponent(q)}`).toHaveLength(len)
      expect(q.startsWith(queries.reviewsOnly)).toBe(true)
    }
  })
  test('plain names return the query; unknown names throw', () => {
    expect(resolveQuery(queries, 'commerceOnly', 'https://x')).toBe(queries.commerceOnly)
    expect(() => resolveQuery(queries, 'nope', 'https://x')).toThrow(/unknown query/)
  })
  test('the named queries of the plan exist', () => {
    expect(Object.keys(queries)).toEqual(['page', 'pageEach', 'commerceOnly', 'reviewsOnly', 'reviewsAndStock', 'long2000', 'long2100'])
  })
})

test('parseEnv reads KEY=VALUE lines, quotes and comments', () => {
  expect(parseEnv('# c\nA=1\nB="two words"\n C = x\nD=\n')).toEqual({ A: '1', B: 'two words', D: '' })
})

describe('mesh.sh', () => {
  // A copy in a temp tree, so the script's ../../.env is never the repo's real .env.
  let script, root, bin, log, whereLog
  beforeAll(() => {
    root = path.join(tmp, 'tree')
    fs.mkdirSync(path.join(root, 'dev/run-ep8'), { recursive: true })
    script = path.join(root, 'dev/run-ep8/mesh.sh')
    fs.copyFileSync(path.join(__dirname, '../dev/run-ep8/mesh.sh'), script)
    bin = path.join(tmp, 'bin')
    log = path.join(tmp, 'aio.log')
    whereLog = path.join(tmp, 'aio-where.log')
    fs.mkdirSync(bin)
    // Stub aio: `where` prints $STUB_WHERE; anything else is only logged.
    fs.writeFileSync(path.join(bin, 'aio'), '#!/usr/bin/env bash\nif [ "$1" = where ]; then echo where >> "' + whereLog + '"; printf "%b" "$STUB_WHERE"; exit 0; fi\necho "$@" >> "' + log + '"\n', { mode: 0o755 })
  })
  beforeEach(() => { fs.rmSync(log, { force: true }); fs.rmSync(whereLog, { force: true }); fs.rmSync(path.join(root, '.env'), { force: true }) })

  const run = (args, { where = 'Org: Test Org\nProject: Test Project\nWorkspace: Stage\n', title = 'Test Project', workspace = 'Stage' } = {}) => {
    const env = { PATH: `${bin}:${process.env.PATH}`, STUB_WHERE: where, HOME: tmp }
    if (title !== null) env.MESH_PROJECT_TITLE = title
    if (workspace !== null) env.MESH_WORKSPACE_NAME = workspace
    return spawnSync('bash', [script, ...args], { env, encoding: 'utf8' })
  }
  const whereCalled = () => fs.existsSync(whereLog)
  const ran = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [])

  test('passes on the real `aio where` output format', () => {
    const r = run(['get'], { where: 'You are currently in:\n1. Org: O\n2. Project: Test Project\n3. Workspace: Stage\n' })
    expect(r.status).toBe(0)
    expect(ran()).toEqual(['api-mesh:get'])
  })

  test('refuses and runs nothing when the project is another one', () => {
    for (const where of ['Project: Other Project\n', 'Project: Test Project 2\n', 'Project: Prefix Test Project\n', 'Project: Test Project Extra\nWorkspace: x\n', '']) {
      const r = run(['delete'], { where })
      expect(r.status).not.toBe(0)
      expect(r.stderr).toMatch(/refusing/)
    }
    expect(ran()).toEqual([])
  })

  test('refuses when MESH_PROJECT_TITLE is unset or empty', () => {
    expect(run(['get'], { title: null }).status).not.toBe(0)
    expect(run(['get'], { title: '' }).status).not.toBe(0)
    expect(ran()).toEqual([])
  })

  test('refuses when the workspace is another one, and runs nothing', () => {
    for (const where of ['Project: Test Project\nWorkspace: Production\n', 'Project: Test Project\nWorkspace: Stage 2\n', 'Project: Test Project\nWorkspace: Prod Stage\n', 'Project: Test Project\n']) {
      const r = run(['delete'], { where })
      expect(r.status).not.toBe(0)
      expect(r.stderr).toMatch(/workspace.*refusing/)
    }
    expect(run(['delete'], { workspace: 'St.ge' }).status).not.toBe(0) // regex characters match literally
    expect(ran()).toEqual([])
  })

  test('refuses before calling aio when MESH_WORKSPACE_NAME is unset or empty', () => {
    for (const workspace of [null, '']) {
      const r = run(['get'], { workspace })
      expect(r.status).not.toBe(0)
      expect(r.stderr).toMatch(/MESH_WORKSPACE_NAME/)
    }
    expect(ran()).toEqual([])
    expect(whereCalled()).toBe(false)
  })

  test('refuses before calling aio when MESH_PROJECT_TITLE is unset', () => {
    expect(run(['get'], { title: null }).status).not.toBe(0)
    expect(whereCalled()).toBe(false)
  })

  test('reads MESH_WORKSPACE_NAME from .env when the environment has none', () => {
    fs.writeFileSync(path.join(root, '.env'), 'MESH_WORKSPACE_NAME=Stage\n')
    expect(run(['get'], { workspace: null }).status).toBe(0)
    expect(run(['get'], { workspace: null, where: 'Project: Test Project\nWorkspace: Other\n' }).status).not.toBe(0)
  })

  test('reads MESH_PROJECT_TITLE from .env when the environment has none, and only that key', () => {
    fs.writeFileSync(path.join(root, '.env'), 'OTHER=1\nMESH_PROJECT_TITLE="Test Project"\n')
    expect(run(['get'], { title: null }).status).toBe(0)
    expect(run(['get'], { title: null, where: 'Project: Other\n' }).status).not.toBe(0)
  })

  test('refuses unknown commands and wrong arguments before calling aio', () => {
    expect(run([]).status).not.toBe(0)
    expect(run(['bogus']).status).not.toBe(0)
    expect(run(['create']).status).not.toBe(0)
    expect(run(['update', 'a.json', 'b.json']).status).not.toBe(0)
    expect(run(['get', '-c']).status).not.toBe(0)
    expect(run(['purge', '-c']).status).not.toBe(0)
    expect(run(['cache:purge']).status).not.toBe(0)
    expect(ran()).toEqual([])
  })

  test('on the right project it runs the one command; purge is -a and never -c', () => {
    expect(run(['purge']).status).toBe(0)
    expect(run(['get']).status).toBe(0)
    expect(run(['status']).status).toBe(0)
    expect(run(['describe']).status).toBe(0)
    expect(run(['delete']).status).toBe(0)
    expect(run(['create', 'out/v1/mesh.json']).status).toBe(0)
    expect(run(['update', 'out/v2/mesh.json']).status).toBe(0)
    expect(ran()).toEqual(['api-mesh:cache:purge -a', 'api-mesh:get', 'api-mesh:status', 'api-mesh:describe', 'api-mesh:delete', 'api-mesh:create out/v1/mesh.json', 'api-mesh:update out/v2/mesh.json'])
    expect(ran().join('\n')).not.toMatch(/ -c\b/)
  })

  test('a title with regex characters is matched literally', () => {
    expect(run(['get'], { title: 'A.B (x)', where: 'Project: AxB (x)\n' }).status).not.toBe(0)
    expect(run(['get'], { title: 'A.B (x)', where: 'Project: A.B (x)  \nWorkspace: Stage\n' }).status).toBe(0)
  })

  test('the script never contains -c for purge', () => {
    expect(fs.readFileSync(script, 'utf8')).toMatch(/cache:purge -a/)
    expect(fs.readFileSync(script, 'utf8')).not.toMatch(/cache:purge -c/)
  })
})
