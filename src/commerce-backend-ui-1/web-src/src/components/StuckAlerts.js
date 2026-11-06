import {
  ActionButton, Cell, Column, Content, Flex, Heading, IllustratedMessage,
  ProgressCircle, Row, TableBody, TableHeader, TableView, Text, View
} from '@adobe/react-spectrum'
import { useCallback, useEffect, useState } from 'react'
import { callAction } from '../utils'

// One table of open alerts (list-alerts), one "Mark handled" button per row (mark-handled).
export const StuckAlerts = props => {
  const [rows, setRows] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try {
      setRows(await callAction(props, 'StuckOrders/list-alerts'))
      setError(null)
    } catch (e) {
      setError(e.message)
      setRows([])
    }
  }, [])

  useEffect(() => { load() }, [load])

  const markHandled = async order => {
    try {
      await callAction(props, 'StuckOrders/mark-handled', { order })
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
    { name: 'Order placed', uid: 'created_at' },
    { name: 'Alerted at', uid: 'at' },
    { name: '', uid: 'action' }
  ]

  return (
    <View margin={10}>
      <Heading level={1}>Stuck orders</Heading>
      {error && <Text>Something went wrong: {error}</Text>}
      <TableView
        flex
        overflowMode='wrap'
        aria-label='Open stuck-order alerts'
        renderEmptyState={() => <IllustratedMessage><Content>No open alerts</Content></IllustratedMessage>}
        minHeight='static-size-1000'
      >
        <TableHeader columns={columns}>
          {column => <Column key={column.uid}>{column.name}</Column>}
        </TableHeader>
        <TableBody items={rows}>
          {alert => (
            <Row key={alert.order}>
              {key => key === 'action'
                ? <Cell><ActionButton onPress={() => markHandled(alert.order)}>Mark handled</ActionButton></Cell>
                : <Cell>{alert[key]}</Cell>}
            </Row>
          )}
        </TableBody>
      </TableView>
    </View>
  )
}
