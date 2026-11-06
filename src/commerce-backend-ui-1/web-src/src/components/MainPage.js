import { Flex, ProgressCircle, View } from '@adobe/react-spectrum'
import { attach } from '@adobe/uix-guest'
import { useEffect, useState } from 'react'
import { extensionId } from './Constants'
import { StuckAlerts } from './StuckAlerts'

// As in Adobe's sample: inside the admin the IMS token and org come from the guest connection's shared context.
export const MainPage = props => {
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    (async () => {
      if (!props.ims.token) {
        const guestConnection = await attach({ id: extensionId })
        props.ims.token = guestConnection?.sharedContext?.get('imsToken')
        props.ims.org = guestConnection?.sharedContext?.get('imsOrgId')
      }
      setIsLoading(false)
    })()
  }, [])

  return (
    <View>
      {isLoading
        ? (
          <Flex alignItems='center' justifyContent='center' height='100vh'>
            <ProgressCircle size='L' aria-label='Loading…' isIndeterminate />
          </Flex>
          )
        : <StuckAlerts ims={props.ims} />}
    </View>
  )
}
