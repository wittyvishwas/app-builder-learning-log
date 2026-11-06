# App Builder learning log

Code for **Learn App Builder with me** on [MageMinion](https://mageminion.com/series/app-builder/): a Magento developer learning Adobe Developer App Builder from zero, in public.

Each episode and each developer-log session gets a git tag, so you can check out exactly where the series was.

| Tag | Episode | What's in it |
|---|---|---|
| `ep1-project-anatomy` | [Ep 1: the anatomy of a project](https://mageminion.com/app-builder-ep1-project-anatomy/) | The layout `aio app init` gives you, `app.config.yaml`, `.env.dist`, one small action |

## Run it

```bash
npm install
cp .env.dist .env        # fill in; never commit .env or .aio
aio app use <your-workspace>.json
aio where                # check before every deploy
aio app deploy
```
