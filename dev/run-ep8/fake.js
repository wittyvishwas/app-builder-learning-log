/*
 * Talks to the fake-reviews web action. Reads FAKE_REVIEWS_URL and FAKE_REVIEWS_API_KEY from .env itself, so the key
 * never appears on a command line, in shell history or in a transcript.
 *   node dev/run-ep8/fake.js config <route> [--cache <string|null>] [--mode m] [--delay ms]
 *       POST /config. Replaces the whole config of the route, so give every value you want.
 *   node dev/run-ep8/fake.js calls [--since ms]      GET /calls
 *   node dev/run-ep8/fake.js clear                   DELETE /calls
 *   node dev/run-ep8/fake.js source '<path?query>' [--twice]
 *       GET a source route: prints status, Cache-Control, X-GW-Cache, X-MM-Call-Id and the body.
 */
const { loadEnv, need } = require('./env')

function flags (args) {
  const out = { _: [] }
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) { out._.push(args[i]); continue }
    const name = args[i].slice(2)
    out[name] = name === 'twice' ? true : args[++i]
  }
  return out
}

async function call (env, method, pathAndQuery, body) {
  const res = await fetch(env.FAKE_REVIEWS_URL.replace(/\/$/, '') + pathAndQuery, {
    method,
    headers: { 'x-mm-key': env.FAKE_REVIEWS_API_KEY, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  })
  return { res, text: await res.text() }
}

async function main (argv) {
  const [cmd, ...rest] = argv
  const f = flags(rest)
  const env = loadEnv()
  need(env, ['FAKE_REVIEWS_URL', 'FAKE_REVIEWS_API_KEY'])

  if (cmd === 'config') {
    if (!f._[0]) throw new Error('usage: fake.js config <route> [--cache <string|null>] [--mode m] [--delay ms]')
    const body = { route: f._[0] }
    if (f.cache !== undefined) body.cacheControl = f.cache === 'null' ? null : f.cache
    if (f.mode !== undefined) body.mode = f.mode
    if (f.delay !== undefined) body.delayMs = Number(f.delay)
    const { res, text } = await call(env, 'POST', '/config', body)
    console.log(res.status, text)
  } else if (cmd === 'calls') {
    const { res, text } = await call(env, 'GET', `/calls?since=${encodeURIComponent(f.since || 0)}`)
    console.log(res.status, text)
  } else if (cmd === 'clear') {
    const { res, text } = await call(env, 'DELETE', '/calls')
    console.log(res.status, text)
  } else if (cmd === 'source') {
    if (!f._[0]) throw new Error("usage: fake.js source '<path?query>' [--twice]")
    for (let i = 0; i < (f.twice ? 2 : 1); i++) {
      const { res, text } = await call(env, 'GET', f._[0])
      console.log(`status ${res.status}`)
      for (const h of ['Cache-Control', 'X-GW-Cache', 'X-MM-Call-Id']) console.log(`${h}: ${res.headers.get(h)}`)
      console.log(text)
    }
  } else {
    throw new Error('usage: fake.js <config|calls|clear|source> ...')
  }
}

main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exit(1) })
