/*
 * Tests for dev/run-ep11/journal-pull.js: fake fetch, injected env and token, no .env, no network.
 */
const { scriptedFetch } = require('./helpers')
const { MAX_PAGES, parseArgs, nextLink, matchesOrder, eventId, pullEvents, buildRequest, run } = require('../dev/run-ep11/journal-pull')

const TOKEN = 'tok-SECRET-abc123'
const API_KEY = 'apikey-SECRET-xyz789'
const ENV = {
  JOURNAL_URL: 'https://journal.example.test/events/organizations/o/integrations/i/r',
  IMS_OAUTH_S2S_CLIENT_ID: API_KEY,
  IMS_OAUTH_S2S_ORG_ID: 'org@AdobeOrg'
}
const HANDLER = 'http://localhost:9080/api/v1/web/events/order-placed'

const entry = (id, increment_id) => ({
  position: `pos-${id}`,
  event: { '@id': id, '@type': 'x', data: { value: { order: { increment_id, grand_total: '10' } } } }
})

// The journal: GET answers come from `pages` in order (then 204); every response carries a next link while it has events.
// POSTs go to a scriptedFetch of their own. Journal requests are kept in `gets`.
function fakeNet (pages, postStatuses = [200]) {
  const queue = [...pages]
  const posts = scriptedFetch(postStatuses)
  const gets = []
  const fetchImpl = async (url, options) => {
    if (options.method === 'POST') return posts(url, options)
    gets.push({ url, options })
    const events = queue.shift()
    if (!events) return { status: 204, headers: new Map([['link', '</next?since=end>; rel="next"']]), json: async () => { throw new Error('no body') } }
    return {
      status: 200,
      headers: new Map([['link', `</events/next?since=${gets.length}>; rel="next"`]]),
      json: async () => ({ events, _page: { count: events.length } })
    }
  }
  return { fetchImpl, posts, gets }
}

async function runCli (argv, net, env = ENV) {
  const out = []
  const errs = []
  const code = await run({ argv, env, fetchImpl: net.fetchImpl, getToken: async () => TOKEN, log: m => out.push(m), err: m => errs.push(m) })
  return { code, out, errs, all: [...out, ...errs].join('\n') }
}

describe('parseArgs', () => {
  test('--order is required', () => {
    expect(() => parseArgs([])).toThrow(/--order is required/)
    expect(() => parseArgs(['--post', HANDLER])).toThrow(/--order is required/)
  })
  test('order alone is a dry run; --post takes a local URL', () => {
    expect(parseArgs(['--order', '000000201'])).toEqual({ order: '000000201', post: undefined })
    expect(parseArgs(['--order', '1', '--post', HANDLER]).post).toBe(HANDLER)
  })
  test('--dry-run is an explicit no-op, and cannot be combined with --post', () => {
    expect(parseArgs(['--order', '1', '--dry-run'])).toEqual({ order: '1', post: undefined })
    expect(() => parseArgs(['--order', '1', '--dry-run', '--post', HANDLER])).toThrow(/cannot be combined/)
  })
  test('the --post guard rejects look-alike hosts and other schemes, accepts IPv6 loopback', () => {
    for (const bad of ['http://localhost.evil.com/x', 'http://localhost@evil.test/x', 'ftp://localhost/x']) {
      expect(() => parseArgs(['--order', '1', '--post', bad])).toThrow(/on this machine/)
    }
    expect(parseArgs(['--order', '1', '--post', 'http://[::1]:9080/']).post).toBe('http://[::1]:9080/')
  })
  test('refuses unknown flags, a missing value and a non-local --post', () => {
    expect(() => parseArgs(['--order', '1', '--bogus'])).toThrow(/unknown argument/)
    expect(() => parseArgs(['--order'])).toThrow(/needs a value/)
    expect(() => parseArgs(['--order', '1', '--post', 'https://app.example.test/x'])).toThrow(/on this machine/)
    expect(() => parseArgs(['--order', '1', '--post', 'nope'])).toThrow(/not a URL/)
  })
})

describe('matching and paging helpers', () => {
  test('matches on data.value.order.increment_id only', () => {
    expect(matchesOrder(entry('a', '000000201'), '000000201')).toBe(true)
    expect(matchesOrder(entry('a', '000000202'), '000000201')).toBe(false)
    expect(matchesOrder({ event: { data: { value: { increment_id: '000000201' } } } }, '000000201')).toBe(false)
    expect(matchesOrder({}, '000000201')).toBe(false)
  })
  test('a CloudEvent-shaped entry matches and uses event.id', () => {
    const ce = { specversion: '1.0', id: 'ce-1', type: 't', source: 's', data: { value: { order: { increment_id: '000000201' } } } }
    expect(matchesOrder({ position: 'p', event: ce }, '000000201')).toBe(true)
    expect(eventId({ position: 'p', event: ce })).toBe('ce-1')
  })
  test('nextLink resolves the rel="next" link against the journal URL', () => {
    expect(nextLink('</events/x?since=9>; rel="next"', 'https://j.example.test/events/a')).toBe('https://j.example.test/events/x?since=9')
    expect(nextLink('<https://o.example.test/a>; rel="prev", <https://o.example.test/b>; rel="next"', 'https://j.example.test/')).toBe('https://o.example.test/b')
    expect(nextLink(undefined, 'https://j.example.test/')).toBeUndefined()
  })
})

