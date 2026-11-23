'use strict'

/*
 * Two jest projects:
 * - "node": the action/script tests under test/, with jest's defaults (node
 *   environment, default babel-jest), exactly as before this file existed.
 * - "web": tests for the V2 admin page (src/commerce-backend-ui-2/web-src,
 *   TypeScript + React 19 + @react-spectrum/s2) under test/web/, in jsdom.
 *   The TS/JSX transform uses inline Babel presets with configFile/babelrc
 *   off, so no root babel.config.js leaks into the parcel or action builds.
 *   S2 loads under jest through its precompiled CJS build (style macros are
 *   already expanded there); its CSS imports are mapped to an empty module.
 *   @adobe/aio-commerce-lib-admin-ui/web ships only browser/import ESM
 *   exports, so it is mapped to a mock with a controllable useIms().
 */
module.exports = {
  projects: [
    {
      displayName: 'node',
      testEnvironment: 'node',
      testPathIgnorePatterns: ['/node_modules/', '<rootDir>/test/web/']
    },
    {
      displayName: 'web',
      testEnvironment: 'jsdom',
      testMatch: ['<rootDir>/test/web/**/*.test.[jt]s?(x)'],
      // Observer stubs and a fixed element size, so S2's virtualized TableView renders rows in jsdom.
      setupFiles: ['<rootDir>/test/web/setup.js'],
      transform: {
        '\\.[jt]sx?$': ['babel-jest', {
          configFile: false,
          babelrc: false,
          presets: [
            ['@babel/preset-env', { targets: { node: 'current' } }],
            ['@babel/preset-typescript', { allowDeclareFields: true }],
            ['@babel/preset-react', { runtime: 'automatic' }]
          ]
        }]
      },
      moduleNameMapper: {
        '\\.css$': '<rootDir>/test/web/__mocks__/style.js',
        '^@adobe/aio-commerce-lib-admin-ui/web$': '<rootDir>/test/web/__mocks__/admin-ui-web.js',
        '^#web/(.*)$': '<rootDir>/src/commerce-backend-ui-2/web-src/src/$1'
      }
    }
  ]
}
