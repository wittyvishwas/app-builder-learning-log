const fs = require('fs')
const path = require('path')

// utils.js is browser ESM and the repo has no babel config, so jest can't import it. Read the source,
// drop the `export` keyword and build the function by hand with a fake require and fetch.
const file = path.join(__dirname, '..', 'src', 'commerce-backend-ui-1', 'web-src', 'src', 'utils.js')
const original = fs.readFileSync(file, 'utf8')
const src = original.replace('export async function callAction', 'async function callAction')

function build (fetchMock) {
  const fakeRequire = p => {
    expect(p).toBe('./config.json')
    return { 'StuckOrders/list-alerts': 'http://x' }
  }
  // eslint-disable-next-line no-new-func
  return new Function('require', 'fetch', src + '; return callAction')(fakeRequire, fetchMock)
}

function reply (status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => body }
}

const props = { ims: { token: 't', org: 'o' } }

describe('callAction', () => {
  test('the export strip matched', () => {
    expect(src).not.toBe(original)
    expect(src).not.toMatch(/\bexport\b/)
  })

  test('200 JSON returns the data and sends the IMS headers', async () => {
    const fetchMock = jest.fn(async () => reply(200, '[{"order":"1"}]'))
    const data = await build(fetchMock)(props, 'StuckOrders/list-alerts', { a: 1 })
    expect(data).toEqual([{ order: '1' }])
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('http://x')
    expect(opts.headers.authorization).toBe('Bearer t')
    expect(opts.headers['x-gw-ims-org-id']).toBe('o')
    expect(opts.body).toBe('{"a":1}')
  })

  test('401 JSON error throws the error text', async () => {
    const fetchMock = jest.fn(async () => reply(401, '{"error":"x"}'))
    await expect(build(fetchMock)(props, 'StuckOrders/list-alerts')).rejects.toThrow('x')
  })

  test('502 HTML throws the HTTP status', async () => {
    const fetchMock = jest.fn(async () => reply(502, '<!DOCTYPE html><html></html>'))
    await expect(build(fetchMock)(props, 'StuckOrders/list-alerts')).rejects.toThrow('HTTP 502')
  })

  test('502 with an empty body throws the HTTP status', async () => {
    const fetchMock = jest.fn(async () => reply(502, ''))
    await expect(build(fetchMock)(props, 'StuckOrders/list-alerts')).rejects.toThrow('HTTP 502')
  })

  test('200 HTML throws that the response is not JSON', async () => {
    const fetchMock = jest.fn(async () => reply(200, '<html></html>'))
    await expect(build(fetchMock)(props, 'StuckOrders/list-alerts')).rejects.toThrow('HTTP 200: response is not JSON')
  })
})