describe('run', () => {
  test('dry run lists the matching event and posts nothing', async () => {
    const net = fakeNet([[entry('e1', '000000201'), entry('e2', '000000999')]])
    const r = await runCli(['--order', '000000201'], net)
    expect(r.code).toBe(0)
    expect(r.out[0]).toBe('event e1 order 000000201 (dry run)')
    expect(r.all).not.toMatch(/e2|000000999/)
    expect(r.out[1]).toMatch(/2 event\(s\) read, 1 for order 000000201, 1 for other orders/)
    expect(net.posts).not.toHaveBeenCalled()
  })

  test('the journal request carries the token, key and org, and follows the next link to the 204', async () => {
    const net = fakeNet([[entry('e1', '1')], [entry('e2', '1')]])
    await runCli(['--order', '1'], net)
    expect(net.gets).toHaveLength(3)
    expect(net.gets[0].url).toBe(ENV.JOURNAL_URL)
    expect(net.gets[0].options.headers).toEqual({ Authorization: `Bearer ${TOKEN}`, 'x-api-key': API_KEY, 'x-ims-org-id': 'org@AdobeOrg' })
    expect(net.gets[1].url).toBe('https://journal.example.test/events/next?since=1')
  })

  test('with --post, one POST with the matching event body and its status printed', async () => {
    const e1 = entry('e1', '000000201')
    const net = fakeNet([[entry('e0', '000000500'), e1]], [202])
    const r = await runCli(['--order', '000000201', '--post', HANDLER], net)
    expect(r.code).toBe(0)
    expect(net.posts).toHaveBeenCalledTimes(1)
    const [url, options] = net.posts.mock.calls[0]
    expect(url).toBe(HANDLER)
    expect(options.method).toBe('POST')
    expect(JSON.parse(options.body)).toEqual(e1.event)
    expect(r.out[0]).toBe('event e1 -> 202')
  })

  test('a journal with only other orders lists nothing and reports the count', async () => {
    const net = fakeNet([[entry('e1', '000000300'), entry('e2', '000000301')]])
    const r = await runCli(['--order', '000000201', '--post', HANDLER], net)
    expect(r.code).toBe(0)
    expect(r.out).toEqual(['2 event(s) read, 0 for order 000000201, 2 for other orders (not listed)'])
    expect(net.posts).not.toHaveBeenCalled()
  })

  test('an empty journal (204) lists and posts nothing', async () => {
    const net = fakeNet([])
    const r = await runCli(['--order', '000000201', '--post', HANDLER], net)
    expect(r.code).toBe(0)
    expect(r.out).toEqual(['0 event(s) read, 0 for order 000000201, 0 for other orders (not listed)'])
    expect(net.gets).toHaveLength(1)
    expect(net.posts).not.toHaveBeenCalled()
  })

  test('--dry-run behaves as the default', async () => {
    const net = fakeNet([[entry('e1', '1')]])
    const r = await runCli(['--order', '1', '--dry-run'], net)
    expect(r.code).toBe(0)
    expect(r.out[0]).toBe('event e1 order 1 (dry run)')
    expect(net.posts).not.toHaveBeenCalled()
  })

  test('a CloudEvent-shaped entry is found and posted by its event.id', async () => {
    const ce = { specversion: '1.0', id: 'ce-1', type: 't', source: 's', data: { value: { order: { increment_id: '7' } } } }
    const net = fakeNet([[{ position: 'p1', event: ce }]], [200])
    const r = await runCli(['--order', '7', '--post', HANDLER], net)
    expect(r.out[0]).toBe('event ce-1 -> 200')
  })

  test('51 pages: stops after the cap and says so', async () => {
    const net = fakeNet(Array.from({ length: MAX_PAGES + 1 }, (_, i) => [entry(`e${i}`, '1')]))
    const r = await runCli(['--order', '1'], net)
    expect(net.gets).toHaveLength(MAX_PAGES)
    expect(r.code).toBe(0)
    expect(r.errs).toContain('stopped after 50 pages; more events may exist')
    expect(r.out.at(-1)).toMatch(/^50 event\(s\) read/)
    const p = await pullEvents(fakeNet([[entry('a', '1')], [entry('b', '1')], [entry('c', '1')]]).fetchImpl, buildRequest(ENV, TOKEN), 2)
    expect(p.truncated).toBe(true)
    expect(p.entries).toHaveLength(2)
  })

  test('a short journal is not reported as truncated', async () => {
    const r = await runCli(['--order', '1'], fakeNet([[entry('e1', '1')]]))
    expect(r.errs).toEqual([])
  })

  test('a next link to another host is not followed and the token is not sent there', async () => {
    for (const link of ['<https://evil.test/next>; rel="next"', '<http://journal.example.test/next>; rel="next"']) {
      const gets = []
      const fetchImpl = async (url, options) => {
        gets.push(url)
        return { status: 200, headers: new Map([['link', link]]), json: async () => ({ events: [entry('e1', '1')] }) }
      }
      const r = await runCli(['--order', '1'], { fetchImpl })
      expect(gets).toEqual([ENV.JOURNAL_URL])
      expect(r.code).toBe(0)
      expect(r.errs).toContain('next link to another host ignored')
      expect(r.out[0]).toBe('event e1 order 1 (dry run)')
    }
  })

  test('a 200 page without a Link header stops paging', async () => {
    const gets = []
    const fetchImpl = async (url) => { gets.push(url); return { status: 200, headers: new Map(), json: async () => ({ events: [entry('e1', '1')] }) } }
    const r = await runCli(['--order', '1'], { fetchImpl })
    expect(gets).toHaveLength(1)
    expect(r.code).toBe(0)
    expect(r.out.at(-1)).toMatch(/^1 event\(s\) read/)
  })

  test('a 200 page with an empty events array stops paging', async () => {
    const gets = []
    const fetchImpl = async (url) => { gets.push(url); return { status: 200, headers: new Map([['link', '</n>; rel="next"']]), json: async () => ({ events: [] }) } }
    const r = await runCli(['--order', '1'], { fetchImpl })
    expect(gets).toHaveLength(1)
    expect(r.out).toEqual(['0 event(s) read, 0 for order 1, 0 for other orders (not listed)'])
  })

  test('a non-200 on a later page fails with its status', async () => {
    let n = 0
    const fetchImpl = async () => (++n === 1
      ? { status: 200, headers: new Map([['link', '</n>; rel="next"']]), json: async () => ({ events: [entry('e1', '1')] }) }
      : { status: 500, headers: new Map(), json: async () => ({}) })
    const r = await runCli(['--order', '1'], { fetchImpl })
    expect(r.code).toBe(1)
    expect(r.errs.join('')).toMatch(/journal answered 500/)
  })

  test('--post does not follow redirects: a 307 is a failure', async () => {
    const e1 = entry('e1', '1')
    const net = fakeNet([[e1]], [307])
    const r = await runCli(['--order', '1', '--post', HANDLER], net)
    expect(r.code).toBe(1)
    expect(net.posts.mock.calls[0][1].redirect).toBe('manual')
    expect(r.errs.join('')).toMatch(/post redirected, not followed/)
    expect(r.out.join('')).not.toMatch(/-> 307/)
  })

  test('a failed --post shows the cause code', async () => {
    const base = fakeNet([[entry('e1', '1')]])
    const fetchImpl = async (url, options) => {
      if (options.method === 'POST') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
      return base.fetchImpl(url, options)
    }
    const r = await runCli(['--order', '1', '--post', HANDLER], { fetchImpl })
    expect(r.code).toBe(1)
    expect(r.errs.join('')).toMatch(/fetch failed \(ECONNREFUSED\)/)
  })

  test('a missing --order exits 2 before any request', async () => {
    const net = fakeNet([[entry('e1', '1')]])
    const r = await runCli([], net)
    expect(r.code).toBe(2)
    expect(net.gets).toHaveLength(0)
    expect(net.posts).not.toHaveBeenCalled()
  })

  test('a failing journal exits 1 with the status and without the token or key', async () => {
    const fetchImpl = async () => ({ status: 403, headers: new Map(), json: async () => ({}) })
    const r = await runCli(['--order', '1'], { fetchImpl })
    expect(r.code).toBe(1)
    expect(r.errs.join('')).toMatch(/journal answered 403/)
    expect(r.all).not.toContain(TOKEN)
    expect(r.all).not.toContain(API_KEY)
  })

  test('missing .env values exit 1 and name the keys, not values', async () => {
    const r = await runCli(['--order', '1'], fakeNet([]), { IMS_OAUTH_S2S_CLIENT_ID: API_KEY })
    expect(r.code).toBe(1)
    expect(r.errs.join('')).toMatch(/JOURNAL_URL/)
    expect(r.all).not.toContain(API_KEY)
  })

  test('output never contains the token or the api key', async () => {
    for (const argv of [['--order', '000000201'], ['--order', '000000201', '--post', HANDLER]]) {
      const r = await runCli(argv, fakeNet([[entry('e1', '000000201'), entry('e2', '5')]]))
      expect(r.all).not.toContain(TOKEN)
      expect(r.all).not.toContain(API_KEY)
    }
  })
})
