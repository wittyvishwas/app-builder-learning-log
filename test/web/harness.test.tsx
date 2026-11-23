import { render, screen } from '@testing-library/react'
import { Button } from '@react-spectrum/s2'
import { useIms } from '@adobe/aio-commerce-lib-admin-ui/web'

const mockedUseIms = useIms as jest.Mock

function OrgLine () {
  const { data, error } = useIms()
  if (error) return <p>Open this inside the Commerce admin.</p>
  return <p>Org {data.imsOrgId}</p>
}

describe('web test harness', () => {
  afterEach(() => mockedUseIms.mockClear())

  test('renders an S2 Button in jsdom', () => {
    render(<Button variant='accent'>Mark handled</Button>)
    expect(screen.getByRole('button', { name: 'Mark handled' })).toBeTruthy()
  })

  test('useIms is the mapped mock and can be overridden per test', () => {
    const { unmount } = render(<OrgLine />)
    expect(screen.getByText('Org TESTORG@AdobeOrg')).toBeTruthy()
    unmount()

    mockedUseIms.mockReturnValueOnce({ data: null, error: new Error('no host') })
    render(<OrgLine />)
    expect(screen.getByText('Open this inside the Commerce admin.')).toBeTruthy()
  })
})
