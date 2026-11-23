import {
  ActionButton, Cell, Column, Content, Heading, IllustratedMessage, ProgressCircle,
  Row, TableBody, TableHeader, TableView, Text,
} from "@react-spectrum/s2";
import { useCallback, useEffect, useState } from "react";
import { callAction, newestFirst, type Ims } from "#web/utils.ts";

type Alert = { order: string; status?: string; created_at?: string; at?: string };

const columns = [
  { name: "Order", id: "order", isRowHeader: true },
  { name: "Status", id: "status" },
  { name: "Order placed", id: "created_at" },
  { name: "Alerted at", id: "at" },
  { name: "Action", id: "action" },
] as const;

/** One table of open alerts (list-alerts, newest first), one "Mark handled" button per row (mark-handled). */
export function StuckAlerts({ ims }: { ims: Ims }) {
  const [rows, setRows] = useState<Alert[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(newestFirst(await callAction<Alert[]>(ims, "StuckOrders/list-alerts")));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
      setRows([]);
    }
  }, [ims]);

  useEffect(() => {
    load();
  }, [load]);

  const markHandled = async (order: string) => {
    try {
      await callAction(ims, "StuckOrders/mark-handled", { order });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (rows === null) {
    return <ProgressCircle aria-label="Loading…" isIndeterminate size="L" />;
  }

  return (
    <section style={{ margin: 10 }}>
      <Heading level={1}>Stuck orders</Heading>
      {error && <Text>Something went wrong: {error}</Text>}
      <TableView aria-label="Open stuck-order alerts" overflowMode="wrap" UNSAFE_style={{ minHeight: 320 }}>
        <TableHeader columns={columns}>
          {(column) => <Column id={column.id} isRowHeader={"isRowHeader" in column}>{column.name}</Column>}
        </TableHeader>
        <TableBody
          items={rows.map((alert) => ({ ...alert, id: alert.order }))}
          renderEmptyState={() => (
            <IllustratedMessage>
              <Content>No open alerts</Content>
            </IllustratedMessage>
          )}
        >
          {(alert) => (
            <Row columns={columns} id={alert.order}>
              {(column) =>
                column.id === "action" ? (
                  <Cell>
                    <ActionButton onPress={() => markHandled(alert.order)}>Mark handled</ActionButton>
                  </Cell>
                ) : (
                  <Cell>{alert[column.id] ?? ""}</Cell>
                )
              }
            </Row>
          )}
        </TableBody>
      </TableView>
    </section>
  );
}
