# App Builder learning log

Code for **Learn App Builder with me** on [MageMinion](https://mageminion.com/series/app-builder/): a Magento developer learning Adobe Developer App Builder from zero, in public, with Claude Code.

The series has two parts. Four foundation episodes, then a developer log written from real sessions. Every episode and every developer-log session gets a git tag, so you can check out exactly where the series was:

```bash
git checkout ep3-cron-state-files
```

| Tag | Episode | What's in it |
|---|---|---|
| `ep1-project-anatomy` | [Ep 1: the anatomy of a project](https://mageminion.com/app-builder-ep1-project-anatomy/) | The project layout, `app.config.yaml` (web action, inputs from `.env`, `require-adobe-auth`, `final`, limits), `.env.dist`, the `export-order` action |
| — | [Ep 2: start from a boilerplate](https://mageminion.com/app-builder-ep2-first-action/) | Ep 2 starts a real integration from Adobe's [commerce-integration-starter-kit](https://github.com/adobe/commerce-integration-starter-kit). Clone that kit; it isn't copied here |
| `ep3-cron-state-files` | [Ep 3: cron, config and custom tables](https://mageminion.com/app-builder-ep3-cron-state-files/) | `stuck-orders`: an alarm trigger and rule every 15 minutes, a Commerce REST query for orders stuck in `pending_payment`, one alert per order (State with a 7-day TTL), a State lock against overlapping runs |
| `day-NN` | Developer log | One tag per session, with its write-up in [`log/`](log/) |

## What's verified

Each piece is marked by how far it has been proven:

- **Unit-tested:** `npm test` runs the actions with Commerce, the alert webhook and State mocked. That proves the query, the de-duplication and the lock logic, not a deployment.
- **Verified on Stage:** nothing yet. The developer log marks code as verified once it has run in a real workspace.

## Run it

```bash
npm install
npm test
cp .env.dist .env        # fill in; never commit .env or .aio
aio app use <your-workspace>.json
aio where                # check before every deploy
aio app deploy
aio rt action invoke ops/stuck-orders --result   # run the Ep 3 job once by hand
```

Ep 3 needs a Commerce integration token with read access to Sales > Operations > Orders (on PaaS, also allow OAuth access tokens as standalone bearer tokens) and an incoming-webhook URL for the alert.

## Layout

```text
actions/
  utils.js                 # input check and error response helpers
  export-order/index.js    # Ep 1
  stuck-orders/index.js    # Ep 3
app.config.yaml            # actions, trigger, rule
test/                      # Jest unit tests (mocked)
log/                       # developer-log write-ups, one per tag
```

Licence: Apache-2.0.
