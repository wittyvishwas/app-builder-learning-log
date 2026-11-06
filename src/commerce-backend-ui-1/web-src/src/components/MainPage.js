import { Flex, ProgressCircle, TabList, TabPanels, Tabs, Item, View } from '@adobe/react-spectrum'
import { attach } from '@adobe/uix-guest'
import { useEffect, useState } from 'react'
import { extensionId } from './Constants'
import { Deliveries } from './Deliveries'
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
        : (
          <Tabs aria-label='Order sync'>
            <TabList>
              <Item key='alerts'>Stuck orders</Item>
              <Item key='deliveries'>Deliveries</Item>
            </TabList>
            <TabPanels>
              <Item key='alerts'><StuckAlerts ims={props.ims} /></Item>
              <Item key='deliveries'><Deliveries ims={props.ims} /></Item>
            </TabPanels>
          </Tabs>
          )}
    </View>
  )
}
