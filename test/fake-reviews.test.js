/*
 * Unit tests for the Ep 8 fake review/stock source: State is faked.
 */
const mockStore = new Map()
const mockFail = { init: false, get: false, put: false }
const mockLogs = []
jest.mock('@adobe/aio-sdk', () => ({
  Core: {
    Logger: () => ({
      info: m => mockLogs.push(m), warn: m => mockLogs.push(m), error: m => mockLogs.push(m), debug: m => mockLogs.push(m)
    })
  }
}))
jest.mock('@adobe/aio-lib-state', () => ({
  init: async () => {
    if (mockFail.init) throw new Error('init boom')
    const state = require('./helpers').fakeState(mockStore)
    return {
      ...state,
      get: async k => { if (mockFail.get) throw new Error('get boom'); return state.get(k) },
      put: async (k, v, opts) => { if (mockFail.put) throw new Error('put boom'); return state.put(k, v, opts) }
    }
  }
}))

const { main, parseSkus } = require('../actions/fake-reviews')

const KEY = 'k'.repeat(16)
beforeEach(() => { mockStore.clear(); mockLogs.length = 0; Object.assign(mockFail, { init: false, get: false, put: false }) })

const call = (method, path, { query, body, key = KEY, header = KEY } = {}) => main({
  FAKE_REVIEWS_API_KEY: key,
  LOG_LEVEL: 'info',
  __ow_method: method,
  __ow_path: path,
  __ow_query: query,
  __ow_body: body === undefined ? undefined : Buffer.from(JSON.stringify(body)).toString('base64'),
  __ow_headers: header === null ? {} : { 'x-mm-key': header, 'user-agent': 'jest' }
})
const get = (path, query, opts) => call('get', path, { query, ...opts })
const config = body => call('post', '/config', { body })
const callKeys = () => [...mockStore.keys()].filter(k => k.startsWith('fake-reviews.call.'))
const records = () => callKeys().map(k => JSON.parse(mockStore.get(k)))

describe('auth and routing', () => {
  test('401 for no header, wrong key, unset key and short key, with no-store', async () => {
    const results = [
      await get('/reviews', 'skus=a', { header: null }),
      await get('/reviews', 'skus=a', { header: 'x'.repeat(16) }),
      await get('/reviews', 'skus=a', { header: KEY.slice(0, 15) }),
      await get('/reviews', 'skus=a', { key: undefined, header: 'undefined' }),
      await get('/reviews', 'skus=a', { key: 'short', header: 'short' }),
      await get('/reviews', 'skus=a', { key: '', header: '' }),
      await get('/calls', undefined, { header: null }),
      await config({ route: 'reviews' }).then(() => call('post', '/config', { body: { route: 'reviews' }, header: 'nope' }))
    ]
    for (const res of results) {
      expect(res.statusCode).toBe(401)
      expect(res.body).toEqual({ error: 'unauthorized' })
      expect(res.headers['Cache-Control']).toBe('no-store')
    }
    expect(callKeys()).toEqual([])
  })

  test('401 answers are not recorded', async () => {
    await get('/reviews', 'skus=a', { header: null })
    expect(mockStore.size).toBe(0)
  })

  test('404 for an unknown path or a wrong method', async () => {
    expect((await get('/other')).statusCode).toBe(404)
    expect((await get('')).statusCode).toBe(404)
    expect((await call('post', '/reviews')).statusCode).toBe(404)
    expect((await call('get', '/config')).statusCode).toBe(404)
    expect((await call('post', '/calls')).statusCode).toBe(404)
    expect((await call('delete', '/stock')).statusCode).toBe(404)
    expect(mockStore.size).toBe(0)
  })

  test('a trailing slash on the path is accepted', async () => {
    expect((await get('/stock/', 'skus=a')).statusCode).toBe(200)
  })
})

