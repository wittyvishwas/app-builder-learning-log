# MageMinion_OrderExport

A small stand-in for "the old module" in Ep 10: it POSTs every placed order to an ERP over HTTP. Magento 2.4.7, PHP 8.1 to 8.4.

## What it does

- Observer on `sales_order_place_after`. It POSTs `{orderNumber: "module-<increment_id>", increment_id, items: [{sku, qty}], shipping_address}` to `<url>/orders` with `Authorization: Bearer <api key>`.
- Children of configurable products are skipped, as `actions/order-sync/mapper.js` does.
- `Magento\Framework\HTTP\Client\Curl`, 2 s timeout. Every send logs the order, the HTTP status and the milliseconds it blocked to `var/log/mageminion_order_export.log`.
- Never fails order placement: every `\Throwable` is caught. A failed send goes into table `mageminion_order_export_retry`.
- Cron job `mageminion_order_export_retry` runs every 10 minutes and resends pending rows: 6 sends in total (the first is the observer's), then the row's status is `dead`.

## Install

On Adobe Commerce on cloud infrastructure:

```bash
cp -r commerce/OrderExport <magento root>/app/code/MageMinion/OrderExport
bin/magento module:enable MageMinion_OrderExport     # writes app/etc/config.php
```

Commit the module and `app/etc/config.php`, then push. The deploy runs `setup:upgrade`, which creates the retry table. On a local or on-premises install, run `bin/magento setup:upgrade` and `bin/magento cache:flush` yourself.

## Configure

Stores > Settings > Configuration > Sales > Order Export (MageMinion) > ERP export (default scope):

| Setting | Path | Default |
|---|---|---|
| Enabled | `mageminion_order_export/general/enabled` | 0 |
| ERP base URL | `mageminion_order_export/general/url` | empty |
| API key (stored encrypted) | `mageminion_order_export/general/api_key` | empty |
| Only export orders with this email text | `mageminion_order_export/general/test_email_filter` | empty |

- Every `bin/magento config:set` needs `bin/magento cache:clean config` afterwards.
- Set the API key in the admin (the field encrypts it), or with `bin/magento config:sensitive:set mageminion_order_export/general/api_key <key>`. A plain `config:set` stores it unencrypted, so `decrypt()` returns garbage and the ERP answers 401.
- **Shared staging:** set the email filter (for example `mmtest+`) and place test orders with matching emails: orders from other customers are then not exported. Empty means all orders.
- Set Enabled to 1 only inside the agreed test window, and back to 0 straight after.

## Turn it off

Set Enabled to 0 (`bin/magento config:set mageminion_order_export/general/enabled 0`, then `bin/magento cache:clean config`). The observer and the retry cron both do nothing. Pending rows stay in the table.

## Remove

`bin/magento module:disable MageMinion_OrderExport`, delete the folder, then drop the table `mageminion_order_export_retry`.

## Notes

- `sales_order_place_after` fires in `Order::place()`, before `orderRepository->save()` and not inside a database transaction. A failed save can therefore leave an export at the ERP, or a retry row, for an order that does not exist. The cron job marks a row `dead` (`order was never saved`) when `sales_order` has no row with that increment ID, but an order the ERP already received stays there.
- The retry table keeps the JSON body, which holds the shipping address. Use made-up addresses in test runs.
- Retries and duplicates: the module's retries are the rows of `mageminion_order_export_retry` (attempts, status, last_error) and the `status=` lines in `var/log/mageminion_order_export.log`. A duplicate shows as status 409 there (counted as accepted). The app's side is in the `export_runs` rows and the fake-erp activation logs.
