// Reads KEY=VALUE lines of a .env file. The CLI scripts call this once at start-up and pass the result on;
// nothing here is used by the unit tests.
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '../..')

function parseEnv (text) {
  const env = {}
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (!m) continue
    let v = m[2].trim()
    if (/^(".*"|'.*')$/.test(v)) v = v.slice(1, -1)
    env[m[1]] = v
  }
  return env
}

function loadEnv (file = path.join(ROOT, '.env')) {
  return parseEnv(fs.readFileSync(file, 'utf8'))
}

function need (env, names) {
  const missing = names.filter(n => !env[n])
  if (missing.length) throw new Error(`missing in .env: ${missing.join(', ')}`)
}

module.exports = { ROOT, parseEnv, loadEnv, need }