describe('parseSkus', () => {
  test('repeat', () => expect(parseSkus('skus=a&skus=b&skus=c', 'skus')).toEqual({ skus: ['a', 'b', 'c'], parseForm: 'repeat' }))
  test('json', () => expect(parseSkus('skus=%5B%22a%22%2C%22b%22%5D', 'skus')).toEqual({ skus: ['a', 'b'], parseForm: 'json' }))
  test('js-literal, URL-encoded quotes and spaces', () => {
    expect(parseSkus('skus=%5B%27a%27%2C%20%27b%27%5D', 'skus')).toEqual({ skus: ['a', 'b'], parseForm: 'js-literal' })
  })
  test('comma', () => expect(parseSkus('skus=a,%20b', 'skus')).toEqual({ skus: ['a', 'b'], parseForm: 'comma' }))
  test('single', () => expect(parseSkus('sku=abc', 'sku')).toEqual({ skus: ['abc'], parseForm: 'single' }))
  test('unparsed: nothing, empty value, broken bracket, bad escape', () => {
    for (const q of [undefined, '', 'other=a', 'skus=', 'skus=%5Bnot', 'skus=%E0%A4%A']) {
      expect(parseSkus(q, 'skus')).toEqual({ skus: [], parseForm: 'unparsed' })
    }
  })
  test('+ becomes a space before decoding, %2B stays a plus', () => {
    expect(parseSkus('skus=a+b', 'skus')).toEqual({ skus: ['a b'], parseForm: 'single' })
    expect(parseSkus('skus=a%2Bb', 'skus')).toEqual({ skus: ['a+b'], parseForm: 'single' })
    expect(parseSkus('skus=%5B%27a+b%27%5D', 'skus').skus).toEqual(['a b'])
  })
  test('a leading ? is ignored; only the named parameter counts', () => {
    expect(parseSkus('?x=1&skus=a', 'skus')).toEqual({ skus: ['a'], parseForm: 'single' })
  })
})

describe('source routes', () => {
  test('/reviews: one inner array per SKU, in order, with the call id in the body and one record', async () => {
    const res = await get('/reviews', 'skus=%5B%27a%27%2C%20%27bb%27%2C%20%27c%27%5D')
    expect(res.statusCode).toBe(200)
    expect(res.headers['Content-Type']).toBe('application/json')
    const body = JSON.parse(res.body)
    expect(body.map(inner => inner.map(r => r.sku))).toEqual([['a'], ['bb'], ['c']])
    const callId = res.headers['X-MM-Call-Id']
    expect(callId).toMatch(/^\d+-[0-9a-f]{6}$/)
    for (const inner of body) {
      expect(inner).toHaveLength(1)
      expect(inner[0]).toMatchObject({ title: 'MMTEST review', author: 'mmtest', body: `call ${callId}` })
    }
    expect(body[0][0].rating).toBe(1 + (97 % 5))
    expect(body[1][0].rating).toBe(1 + ((98 + 98) % 5))
    const [rec] = records()
    expect(records()).toHaveLength(1)
    expect(rec).toMatchObject({ callId, route: 'reviews', rawQuery: 'skus=%5B%27a%27%2C%20%27bb%27%2C%20%27c%27%5D', skus: ['a', 'bb', 'c'], parseForm: 'js-literal', mode: 'ok', userAgent: 'jest' })
    expect(callKeys()[0]).toBe(`fake-reviews.call.reviews.${callId}`)
  })

  test('/stock: one object per SKU in order', async () => {
    const res = await get('/stock', 'skus=a,b')
    const callId = res.headers['X-MM-Call-Id']
    expect(JSON.parse(res.body)).toEqual([{ sku: 'a', qty: 7, callId }, { sku: 'b', qty: 7, callId }])
  })

  test('/review: a flat array with one review', async () => {
    const res = await get('/review', 'sku=abc')
    const body = JSON.parse(res.body)
    expect(body).toEqual([{ sku: 'abc', rating: 1 + ((97 + 98 + 99) % 5), title: 'MMTEST review', author: 'mmtest', body: `call ${res.headers['X-MM-Call-Id']}` }])
    expect(records()[0]).toMatchObject({ route: 'review', skus: ['abc'], parseForm: 'single' })
  })

  test('an unparsable query still answers 200 [] and records it', async () => {
    const res = await get('/reviews', 'skus=')
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual([])
    expect(records()[0]).toMatchObject({ parseForm: 'unparsed', skus: [] })
  })

  test('rawQuery in the record is cut at 3000 characters', async () => {
    await get('/reviews', 'skus=' + 'x'.repeat(4000))
    expect(records()[0].rawQuery).toHaveLength(3000)
  })

  test('logs carry route, call id, count and mode only', async () => {
    await get('/reviews', 'skus=secret-sku')
    const logs = mockLogs.join('\n')
    expect(logs).toMatch(/reviews \d+-[0-9a-f]{6}: 1 SKUs, mode ok/)
    expect(logs).not.toContain(KEY)
    expect(logs).not.toContain('secret-sku')
  })
})

