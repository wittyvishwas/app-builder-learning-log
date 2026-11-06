import { register } from '@adobe/uix-guest'
import { useEffect } from 'react'
import { MainPage } from './MainPage'
import { extensionId } from './Constants'

// As in Adobe's sample: register with the admin (the menu item comes from the registration action).
export default function ExtensionRegistration (props) {
  useEffect(() => {
    register({ id: extensionId, methods: {} })
  }, [])

  return <MainPage ims={props.ims} runtime={props.runtime} />
}
