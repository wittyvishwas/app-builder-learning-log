import React from 'react'
import { Provider, lightTheme } from '@adobe/react-spectrum'
import { ErrorBoundary } from 'react-error-boundary'
import { Route, Routes, HashRouter } from 'react-router-dom'
import ExtensionRegistration from './ExtensionRegistration'

// Structure as in Adobe's sample: error boundary, hash router, Spectrum provider, one index route.
function App (props) {
  return (
    <ErrorBoundary FallbackComponent={Fallback}>
      <HashRouter>
        <Provider theme={lightTheme} colorScheme='light'>
          <Routes>
            <Route index element={<ExtensionRegistration runtime={props.runtime} ims={props.ims} />} />
          </Routes>
        </Provider>
      </HashRouter>
    </ErrorBoundary>
  )
}

function Fallback ({ error }) {
  return (
    <>
      <h1 style={{ textAlign: 'center', marginTop: '20px' }}>Something went wrong :(</h1>
      <pre>{error.message}</pre>
    </>
  )
}

export default App
