'use strict'
// Mock of @adobe/aio-commerce-lib-admin-ui/web (its real build is browser-only ESM).
// Tests set what useIms() returns, e.g.
//   useIms.mockReturnValue({ data: null, error: new Error('no host') })
const useIms = jest.fn(() => ({
  data: { imsToken: 'test-token', imsOrgId: 'TESTORG@AdobeOrg' },
  error: null
}))
const createExtensionApp = jest.fn()

module.exports = { useIms, createExtensionApp }
