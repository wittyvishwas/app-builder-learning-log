# Ep 10 real-workspace run: side by side

Plan sections 2b and 2c. The old module is `commerce/OrderExport/` (install steps in its README); the app side is `order-sync/export-order`.

## Compare

Both senders write to the fake ERP: the app as `<increment_id>`, the module as `module-<increment_id>`.

```bash
node scripts/compare-erp.js --url https://<namespace>.adobeioruntime.net/api/v1/web/dev/fake-erp --key "$FAKE_ERP_API_KEY" <increment_id>...
```

Run it within 7 days; the fake ERP's records expire.

## Shared staging: the email filter

Set `mageminion_order_export/general/test_email_filter` (for example `mmtest+`) and place test orders with matching emails, so other customers' orders are not exported by the module. Enable the module only inside the agreed test window, and set Enabled back to 0 straight after.

## Failure test, one failed order per sender

The fake ERP cannot answer 503, so point each sender at a host that does not resolve.

- **App:** set `ERP_API_URL` to an unresolvable host (for example `https://erp.invalid`), redeploy, place an order, then restore the URL and redeploy. The next 10-minute tick resends it.
- **Module:**

  ```bash
  bin/magento config:set mageminion_order_export/general/url https://erp.invalid && bin/magento cache:clean config
  # place an order, then restore:
  bin/magento config:set mageminion_order_export/general/url <fake-erp url> && bin/magento cache:clean config
  ```

## Where retries and duplicates are read from

The compare script shows neither. Read them from:

- the fake-erp activation logs (`aio rt activation list`; a duplicate is a 409 line);
- the app's `export_runs` rows;
- the module's retry table `mageminion_order_export_retry` and `var/log/mageminion_order_export.log`.
