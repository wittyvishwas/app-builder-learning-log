/*
 * Checks the Ep 8 API Mesh config and its reviews response schema by reading the files. No mesh is deployed here.
 */
const fs = require('fs')
const path = require('path')

const dir = path.join(__dirname, '..', 'mesh')
const meshPath = path.join(dir, 'mesh.json')
const schemaPath = path.join(dir, 'reviews-response-schema.json')
const load = file => JSON.parse(fs.readFileSync(file, 'utf8'))

const reviewsSource = () => load(meshPath).meshConfig.sources.find(s => s.name === 'Reviews')

test('mesh.json and the reviews response schema both parse as JSON', () => {
  expect(() => load(meshPath)).not.toThrow()
  expect(() => load(schemaPath)).not.toThrow()
})

test('the Reviews source handler is spelled JsonSchema, not jsonSchema', () => {
  const handler = reviewsSource().handler
  expect(Object.keys(handler)).toEqual(['JsonSchema'])
  expect(handler).not.toHaveProperty('jsonSchema')
})

test('the reviews resolver joins on sku with keysArg skus', () => {
  const resolver = load(meshPath).meshConfig.additionalResolvers.find(
    r => r.targetTypeName === 'SimpleProduct' && r.targetFieldName === 'reviews'
  )
  expect(resolver).toMatchObject({ keyField: 'sku', keysArg: 'skus' })
})

test('the mesh cache is on', () => {
  expect(load(meshPath).meshConfig.responseConfig.cache).toBe(true)
})

test('the operation response schema exists next to mesh.json', () => {
  const operation = reviewsSource().handler.JsonSchema.operations[0]
  expect(fs.existsSync(path.resolve(dir, operation.responseSchema))).toBe(true)
})