describe('Cache-Control', () => {
  test('no-store when nothing is stored', async () => {
    const res = await get('/reviews', 'skus=a')
    expect(res.headers['Cache-Control']).toBe('no-store')
    expect(records()[0].cacheControlSent).toBe('no-store')
  })
  test('the configured string', async () => {
    await config({ route: 'reviews', cacheControl: 'public, max-age=300' })
    const res = await get('/reviews', 'skus=a')
    expect(res.headers['Cache-Control']).toBe('public, max-age=300')
    expect(records()[0].cacheControlSent).toBe('public, max-age=300')
  })
  test('no header at all when the config says null', async () => {
    await config({ route: 'reviews', cacheControl: null })
    const res = await get('/reviews', 'skus=a')
    expect('Cache-Control' in res.headers).toBe(false)
    expect(records()[0].cacheControlSent).toBeNull()
  })
  test('a config of one route does not touch another', async () => {
    await config({ route: 'stock', cacheControl: 'public, max-age=5' })
    expect((await get('/reviews', 'skus=a')).headers['Cache-Control']).toBe('no-store')
  })
})

describe('modes', () => {
  test('http500: status 500, the configured Cache-Control, call id', async () => {
    await config({ route: 'reviews', mode: 'http500', cacheControl: 'public, max-age=60' })
    const res = await get('/reviews', 'skus=a')
    expect(res.statusCode).toBe(500)
    expect(JSON.parse(res.body)).toEqual({ error: 'mmtest failure' })
    expect(res.headers['Cache-Control']).toBe('public, max-age=60')
    expect(res.headers['X-MM-Call-Id']).toBeDefined()
  })

  test('slow: the record is written before the wait', async () => {
    jest.useFakeTimers()
    try {
      await config({ route: 'stock', mode: 'slow', delayMs: 5000 })
      let done = false
      const p = get('/stock', 'skus=a').then(r => { done = true; return r })
      await jest.advanceTimersByTimeAsync(10)
      expect(records()).toHaveLength(1)
      expect(records()[0]).toMatchObject({ mode: 'slow', delayMs: 5000 })
      expect(done).toBe(false)
      await jest.advanceTimersByTimeAsync(5000)
      const res = await p
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toHaveLength(1)
    } finally {
      jest.useRealTimers()
    }
  })

  test('badjson: 200, JSON content type, body that does not parse', async () => {
    await config({ route: 'reviews', mode: 'badjson' })
    const res = await get('/reviews', 'skus=a')
    expect(res.statusCode).toBe(200)
    expect(res.headers['Content-Type']).toBe('application/json')
    expect(res.body).toBe('not json {')
    expect(() => JSON.parse(res.body)).toThrow()
  })

  test('reverse: reviews and stock come back in reverse order', async () => {
    await config({ route: 'reviews', mode: 'reverse' })
    await config({ route: 'stock', mode: 'reverse' })
    expect(JSON.parse((await get('/reviews', 'skus=a,b,c')).body).map(i => i[0].sku)).toEqual(['c', 'b', 'a'])
    expect(JSON.parse((await get('/stock', 'skus=a,b,c')).body).map(i => i.sku)).toEqual(['c', 'b', 'a'])
  })

  test('short: the last element is dropped', async () => {
    await config({ route: 'reviews', mode: 'short' })
    await config({ route: 'stock', mode: 'short' })
    expect(JSON.parse((await get('/reviews', 'skus=a,b,c')).body).map(i => i[0].sku)).toEqual(['a', 'b'])
    expect(JSON.parse((await get('/stock', 'skus=a,b,c')).body).map(i => i.sku)).toEqual(['a', 'b'])
  })

  test('badschema: rating 7 and no sku (reviews and review)', async () => {
    await config({ route: 'reviews', mode: 'badschema' })
    await config({ route: 'review', mode: 'badschema' })
    const reviews = JSON.parse((await get('/reviews', 'skus=a,b')).body)
    expect(reviews).toHaveLength(2)
    for (const r of reviews.flat()) { expect(r.rating).toBe(7); expect('sku' in r).toBe(false) }
    const one = JSON.parse((await get('/review', 'sku=a')).body)
    expect(one[0].rating).toBe(7)
    expect('sku' in one[0]).toBe(false)
  })
})

