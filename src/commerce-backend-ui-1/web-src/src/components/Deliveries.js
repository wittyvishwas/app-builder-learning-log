import {
  ActionButton, Cell, Column, Content, Flex, Heading, IllustratedMessage,
  ProgressCircle, Row, TableBody, TableHeader, TableView, Text, View
} from '@adobe/react-spectrum'
import { useCallback, useEffect, useState } from 'react'
import { callAction } from '../utils'

// One table of recent deliveries (list-deliveries, failures first); "Retry" on retry and dead rows (retry-delivery).
export const Deliveries = props => {
  const [rows, setRows] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try {
      setRows(await callAction(props, 'StuckOrders/list-deliveries'))
      setError(null)
    } catch (e) {
      setError(e.message)
      setRows([])
    }
  }, [])

  useEffect(() => { load() }, [load])

  const retry = async order => {
    try {
      await callAction(props, 'StuckOrders/retry-delivery', { order })
      await load()
    } catch (e) {
      setError(e.message)
    }
  }

  if (rows === null) {
    return (
      <Flex alignItems='center' justifyContent='center' height='100vh'>
        <ProgressCircle size='L' aria-label='Loading…' isIndeterminate />
      </Flex>
    )
  }

  const columns = [
    { name: 'Order', uid: 'order' },
    { name: 'Status', uid: 'status' },
    { name: 'Attempts', uid: 'attempts' },
    { name: 'Last error', uid: 'lastError' },
    { name: 'Time', uid: 'at' },
    { name: '', uid: 'action' }
  ]

  return (
    <View margin={10}>
      <Heading level={1}>Deliveries</Heading>
      {error && <Text>Something went wrong: {error}</Text>}
      <TableView
        flex
        overflowMode='wrap'
        aria-label='Recent order deliveries'
        renderEmptyState={() => <IllustratedMessage><Content>No deliveries yet</Content></IllustratedMessage>}
        minHeight='static-size-1000'
      >
        <TableHeader columns={columns}>
          {column => <Column key={column.uid}>{column.name}</Column>}
        </TableHeader>
        <TableBody items={rows}>
          {delivery => (
            <Row key={delivery.order}>
              {key => key === 'action'
                ? <Cell>{delivery.status !== 'sent' && <ActionButton onPress={() => retry(delivery.order)}>Retry</ActionButton>}</Cell>
                : <Cell>{delivery[key]}</Cell>}
            </Row>
          )}
        </TableBody>
      </TableView>
    </View>
  )
}
