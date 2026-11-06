# magpie-kunbot

A provider plugin for kunbot, written for [magpie](https://usemagpie.ai/docs/zh/plugins).

It signs in with an API key, and it reads the site's own published catalogs
rather than carrying a hard-coded model list, so the picker shows what the site
is actually serving. Proprietary models (Claude, GPT) are added for a key that
has Proprietary Access, and their Pt balance is reported as quota.

There are two hosts, and they are not configurable:

| | |
| --- | --- |
| `ant.kunbot.org` | the status site: the model catalogs, and the balance session |
| `anthropic.kunbot.org` | the model gateway, as named by the site's catalogs |

## What it does

- **Reads the site's model catalog.** `/configs/pi/models.json` is the same
  file the site hands to pi users. Every open-weight provider is taken from it
  with its own base URL, API, context window, max output, cost and whether it
  reasons. Nothing is hard-coded, so a new route or a changed limit shows up on
  its own.
- **Adds proprietary models for keys that have access.** `/api/proprietary`
  names them; the gateway serves them from its root, not from a route. They are
  listed only when the key is known to have Proprietary Access, and marked
  `rate: 1` so magpie does not spend a metered model first.
- **Reports the allowance.** `magpie quota` shows the key's Pt balance.

Nothing is hidden based on whether the site currently reports a route or model
as up. The plugin does not read the site's health feeds and does not filter the
catalog by them: what an agent may ask for is the site's decision to make, not
one this plugin should guess at.

## Endpoints

One provider, many endpoints. The site names a different address for each
route, and magpie resolves them per model, so they all live in one provider:

| Models | Address | Protocol |
| --- | --- | --- |
| open-weight routes | `anthropic.kunbot.org/<route>/v1` | OpenAI Chat Completions |
| proprietary models | `anthropic.kunbot.org` | Anthropic Messages |

Every one of those addresses is read from the site's catalogs and used as is;
none of them is written here.

## Install

From GitHub:

```sh
magpie plugin add github:wsyzxjn/magpie-kunbot
```

Or as a folder, straight from a clone:

```sh
magpie plugin add ./kunbot-magpie-plugin
```

Then sign in:

```sh
magpie plugin login kunbot
```

It asks for the API key and nothing else — the two hostnames above are fixed.

In the app: open 插件, add the plugin, then sign in on the `kunbot` row.

## Model names

A model is named `<route>/<model id>`, and the route is the same segment that
appears in the route's URL:

```
kunbot/maid/deepseek-ai/DeepSeek-V4.1-Flash
kunbot/empurple/moonshotai/Kimi-K3
kunbot/7sref/gemini-3-pro-image
```

The route is part of the key because one gateway serves many routes and two of
them can serve the same model id: `maid` and `maiden` both serve
`deepseek-ai/DeepSeek-V4.1-Flash` today, on different upstreams.

Proprietary models are named by their own id, with no route:

```
kunbot/claude-opus-5
kunbot/gpt-5.6
```

## What it stores, and what it sends where

The key is kept by magpie in `plugin-auth.json` (mode 600) under the `kunbot`
provider.

**Model requests** go to the gateway with the key, as a bearer token. Nothing
else leaves the machine for them, and they go only to the addresses the
catalogs name.

**Reading the balance is different, and worth being explicit about.** The
gateway refuses every unauthenticated read with a bare `403`, so the plugin
cannot ask it for a balance on its own. The only way to learn a key's Pt
balance is the flow the site's own web page uses: `POST /api/proprietary/key`
with the key, which leaves a session behind that `/api/proprietary/access` then
reads. So when you run `magpie quota`, your key is sent to `ant.kunbot.org`,
the status site — the same request the site's "paste your key, see your
balance" box makes, but it is still your key reaching a second host, and a
different one from the gateway your model requests are signed for.

Consequences worth knowing:

- The key reaches the status site as well as the gateway.
- The status site keeps the key in an `HttpOnly` session cookie, and the page
  can show it back to you. Its privacy page says it stores your lxns user id
  and display name alongside a key you sign in with there.
- A failure here never blocks a model request. If the balance cannot be read,
  `magpie quota` says so instead of showing a zero balance.
- The verdict is cached for 30 minutes, so `magpie quota` does not re-post your
  key on every read. A new key still reaches the gateway on its own within a
  few minutes; a key the gateway has not seen is reported as unregistered.

If you would rather not send your key to the status site, do not run
`magpie quota`. Everything else — signing in, listing models, and every model
request — is unaffected, and the open-weight routes do not need it at all.

## Layout

| File | What it holds |
| --- | --- |
| `index.mjs` | The plugin: the provider, sign-in, the request signer, the catalog reader and the usage hook. |
| `package.json` | The package manifest, with magpie's `maxConcurrency` under `magpie`. |

The entry module exports one plugin function and an `_internal` object holding
the pure functions the tests reach for, so magpie does not mistake a helper for
a plugin.

### A note on writing models here

Models returned from the `provider.models` hook are in magpie's own shape, not
the `config` hook's. A model there is spread from one magpie already normalised,
and its address is set with `api: { id, url, npm }`. Writing `id` or
`provider: { npm, api }` on this path is silently dropped — no error, the model
just falls back to the provider's default address, which would send every
request to the status site.

## Try it in a sandbox

Keep a plugin you are still writing away from the magpie you use every day by
giving it a home of its own:

```sh
sb=$(mktemp -d)
m() { env HOME=$sb XDG_CONFIG_HOME=$sb/.config XDG_CACHE_HOME=$sb/.cache \
      MAGPIE_ADDR=127.0.0.1:3499 magpie "$@"; }

m plugin add ./kunbot-magpie-plugin
m plugin login kunbot
m provider test kunbot
m quota
```

`m provider test` sends one very small request per API, so it is the quickest
way to tell a bad key from a good one.

## License

MIT
