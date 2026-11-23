/*
 * Ep 9 (Admin UI SDK V2): the four StuckOrders data actions keep the settings that protect them, the
 * V2 extension points are wired in app.config.yaml, and the generated App Management actions run on Node 24.
 * The page itself is not tested here (it needs a Commerce admin that hosts the app).
 * js-yaml is not a direct dependency: it comes with the Adobe CLI packages and is pinned by the lock file.
 */
const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')

const root = path.join(__dirname, '..')
const load = rel => yaml.load(fs.readFileSync(path.join(root, rel), 'utf8'))

const v2Dir = 'src/commerce-backend-ui-2'
const v2 = load(`${v2Dir}/ext.config.yaml`)
const stuck = v2.runtimeManifest.packages.StuckOrders.actions
const names = ['list-alerts', 'mark-handled', 'list-deliveries', 'retry-delivery']

test('the StuckOrders package has exactly the four data actions', () => {
  expect(Object.keys(stuck).sort()).toEqual([...names].sort())
})

describe.each(names)('StuckOrders/%s', name => {
  const action = stuck[name]

  test('is a protected web action', () => {
    expect(action.web).toBe('yes')
    expect(action.annotations['require-adobe-auth']).toBe(true)
    expect(action.annotations.final).toBe(true)
    expect(action.annotations['include-ims-credentials']).toBe(true)
  })

  test('takes the client allowlist as an input', () => {
    expect(action.inputs.ALLOWED_CLIENT_IDS).toBe('$ALLOWED_CLIENT_IDS')
  })

  test('runs on nodejs:20', () => {
    expect(action.runtime).toBe('nodejs:20')
  })

  test('its function file exists next to the V2 ext.config.yaml', () => {
    expect(action.function).toBe(`actions/${name}/index.js`)
    expect(fs.existsSync(path.join(root, v2Dir, action.function))).toBe(true)
  })
})

test('app.config.yaml includes backend-ui/2 and extensibility/1, and no backend-ui/1', () => {
  const app = load('app.config.yaml')
  expect(Object.keys(app.extensions)).toEqual(['commerce/backend-ui/2', 'commerce/extensibility/1'])
  expect(app.extensions['commerce/backend-ui/2'].$include).toBe(`${v2Dir}/ext.config.yaml`)
  expect(app.extensions['commerce/extensibility/1'].$include).toBe('src/commerce-extensibility-1/ext.config.yaml')
  expect(fs.readFileSync(path.join(root, 'app.config.yaml'), 'utf8')).not.toContain('commerce/backend-ui/1')
})

test('the V1 registration action is gone', () => {
  expect(fs.existsSync(path.join(root, 'src/commerce-backend-ui-1/actions/registration'))).toBe(false)
})

test('the generated App Management actions are pinned to nodejs:24', () => {
  const ext = load('src/commerce-extensibility-1/ext.config.yaml')
  const actions = ext.runtimeManifest.packages['app-management'].actions
  expect(Object.keys(actions).length).toBeGreaterThan(0)
  for (const [name, action] of Object.entries(actions)) {
    expect([name, action.runtime]).toEqual([name, 'nodejs:24'])
  }
})
