import {
  ActionButton, Cell, Column, Content, Heading, IllustratedMessage, ProgressCircle,
  Row, TableBody, TableHeader, TableView, Text,
} from "@react-spectrum/s2";
import { useCallback, useEffect, useState } from "react";
import { callAction, type Ims } from "#web/utils.ts";

type Delivery = { order: string; status?: string; attempts?: number; lastError?: string; at?: string };

const columns = [
  { name: "Order", id: "order", isRowHeader: true },
  { name: "Status", id: "status" },
  { name: "Attempts", id: "attempts" },
  { name: "Last error", id: "lastError" },
  { name: "Time", id: "at" },
  { name: "Action", id: "action" },
] as const;

/**
 * One table of recent deliveries (list-deliveries, failures first, in the action's order); "Retry" on dead
 * rows only (retry-delivery); a retry row is already due at the next run.
 */
export function Deliveries({ ims }: { ims: Ims }) {
  const [rows, setRows] = useState<Delivery[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await callAction<Delivery[]>(ims, "StuckOrders/list-deliveries"));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
      setRows([]);
    }
  }, [ims.imsToken, ims.imsOrgId]);

  useEffect(() => {
    load();
  }, [load]);

  const retry = async (order: string) => {
    try {
      await callAction(ims, "StuckOrders/retry-delivery", { order });
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
      <Heading level={1}>Deliveries</Heading>
      {error && <Text>Something went wrong: {error}</Text>}
      <TableView aria-label="Recent order deliveries" overflowMode="wrap" UNSAFE_style={{ minHeight: 320 }}>
        <TableHeader columns={columns}>
          {(column) => <Column id={column.id} isRowHeader={"isRowHeader" in column}>{column.name}</Column>}
        </TableHeader>
        <TableBody
          items={rows.map((delivery) => ({ ...delivery, id: `${delivery.order}:${delivery.status}` }))}
          renderEmptyState={() => (
            <IllustratedMessage>
              <Content>No deliveries yet</Content>
            </IllustratedMessage>
          )}
        >
          {(delivery) => (
            <Row columns={columns} id={delivery.id}>
              {(column) =>
                column.id === "action" ? (
                  <Cell>
                    {delivery.status === "dead" && (
                      <ActionButton onPress={() => retry(delivery.order)}>Retry</ActionButton>
                    )}
                  </Cell>
                ) : (
                  <Cell>{delivery[column.id] ?? ""}</Cell>
                )
              }
            </Row>
          )}
        </TableBody>
      </TableView>
    </section>
  );
}
