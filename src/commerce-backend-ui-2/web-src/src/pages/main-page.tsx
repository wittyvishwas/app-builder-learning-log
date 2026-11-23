import { useIms } from "@adobe/aio-commerce-lib-admin-ui/web";
import { Content, Heading, InlineAlert, Tab, TabList, TabPanel, Tabs } from "@react-spectrum/s2";
import { Deliveries } from "#web/components/Deliveries.tsx";
import { StuckAlerts } from "#web/components/StuckAlerts.tsx";

/**
 * The menu page: two tabs, open stuck-order alerts and export deliveries. useIms() gives the admin's IMS
 * token and org (from the Commerce admin or the Experience Cloud shell); outside both it returns an error,
 * and the page says so instead of rendering nothing.
 */
export function MainPage() {
  const { data, error } = useIms();
  if (error) {
    return (
      <main style={{ margin: 10 }}>
        <InlineAlert variant="negative">
          <Heading>No admin session</Heading>
          <Content>Open this inside the Commerce admin. ({error.message})</Content>
        </InlineAlert>
      </main>
    );
  }

  return (
    <main>
      <Tabs aria-label="Order sync">
        <TabList>
          <Tab id="alerts">Stuck orders</Tab>
          <Tab id="deliveries">Deliveries</Tab>
        </TabList>
        <TabPanel id="alerts">
          <StuckAlerts ims={data} />
        </TabPanel>
        <TabPanel id="deliveries">
          <Deliveries ims={data} />
        </TabPanel>
      </Tabs>
    </main>
  );
}