describe('POST /config', () => {
  test('a valid POST stores and returns the full config', async () => {
    const res = await config({ route: 'reviews', cacheControl: 'public, max-age=1', mode: 'slow', delayMs: 100 })
    expect(res.statusCode).toBe(200)
    expect(res.headers['Cache-Control']).toBe('no-store')
    const expected = { route: 'reviews', cacheControl: 'public, max-age=1', mode: 'slow', delayMs: 100 }
    expect(res.body).toEqual(expected)
    expect(JSON.parse(mockStore.get('fake-reviews.config.reviews'))).toEqual(expected)
  })

  test('a second POST replaces, it does not merge: omitted fields take the defaults', async () => {
    await config({ route: 'reviews', cacheControl: 'public, max-age=1', mode: 'http500', delayMs: 100 })
    const res = await config({ route: 'reviews' })
    expect(res.body).toEqual({ route: 'reviews', cacheControl: 'no-store', mode: 'ok', delayMs: 0 })
    expect(JSON.parse(mockStore.get('fake-reviews.config.reviews'))).toEqual(res.body)
  })

  test('an explicit null cacheControl is kept', async () => {
    expect((await config({ route: 'stock', cacheControl: null })).body.cacheControl).toBeNull()
  })

  test('400 for every validation error', async () => {
    const bad = [
      undefined, [], 'text',
      {}, { route: 'nope' }, { route: 1 },
      { route: 'reviews', cacheControl: '' },
      { route: 'reviews', cacheControl: 'x'.repeat(201) },
      { route: 'reviews', cacheControl: 'tab\there' },
      { route: 'reviews', cacheControl: 'café' },
      { route: 'reviews', cacheControl: 5 },
      { route: 'reviews', mode: 'nope' },
      { route: 'review', mode: 'reverse' },
      { route: 'review', mode: 'short' },
      { route: 'stock', mode: 'badschema' },
      { route: 'reviews', delayMs: -1 },
      { route: 'reviews', delayMs: 55001 },
      { route: 'reviews', delayMs: 1.5 },
      { route: 'reviews', delayMs: '5' }
    ]
    for (const body of bad) {
      const res = await config(body)
      expect(res.statusCode).toBe(400)
      expect(res.headers['Cache-Control']).toBe('no-store')
    }
    expect([...mockStore.keys()]).toEqual([])
  })

  test('limits are accepted: 1 and 200 characters, delay 0 and 55000', async () => {
    expect((await config({ route: 'reviews', cacheControl: 'x' })).statusCode).toBe(200)
    expect((await config({ route: 'reviews', cacheControl: 'x'.repeat(200) })).statusCode).toBe(200)
    expect((await config({ route: 'reviews', delayMs: 55000 })).statusCode).toBe(200)
  })

  test('400 for a body that is not JSON or missing; a plain (not base64) JSON body also works', async () => {
    expect((await main({ FAKE_REVIEWS_API_KEY: KEY, __ow_method: 'post', __ow_path: '/config', __ow_headers: { 'x-mm-key': KEY }, __ow_body: Buffer.from('not json').toString('base64') })).statusCode).toBe(400)
    expect((await main({ FAKE_REVIEWS_API_KEY: KEY, __ow_method: 'post', __ow_path: '/config', __ow_headers: { 'x-mm-key': KEY } })).statusCode).toBe(400)
    const plain = await main({ FAKE_REVIEWS_API_KEY: KEY, __ow_method: 'post', __ow_path: '/config', __ow_headers: { 'x-mm-key': KEY }, __ow_body: '{"route":"stock"}' })
    expect(plain.statusCode).toBe(200)
  })

  test('base64 body decoding', async () => {
    const res = await main({
      FAKE_REVIEWS_API_KEY: KEY,
      __ow_method: 'post',
      __ow_path: '/config',
      __ow_headers: { 'x-mm-key': KEY },
      __ow_body: Buffer.from('{"route":"stock","mode":"short"}').toString('base64')
    })
    expect(res.body).toMatchObject({ route: 'stock', mode: 'short' })
  })

  test('503 with a fixed body when State fails', async () => {
    mockFail.put = true
    const res = await config({ route: 'reviews' })
    expect(res.statusCode).toBe(503)
    expect(res.body).toEqual({ error: 'storage unavailable' })
  })
})

