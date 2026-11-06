/*
 * Ep 9: the registration action returns the same shape as Adobe's v1 custom-menu sample
 * (registration.menuItems with id/title/parent/sortOrder, a section with isSection, and registration.page.title),
 * and ext.config.yaml wires the actions the way the post and the sample do. The page itself is not tested here
 * (it needs `aio app dev` and a Commerce admin).
 */
const fs = require('fs')
const path = require('path')
const { main } = require('../src/commerce-backend-ui-1/actions/registration')

const ext = fs.readFileSync(path.join(__dirname, '../src/commerce-backend-ui-1/ext.config.yaml'), 'utf8')
const app = fs.readFileSync(path.join(__dirname, '../app.config.yaml'), 'utf8')

test('registration has the sample shape: an item under a section, and a page title', async () => {
  const res = await main()
  expect(res.statusCode).toBe(200)
  const { menuItems, page } = res.body.registration
  expect(Object.keys(res.body.registration).sort()).toEqual(['menuItems', 'page'])
  const item = menuItems.find(m => !m.isSection)
  const section = menuItems.find(m => m.isSection)
  expect(item).toEqual({ id: 'StuckOrders::stuck', title: 'Stuck orders', parent: 'StuckOrders::apps', sortOrder: 1 })
  expect(section).toEqual({ id: 'StuckOrders::apps', title: 'Apps', isSection: true, sortOrder: 100 })
  expect(menuItems).toHaveLength(2)
  expect(page).toEqual({ title: 'Stuck orders' })
})

test('the web page uses the same extension id as the registration', () => {
  const constants = fs.readFileSync(path.join(__dirname, '../src/commerce-backend-ui-1/web-src/src/components/Constants.js'), 'utf8')
  expect(constants).toContain("'StuckOrders'")
})

test('app.config.yaml includes the v1 extension point', () => {
  expect(app).toMatch(/^extensions:\n {2}commerce\/backend-ui\/1:\n {4}\$include: src\/commerce-backend-ui-1\/ext\.config\.yaml$/m)
})

test('the registration and data actions are web actions behind require-adobe-auth; data actions get IMS credentials', () => {
  const block = name => ext.split(new RegExp(`^ {8}${name}:\\n`, 'm'))[1].split(/^ {8}\S|^ {4}\S/m)[0]
  for (const name of ['registration', 'list-alerts', 'mark-handled']) {
    expect(block(name)).toContain("web: 'yes'")
    expect(block(name)).toContain('require-adobe-auth: true')
    expect(block(name)).toContain('final: true')
  }
  for (const name of ['list-alerts', 'mark-handled']) expect(block(name)).toContain('include-ims-credentials: true')
})

test('stuck-orders gets IMS credentials so it can write stuck_alerts', () => {
  const block = app.split(/^ {10}stuck-orders:\n/m)[1].split(/^ {8}triggers:/m)[0]
  expect(block).toContain('include-ims-credentials: true')
})
