/*
 * Ep 9 (Admin UI SDK V2): the App Management config that `aio-commerce-lib-app generate all` wrote from
 * app.commerce.config.ts. app.commerce.config.ts is TypeScript and not loaded here; the committed generated
 * manifest is the same data, checked with the library's own validator (CJS entry).
 * The validator runs in a plain Node process: its dependency tree has ESM-only packages (camelcase), and Jest's
 * module loader cannot require() those on every Node version CI runs.
 */
const { execFileSync } = require('child_process')
const path = require('path')
const manifest = require('../src/commerce-extensibility-1/.generated/app.commerce.manifest.json')

const script = `
const { validateCommerceAppConfig } = require('@adobe/aio-commerce-lib-app/config')
try {
  validateCommerceAppConfig(JSON.parse(process.argv[1]))
  console.log(JSON.stringify({ ok: true }))
} catch (e) {
  console.log(JSON.stringify({ ok: false, message: e.message }))
}`

const validate = config => JSON.parse(execFileSync(process.execPath, ['-e', script, JSON.stringify(config)], {
  cwd: path.join(__dirname, '..'),
  encoding: 'utf8'
}))

const copy = () => JSON.parse(JSON.stringify(manifest))

test('our app config validates and has the Stuck orders menu entry', () => {
  expect(validate(copy())).toEqual({ ok: true })
  expect(manifest.metadata.id).toBe('stuck-orders')
  expect(manifest.adminUi.menu).toEqual({
    description: 'Open stuck-order alerts and export deliveries',
    id: 'StuckOrders::stuck',
    label: 'Stuck orders',
    pageTitle: 'Stuck orders'
  })
})

test('a menu without a description does not validate', () => {
  const bad = copy()
  delete bad.adminUi.menu.description
  expect(validate(bad)).toEqual({ ok: false, message: 'Invalid commerce app config' })
})