describe('/calls', () => {
  const seed = (route, at, extra = {}) => mockStore.set(`fake-reviews.call.${route}.${at}-aaaaaa`, JSON.stringify({ callId: `${at}-aaaaaa`, at, route, ...extra }))

  test('GET filters by since and sorts by at', async () => {
    seed('reviews', 300); seed('stock', 100); seed('review', 200)
    const all = await call('get', '/calls')
    expect(all.statusCode).toBe(200)
    expect(all.headers['Cache-Control']).toBe('no-store')
    expect(all.body.count).toBe(3)
    expect(all.body.calls.map(c => c.at)).toEqual([100, 200, 300])
    const some = await call('get', '/calls', { query: 'since=200' })
    expect(some.body.calls.map(c => c.at)).toEqual([200, 300])
    expect(some.body.count).toBe(2)
    expect((await call('get', '/calls', { query: 'since=abc' })).body.count).toBe(3)
  })

  test('since filters on the timestamp in the key, without reading older records', async () => {
    mockStore.set('fake-reviews.call.reviews.100-aaaaaa', 'not json {') // would throw if it were read
    seed('stock', 300)
    const res = await call('get', '/calls', { query: 'since=200' })
    expect(res.statusCode).toBe(200)
    expect(res.body.calls.map(c => c.at)).toEqual([300])
  })

  test('a key without a readable timestamp is read and filtered by the record\'s own at', async () => {
    mockStore.set('fake-reviews.call.reviews.odd', JSON.stringify({ callId: 'odd', at: 500, route: 'reviews' }))
    mockStore.set('fake-reviews.call.reviews.odd2', JSON.stringify({ callId: 'odd2', at: 50, route: 'reviews' }))
    const res = await call('get', '/calls', { query: 'since=200' })
    expect(res.body.calls.map(c => c.callId)).toEqual(['odd'])
  })

  test('a real source call shows up', async () => {
    await get('/reviews', 'skus=a')
    const res = await call('get', '/calls')
    expect(res.body.count).toBe(1)
    expect(res.body.calls[0].route).toBe('reviews')
  })

  test('DELETE removes only fake-reviews.call.* keys', async () => {
    seed('reviews', 1); seed('stock', 2)
    mockStore.set('fake-reviews.config.reviews', '{}')
    mockStore.set('fake-erp.1', '{}')
    const res = await call('delete', '/calls')
    expect(res.body).toEqual({ deleted: 2 })
    expect([...mockStore.keys()].sort()).toEqual(['fake-erp.1', 'fake-reviews.config.reviews'])
  })

  test('503 with a fixed body when State fails', async () => {
    mockFail.init = true
    for (const m of ['get', 'delete']) {
      const res = await call(m, '/calls')
      expect(res.statusCode).toBe(503)
      expect(res.body).toEqual({ error: 'storage unavailable' })
    }
  })
})

describe('State failures do not fail the source answer', () => {
  test('on recording', async () => {
    mockFail.put = true
    const res = await get('/reviews', 'skus=a,b')
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toHaveLength(2)
    expect(mockLogs.join('\n')).toMatch(/recording failed/)
    expect(mockLogs.join('\n')).not.toMatch(/boom/)
  })
  test('on reading the config: the default config is used', async () => {
    await config({ route: 'reviews', mode: 'http500', cacheControl: 'public, max-age=9' })
    mockFail.get = true
    const res = await get('/reviews', 'skus=a')
    expect(res.statusCode).toBe(200)
    expect(res.headers['Cache-Control']).toBe('no-store')
  })
  test('on init', async () => {
    mockFail.init = true
    const res = await get('/stock', 'skus=a')
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toHaveLength(1)
  })
  test('a corrupt stored config falls back to the default', async () => {
    mockStore.set('fake-reviews.config.reviews', 'not json')
    expect((await get('/reviews', 'skus=a')).statusCode).toBe(200)
  })
})

test('the key is final in app.config.yaml', () => {
  const cfg = require('fs').readFileSync(require('path').join(__dirname, '../app.config.yaml'), 'utf8')
  const block = cfg.slice(cfg.indexOf('fake-reviews:'))
  expect(block).toMatch(/FAKE_REVIEWS_API_KEY: \$FAKE_REVIEWS_API_KEY[\s\S]*raw-http: true[\s\S]*final: true/)
})
