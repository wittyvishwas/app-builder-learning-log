# Agent hand-off: App Builder Ep 9, a page in the Commerce admin (Admin UI SDK)

Give this file to your coding agent (Claude Code or similar) inside your own App Builder project. It builds what Ep 9 built, in your project. Post: <https://mageminion.com/app-builder-ep9-admin-ui-sdk/>. Code: tag `ep9-admin-ui-sdk` in https://github.com/wittyvishwas/app-builder-learning-log. Two Ep 9 fixes landed after that tag; the Files table pins those files to `ep11-local-testing`.

## Before you start
- This builds on Ep 1 (project layout), Ep 3 (the stuck-order job), and Ep 4 (Database Storage: the project has a database, a post-deploy index hook and IMS credentials for `aio-lib-db`).
- The project needs a web UI. If it was started actions-only, run `aio app add web-assets`.
- The human must have: Adobe Developer Console access, `aio login` done, and a non-Production workspace selected (check with `aio where`).
- The human must have an Adobe Commerce with the Admin UI SDK module installed (Adobe's installation guide for the edition) and admin access to configure it.
- The Commerce admin must use Adobe IMS sign-in, in the same IMS org as the App Builder project. Without it the extension list stays empty. Adobe requires it: <https://developer.adobe.com/commerce/extensibility/admin-ui-sdk/installation/>. It applies to every admin user, so the human should try it on a local copy first: <https://experienceleague.adobe.com/en/docs/commerce-admin/start/admin/ims/adobe-ims-config>.
- Agent: stop and ask the human for anything in this list you can't confirm.

## Rules for the agent
- Never use a Production workspace. Never deploy without the human's yes.
- Before any `aio app deploy`, `aio app use` or onboarding script, run `aio where` and show the human the workspace. Continue only on their yes.
- Never write secret values to files under git. `.env` and `.aio` stay out of git.
- Build only what this file lists. Keep the reader's existing names and code style; rename the episode's names (listed below) to fit.
- This is Admin UI SDK version 1 (`commerce/backend-ui/1`). Adobe has deprecated it in favour of version 2 (`commerce/backend-ui/2`). The two are not compatible: pick one per app. Build version 1 here, as the post does. Do not mix in version 2 code.
- Never rely on the page being hidden. Every action the page calls stays locked down (see Config).

## Get the reference code
```bash
[ -d /tmp/abl ] || git clone https://github.com/wittyvishwas/app-builder-learning-log /tmp/abl
git -C /tmp/abl fetch --tags
# then, for each Files row: git -C /tmp/abl show REF:PATH
```

## Files
Ep 9 is the stuck-orders page only. The `list-deliveries` and `retry-delivery` actions and the Deliveries tab belong to Ep 10: leave them out.

| Path | Ref | What it is | Do |
|---|---|---|---|
| `app.config.yaml` | `ep9-admin-ui-sdk` | Root config: the `extensions` entry that includes the extension config, and `include-ims-credentials: true` on the `ops/stuck-orders` action | merge into yours (only those two parts) |
| `actions/stuck-orders/index.js` | `ep9-admin-ui-sdk` | The Ep 3 job, extended: each alert it sends is also upserted into the `stuck_alerts` collection | merge into yours |
| `package.json` | `ep9-admin-ui-sdk` | Dependencies. Ep 9 added these devDependencies for the web page: `@adobe/exc-app`, `@adobe/react-spectrum`, `@adobe/uix-guest`, `core-js`, `react`, `react-dom`, `react-error-boundary`, `react-router-dom`, `regenerator-runtime`. Without them `aio app build` fails | read only: add those devDependencies to yours, keep your own versions of the rest |
| `scripts/post-deploy-db-setup.js` | `ep9-admin-ui-sdk` | The Ep 4 post-deploy hook. Ep 9 adds the `stuck_alerts` indexes: `order_1` (unique) and `handled_1_at_-1` | merge into yours (only the `stuck_alerts` entry in `INDEXES`) |
| `src/commerce-backend-ui-1/ext.config.yaml` | `ep11-local-testing` | Extension config: the web UI, the `registration` action, and the `list-alerts` and `mark-handled` actions. Later ref: it carries the `ALLOWED_CLIENT_IDS` input (the client_id allowlist, added after Ep 10, part of Ep 9). Leave out the `list-deliveries` and `retry-delivery` action blocks in that file: they are Ep 10 | add (without the two Ep 10 blocks) |
| `src/commerce-backend-ui-1/actions/registration/index.js` | `ep9-admin-ui-sdk` | Registers the "Stuck orders" menu item with the Admin UI SDK | add |
| `src/commerce-backend-ui-1/actions/list-alerts/index.js` | `ep11-local-testing` | Returns the open alerts from `stuck_alerts`, newest first. Later ref: it calls the allowlist check first. No Ep 10 code in it | add |
| `src/commerce-backend-ui-1/actions/mark-handled/index.js` | `ep11-local-testing` | Sets `handled: true` on one alert. Later ref: it calls the allowlist check first. No Ep 10 code in it | add |
| `src/commerce-backend-ui-1/actions/allowed-client.js` | `ep11-local-testing` | Second gate: checks the token's `client_id` against `ALLOWED_CLIENT_IDS`. Only exists at the later ref | add |
| `src/commerce-backend-ui-1/web-src/index.html` | `ep9-admin-ui-sdk` | Page shell | add |
| `src/commerce-backend-ui-1/web-src/src/index.js` | `ep9-admin-ui-sdk` | React entry | add |
| `src/commerce-backend-ui-1/web-src/src/exc-runtime.js` | `ep9-admin-ui-sdk` | Runtime bootstrap, copied from Adobe's sample | add |
| `src/commerce-backend-ui-1/web-src/src/index.css` | `ep9-admin-ui-sdk` | Page styles | add |
| `src/commerce-backend-ui-1/web-src/src/components/App.js` | `ep9-admin-ui-sdk` | Error boundary, hash router and React Spectrum provider | add |
| `src/commerce-backend-ui-1/web-src/src/components/Constants.js` | `ep9-admin-ui-sdk` | The extension id, `StuckOrders`, which must match the registration's ids | add |
| `src/commerce-backend-ui-1/web-src/src/components/ExtensionRegistration.js` | `ep9-admin-ui-sdk` | Registers the menu with the SDK | add |
| `src/commerce-backend-ui-1/web-src/src/components/MainPage.js` | `ep9-admin-ui-sdk` | Page frame: reads the IMS token and org from the admin, shows the alerts. Keep this tag: later versions add the Ep 10 Deliveries tab | add |
| `src/commerce-backend-ui-1/web-src/src/components/StuckAlerts.js` | `ep9-admin-ui-sdk` | The React Spectrum table of alerts with a Mark handled button | add |
| `src/commerce-backend-ui-1/web-src/src/utils.js` | `ep11-local-testing` | `callAction`: posts to an action with the IMS token. Later ref: it reads the answer as text first, so a non-JSON error page (a 502 from the gateway) shows the HTTP status, not "Unexpected token '<'" | add |

Later-fix decisions: the hook and `package.json` stay at the Ep 9 tag (later versions carry other episodes' changes). `registration/index.js`, `StuckAlerts.js`, `stuck-orders/index.js` and the other web-src files have no later change. `MainPage.js` and `app.config.yaml` have later changes that belong to other episodes, so they stay at the Ep 9 tag.

## Config
- `app.config.yaml` entry (the extension point; version 1):
```yaml
extensions:
  commerce/backend-ui/1:
    $include: src/commerce-backend-ui-1/ext.config.yaml
```
- Also in `app.config.yaml`: the `ops/stuck-orders` action needs `include-ims-credentials: true`, because it now writes to the database.
- `src/commerce-backend-ui-1/ext.config.yaml`: every action the page calls is a web action (`web: 'yes'`) with `require-adobe-auth: true` and `final: true`. The two data actions (`list-alerts`, `mark-handled`) also get `include-ims-credentials: true` and an `ALLOWED_CLIENT_IDS: $ALLOWED_CLIENT_IDS` input. Copy the structure from the file at the pinned ref.
- Lock-down, as the post describes: `require-adobe-auth: true` rejects calls without a valid token. Version 1 has no per-action permissions, so each data action also checks the token's `client_id` against the allowlist and refuses anything else. The token can belong to an integration, not a person: do not treat it as the admin user's identity.
- `.env` keys (names only; the human provides the values):
  - `ALLOWED_CLIENT_IDS`: comma-separated IMS client ids allowed to call the data actions. Empty refuses every call. The first refused call logs the caller's client id at warn level (`aio rt activation logs`), so the human can read it there.
  - `COMMERCE_BASE_URL`, `COMMERCE_TOKEN`, `ALERT_WEBHOOK_URL`: for the Ep 3 job, as before.
  - `IMS_OAUTH_S2S_CLIENT_ID`, `IMS_OAUTH_S2S_CLIENT_SECRET`, `IMS_OAUTH_S2S_ORG_ID`, `IMS_OAUTH_S2S_SCOPES`: for the Ep 4 post-deploy hook, as before.
- `scripts/post-deploy-db-setup.js`: add the `stuck_alerts` indexes to the hook's `INDEXES` (`order_1` unique, `handled_1_at_-1`). The Ep 4 hand-off leaves them out because they are Ep 9's. The hook creates them on the next deploy.
- `src/commerce-backend-ui-1/web-src/src/config.json` is generated by `aio app build` or `aio app dev`. Keep it out of git.
- Human steps in the Commerce admin. The agent stops and asks the human to do these:
  1. Open Stores > Settings > Configuration > Adobe Services > Admin UI SDK and set Enable Admin UI SDK to Yes (off by default). Adobe's configuration guide: <https://developer.adobe.com/commerce/extensibility/admin-ui-sdk/configuration/>.
  2. Under Configure eligible extensions, pick the workspace, then select the app. A `--no-publish` deploy is listed as Draft for a Stage workspace. Save.
  3. Optional: turn on Database logging and read System > Admin UI SDK > Admin UI SDK Logs.
  4. After each deploy, click Refresh selected extensions and reload the admin.
- PaaS only, optional: Enable local testing and Local Server Base URL in the same section load the registration from the human's machine. Adobe's configuration guide has the small HTTPS server. Turn `require-adobe-auth` off on the registration action only while testing locally, and back on before any shared deploy. Keep local testing off on Commerce as a Cloud Service.

## Tests
- Add from `test/`: `registration.test.js` and `stuck-orders.test.js` at `ep9-admin-ui-sdk`; `list-alerts.test.js`, `mark-handled.test.js`, `allowed-client.test.js` and `web-utils.test.js` at `ep11-local-testing` (allowlist and non-JSON fixes).
- Add the `stuck_alerts` cases from `test/db-setup.test.js` at `ep9-admin-ui-sdk` into your copy: the expected index names `order_1` and `handled_1_at_-1` with `order_1` unique, and the test that the unique index rejects a second alert for the same order. Leave the other collections' cases out.
- Add `test/helpers.js` from `ep11-local-testing`. It has the fake database (`fakeDb`) and, for the allowlist tests, `tokenFor` and `authed`.
- `test/registration.test.js` reads `ext.config.yaml` and `app.config.yaml` by their repo paths and expects the menu ids `StuckOrders::stuck` and `StuckOrders::apps`. If your paths or names differ, change the test, not the check.
- Run `npm test`.

## Check it works
1. Local first (no deploy). `npm test`. Then, optional, Adobe's own sample before your code, to rule out configuration problems: <https://github.com/adobe/adobe-commerce-samples/tree/main/admin-ui-sdk>, folder `admin-ui-sdk/v1/menu/custom-menu`. With the extension running under `aio app dev -e commerce/backend-ui/1`, an Apps menu with the first app should appear when selected under Configure eligible extensions. If it doesn't, read the SDK logs first. (Ep 11 ran the menu read from `aio app dev` through local testing; it did not open the page.)
2. Then deployed to the non-Production workspace, after the human says yes (after `aio where` is shown): `aio app deploy`. The human clicks Refresh selected extensions and reloads the admin. Expect Stuck orders in the Apps menu, listing open alerts newest first. In the post's admin, clicking Apps in the sidebar opened the Commerce Resource Center widget first; the extension's page was in the Apps menu.
3. Lock-down checks on the deployed `list-alerts` action: no token, a made-up token, or a valid token without the org header must answer 401. A valid token whose `client_id` is not in `ALLOWED_CLIENT_IDS` must answer 403. The page's own calls (admin token, client on the allowlist) answer 200.
4. Press Mark handled on a test alert. The alert gets `handled: true`. Ship read-only first: add the button only after you have tested who can press it.
- Proven in the post: unit tests; deploy to a Stage workspace; the page in a local Commerce admin with IMS sign-in; two test alerts newest first; Mark handled wrote `handled: true`. Not proven: Adobe's sample, `aio app dev` local testing for the page, a server-to-server token, version 2. Once the re-list after Mark handled still showed the row until a reload.

## Names to rename
| In the reference | Why it may differ in yours |
|---|---|
| `Stuck orders` (menu and page title) | Your menu label |
| `stuck_alerts` (collection) | Your collection name, if you already have one |
| `StuckOrders` (action package), `admin-ui-sdk` (package) | Your package names |
| `ops/stuck-orders` | Your Ep 3 job's package and action name |
| `commerce/backend-ui/1` and `src/commerce-backend-ui-1` | Only if your extension layout differs |

## Not in this episode
- `list-deliveries`, `retry-delivery`, the Deliveries tab (`Deliveries.js`) and the retry button: Ep 10.
- `actions/export-order`, `actions/export-order-retry`, `actions/order-sync/`, `actions/sync-log`: Ep 4 and Ep 10.
- `actions/order-placed`: Ep 6. `actions/cart-check` and `commerce/webhooks.xml`: Ep 7. `mesh/`: Ep 8.
- `actions/ep11-probe`, `dev/run-ep11/`: Ep 11.
- Admin UI SDK version 2 (`commerce/backend-ui/2`, `app.commerce.config.ts`, ACL with `aclProtected`): not built here.
