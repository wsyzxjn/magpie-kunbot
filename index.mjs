// kunbot's model gateway, as a provider plugin for magpie.
//
// The site serves three kinds of endpoint, and each kind knows its own address:
//
//   open-weight   one endpoint per route, each with its own baseUrl, the API it
//                 speaks, and the full model spec (context window, max output,
//                 cost, whether it reasons). All of it comes from
//                 /configs/pi/models.json, the same file the site hands to pi
//                 users, so it is the source of truth. A request goes to
//                 <base_url>/<route>/v1.
//   proprietary   Claude, GPT and the rest, all on one gateway whose address the
//                 proprietary feed states as its own `base_url`. A request goes
//                 to that address, not to the status site. These need
//                 "Proprietary Access" on the key and are billed in Pt.
//   image         routes the status site labels "Image Generation", whose note
//                 names the model they serve. They are not in the pi catalog,
//                 and a request goes to <base_url>/<route>/v1 asking for an
//                 image output modality.
//
// No feed is filtered by whether it says a model is up. A route or model
// the site reports as down is still listed: the probe is the site's business,
// not a decision this plugin should make about what an agent may ask for.
//
// The status site is one address and is not configurable. Every endpoint below
// is read from that site's own catalogs; none of the model or gateway
// addresses are written here.

const PROVIDER = "kunbot"
const CLIENT = "magpie-kunbot/0.1.2"

// The status site: the one address the plugin knows, asked for nothing at
// sign-in. It serves the catalogs and holds the balance session; the model
// gateway is a different host, and its address comes from the catalogs.
const SITE = "https://ant.kunbot.org"

// The reasoning efforts magpie's agents already know how to send. A route's
// thinkingLevelMap names the ones it takes: a level mapped to null is one the
// route does not accept, so it is not offered.
const EFFORTS = ["low", "medium", "high", "xhigh", "max"]

const effortsFor = (map) => (map && typeof map === "object" ? EFFORTS.filter((e) => map[e] != null) : EFFORTS)

const num = (v) => {
  const n = Number.parseFloat(String(v ?? "").replace(/[^\d.-]/g, ""))
  return Number.isFinite(n) ? n : null
}

// The five reads this plugin makes of the status site. All of them are the
// site's own endpoints; none of them takes a key except the balance session.
const ENDPOINTS = {
  // The public reads.
  catalog: `${SITE}/configs/pi/models.json`,
  proprietary: `${SITE}/api/proprietary`,
  // The route list. Its image routes are not in the pi catalog.
  openweight: `${SITE}/api/openweight`,
  // The balance flow. POST key is the site's own "paste a key, see your
  // balance" endpoint: it checks the key against the gateway and, if it is a
  // working key, leaves a session behind that /access then reads. It is the
  // documented behaviour of the site's own UI, and the only way to learn a
  // key's balance - the gateway refuses every unauthenticated read with a bare
  // 403. It does mean the key is POSTed to the status site; see the README.
  keySession: `${SITE}/api/proprietary/key`,
  access: `${SITE}/api/proprietary/access`,
}

const getJSON = async (url, init) => {
  const res = await fetch(url, { ...init, headers: { accept: "application/json", ...(init?.headers ?? {}) } })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText || ""}`.trim())
  return res.json()
}

// The catalog is a pi/models.json: a map of provider id -> { baseUrl, api,
// models[] }. magpie needs the same information in its own shape, so the
// models are translated one by one rather than re-declared by hand.
//
// The catalog keys its providers `fishlb-<route>-<model>`, but the segment an
// agent actually addresses is the route (`maid`, `empurple`, `uni`, `7sref`)
// — the same segment that appears in the route's /v1 URL. The route slug is
// read back out of baseUrl so the key an agent types
// (`kunbot/maid/deepseek-ai/DeepSeek-V4.1-Flash`) is the address the request
// is sent to, and so two routes serving the same model id do not collide.
function modelsFromCatalog(catalog) {
  const providers = catalog?.providers ?? catalog
  if (!providers || typeof providers !== "object") return null

  const out = {}
  for (const [pid, p] of Object.entries(providers)) {
    // The catalog is pi's: `api` names the wire format. Every route the site
    // serves is OpenAI Chat Completions today; anything else is left to a
    // future revision of this plugin rather than guessed at.
    if (p?.api && !/openai-completions|openai-chat/i.test(p.api)) continue
    // /v1 at the end of the base is preceded by the route: .../<route>/v1.
    const route = /\/([^/]+)\/v1\/?$/.exec(String(p?.baseUrl ?? ""))?.[1] ?? pid.replace(/^fishlb-/, "")
    for (const m of p?.models ?? []) {
      const id = m?.id
      if (!id) continue

      // The route is part of the address rather than part of the model id, so
      // it is folded into the model key. The key is what an agent asks for;
      // `id` is what goes on the wire.
      const key = `${route}/${id}`
      const ctx = num(m?.contextWindow)
      const max = num(m?.maxTokens)
      const input = Array.isArray(m?.input) ? m.input : ["text"]
      const cost = m?.cost ?? {}

      out[key] = {
        name: m?.name || id,
        id,
        // Per-model address: the route's own /v1, taken from the catalog. The
        // provider-level `api` below is only a fallback.
        provider: { npm: "@ai-sdk/openai-compatible", api: p?.baseUrl },
        limit: { context: ctx ?? 200000, ...(max ? { output: max } : {}) },
        reasoning: m?.reasoning === true,
        tool_call: true,
        modalities: { input },
        ...(num(cost?.input) != null || num(cost?.output) != null
          ? {
              cost: {
                ...(num(cost?.input) != null ? { input: num(cost?.input) } : {}),
                ...(num(cost?.output) != null ? { output: num(cost?.output) } : {}),
                ...(num(cost?.cacheRead) != null ? { cache_read: num(cost?.cacheRead) } : {}),
                ...(num(cost?.cacheWrite) != null ? { cache_write: num(cost?.cacheWrite) } : {}),
              },
            }
          : {}),
        ...(m?.reasoning === true
          ? { variants: Object.fromEntries(effortsFor(m?.thinkingLevelMap).map((e) => [e, {}])) }
          : {}),
      }
    }
  }
  return Object.keys(out).length ? out : null
}

// The proprietary feed. The models here are named on the gateway root, so they
// are the site's own ids with no route segment.
//
// The feed states the gateway's own address as `base_url`. That address is put
// on every model, because the proprietary models are not served by the status
// site: a request has to go to the gateway, and only the feed knows where
// that is on this deployment.
function proprietaryModels(feed) {
  const models = feed?.models
  if (!models || typeof models !== "object") return null
  const host = feed?.base_url
  if (!host) return null
  const out = {}
  for (const id of Object.keys(models)) {
    out[id] = {
      name: id,
      id,
      provider: { npm: "@ai-sdk/anthropic", api: host },
      limit: { context: 200000, output: 32000 },
      reasoning: true,
      tool_call: true,
      // The gateway meters output tokens in Pt and refuses a key that has no
      // Proprietary Access, so these are not free: magpie should not spend
      // them first.
      rate: 1,
      variants: Object.fromEntries(EFFORTS.map((e) => [e, {}])),
    }
  }
  return Object.keys(out).length ? out : null
}

// The status site labels an image-generation route "Image Generation" and
// names the model it serves in the route's note. Those routes stay out of the
// pi catalog, so they are read here. The model is named `<route>/<model>` like
// the chat routes, and magpie 0.1.3423+ sends image-only models to the
// route's /v1/images/generations.
const IMAGE_ROUTE_LABEL = "image generation"

function imageIdsFromNote(note) {
  const found = /supported\s+models?\s*[:：]\s*([^\n]+)/i.exec(String(note ?? ""))
  if (!found) return []
  return found[1]
    .split(/[,;，；、]/)
    .map((part) => part.trim().split(/\s+/)[0]?.replace(/[（(].*$/, "").replace(/[.。]+$/, ""))
    .filter(Boolean)
}

function imagesFromOpenweight(feed) {
  const base = String(feed?.base_url ?? "").replace(/\/+$/, "")
  if (!base) return null

  const out = {}
  for (const route of Array.isArray(feed?.routes) ? feed.routes : []) {
    if (String(route?.label ?? "").trim().toLowerCase() !== IMAGE_ROUTE_LABEL) continue
    const slug = String(route?.slug ?? "").trim()
    if (!slug) continue

    const listed = (Array.isArray(route?.models) ? route.models : [])
      .map((m) => (typeof m === "string" ? m : m?.id))
      .filter(Boolean)
    const ids = listed.length ? listed : imageIdsFromNote(route?.note)
    const usable = ids.filter((id) => !id.includes("?"))

    for (const id of usable) {
      out[`${slug}/${id}`] = {
        name: id,
        id,
        provider: { npm: "@ai-sdk/openai-compatible", api: `${base}/${slug}/v1` },
        modalities: { input: ["text"], output: ["image"] },
        reasoning: false,
        tool_call: false,
      }
    }
  }
  return Object.keys(out).length ? out : null
}

const MODALITIES = ["text", "image", "audio", "video"]
const modalitiesOf = (list) => Object.fromEntries(MODALITIES.map((k) => [k, (list ?? ["text"]).includes(k)]))

function imageModelForHook(template, m) {
  const base = { ...(template ?? {}) }
  delete base.id
  delete base.provider
  return {
    ...base,
    name: m.name,
    limit: { context: 0, output: 0 },
    reasoning: false,
    tool_call: false,
    modalities: m.modalities,
    capabilities: {
      ...(base.capabilities ?? {}),
      reasoning: false,
      attachment: false,
      toolcall: false,
      input: modalitiesOf(m.modalities?.input),
      output: modalitiesOf(m.modalities?.output),
    },
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    variants: {},
    api: { id: m.id, url: m.provider.api, npm: m.provider.npm },
  }
}

// The site's own UI signs a working key in and reads the balance back through
// a session. This does the same, caching the verdict for a while so
// `magpie quota` does not re-post the key on every read.
// Keyed by the key: there is one status site.
const sessions = new Map()
const SESSION_TTL = 30 * 60 * 1000

async function readAccess(key) {
  const id = key
  const hit = sessions.get(id)
  if (hit && hit.until > Date.now()) return hit.value
  if (hit) sessions.delete(id)

  const post = await fetch(ENDPOINTS.keySession, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ key }),
  })
  if (!post.ok) {
    const body = await post.json().catch(() => ({}))
    // The site answers 400 with a reason rather than a `state` for a key the
    // gateway does not recognise. That is still a verdict about the key, so
    // it is normalised to the same shape as a session read: `access` always
    // carries the state the caller switches on.
    const value = { ok: false, access: { state: "anonymous" }, error: body?.error || `the site answered ${post.status}` }
    sessions.set(id, { until: Date.now() + SESSION_TTL, value })
    return value
  }
  const submitted = await post.json().catch(() => ({}))
  // A 200 carries the key's access state, as the site's own page reads it. A
  // state other than ok (no_pma, revoked) is the verdict: it is put in the
  // same `access` shape a session read gives, so the caller sees the state,
  // and cached so the key is not re-posted on every quota read.
  if (submitted?.state && submitted.state !== "ok") {
    const value = { ok: false, access: submitted }
    sessions.set(id, { until: Date.now() + SESSION_TTL, value })
    return value
  }

  const setCookies = post.headers.getSetCookie?.() ?? []
  const jar = new Map()
  for (const raw of setCookies) {
    const [pair] = raw.split(";")
    const eq = pair.indexOf("=")
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
  }
  const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ") || undefined
  if (!cookie) return { ok: false, error: "the site set no session for this key" }

  const res = await fetch(ENDPOINTS.access, { headers: { accept: "application/json", cookie } })
  if (!res.ok) return { ok: false, error: `the site answered ${res.status}` }
  const body = await res.json().catch(() => null)
  const value = { ok: true, access: body }
  sessions.set(id, { until: Date.now() + SESSION_TTL, value })
  return value
}

export const KunbotAntPlugin = async ({ client }) => {
  const log = (level, message) => {
    try {
      client?.app?.log?.({ level, service: PROVIDER, message })
    } catch {}
  }

  // The public feeds are read once and kept for a while
  // rather than on every hook call.
  let cache = { until: 0, models: null, proprietary: null, images: null }
  const CATALOG_TTL = 5 * 60 * 1000

  const refresh = async () => {
    if (cache && cache.until > Date.now() && cache.models) return cache
    const [catalog, proprietary, openweight] = await Promise.allSettled([
      getJSON(ENDPOINTS.catalog),
      getJSON(ENDPOINTS.proprietary),
      getJSON(ENDPOINTS.openweight),
    ])
    const models = catalog.status === "fulfilled" ? modelsFromCatalog(catalog.value) : null
    if (!models) throw new Error("the site's model catalog could not be read")
    const images = openweight.status === "fulfilled" ? imagesFromOpenweight(openweight.value) : null
    cache = {
      until: Date.now() + CATALOG_TTL,
      models,
      proprietary: proprietary.status === "fulfilled" ? proprietaryModels(proprietary.value) : null,
      images,
    }
    return cache
  }

  return {
    // The provider. `config` runs before anyone signs in, so the models are
    // read here too: the picker has them before anyone has a key. The `provider`
    // hook reads them again per account, to add the proprietary models that
    // key's access allows.
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: "kunbot",
        npm: "@ai-sdk/openai-compatible",
        // Only a fallback. Every model below carries the endpoint it is
        // actually served from, so no request is sent here; the status site
        // is not a model endpoint.
        api: SITE,
        models: {},
      }
      try {
        const { models, images } = await refresh()
        for (const [k, m] of Object.entries(models)) {
          cfg.provider[PROVIDER].models[k] ??= m
        }
        for (const [k, m] of Object.entries(images ?? {})) {
          cfg.provider[PROVIDER].models[k] ??= m
        }
      } catch (e) {
        log("warn", `catalog unavailable: ${e?.message ?? e}`)
      }
    },

    auth: {
      provider: PROVIDER,
      maxConcurrency: 8,
      methods: [
        {
          type: "api",
          label: "kunbot API key",
          placeholder: "sk-...",
          async authorize() {
            // The key is kept as typed. The balance read happens at usage
            // time (see `usage`), not here, so signing in never sends the key
            // anywhere on its own.
            return { type: "success", metadata: {} }
          },
        },
      ],

      // Every request this account makes. The open-weight routes are
      // OpenAI-compatible and authenticate with a bearer token; the gateway
      // root takes the same key.
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return {}
        return {
          async fetch(input, init) {
            const headers = new Headers(init?.headers)
            headers.set("authorization", `Bearer ${auth.key}`)
            headers.set("x-api-key", auth.key)
            headers.set("x-kunbot-client", CLIENT)
            return fetch(input, { ...init, headers })
          },
        }
      },

      // The proprietary allowance. Pt is a balance rather than a window, so it
      // is reported through `balance` and no windows are claimed. A key the
      // site does not know is reported as such instead of being shown as a
      // zero balance.
      async usage(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return { error: "Not signed in", windows: [] }

        let cat
        try {
          cat = await refresh()
        } catch (e) {
          return { error: `Couldn't read the site: ${e?.message ?? e}`, windows: [] }
        }

        // A key without Proprietary Access cannot use the paid models at all.
        // That is the single most useful thing to say about such a key, so it
        // is checked first and said plainly. The balance flow needs the key to
        // be known to the site, so a key the site has never seen is reported
        // as such rather than as a failure.
        const access = await readAccess(auth.key)
        const state = access?.access?.state

        if (state === "anonymous" || state === "no_pma" || state === "revoked") {
          const why = {
            anonymous: "this key isn't registered with the site",
            no_pma: "this key has no Proprietary Access",
            revoked: "this key's Proprietary Access was revoked",
          }[state]
          return {
            user: access?.access?.key_masked,
            error: `No proprietary models: ${why}${access?.error ? ` (${access.error})` : ""}. The open-weight routes are unaffected.`,
            windows: [],
          }
        }

        const bal = access?.access?.balance
        const out = { user: access?.access?.key_masked, windows: [] }
        if (bal?.ok) {
          out.balance = `${num(bal.data)} Pt`
        } else if (bal?.status === 401) {
          out.balance = "not in ACL"
        }

        if (!out.balance && !out.windows.length) {
          out.error = access?.error || "The site did not report a balance or any proprietary model state."
        }
        return out
      },
    },

    // The models this account has. The catalog is public, so the same list is
    // returned for every key; what the key changes is whether the proprietary
    // models are added at all.
    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        let cat
        try {
          cat = await refresh()
        } catch (e) {
          log("warn", `model list failed: ${e?.message ?? e}`)
          return provider.models
        }

        // The hook returns models in magpie's own shape, not the config
        // hook's: a model here is spread from the one magpie already
        // normalised, and its address is set through `api` (id, url, npm)
        // rather than through `id` and `provider`, which this path ignores.
        // Writing `id` or `provider` here is silently dropped, which would
        // send every request to the wrong endpoint.
        const template = Object.values(provider.models ?? {})[0]
        const out = {}
        for (const [key, m] of Object.entries(cat.models)) {
          out[key] = {
            ...(template ?? {}),
            name: m.name,
            limit: m.limit,
            reasoning: m.reasoning,
            tool_call: m.tool_call,
            modalities: m.modalities,
            cost: m.cost,
            variants: m.variants,
            api: { id: m.id, url: m.provider.api, npm: m.provider.npm },
          }
        }

        // Image-generation routes are not in the pi catalog. Their models get
        // the route's address and an image output modality, which is what
        // magpie's /v1/images/generations asks a plugin model for.
        for (const [key, m] of Object.entries(cat.images ?? {})) {
          out[key] = imageModelForHook(template, m)
        }

        // Proprietary models join the list only for a key that has Proprietary
        // Access; without it the gateway answers 403 and listing them would
        // only produce failures. The balance flow is best-effort, so a key the
        // site has never seen is treated as open-weight-only rather than as a
        // broken sign-in.
        if (auth?.type === "api" && auth.key && cat.proprietary) {
          const access = await readAccess(auth.key)
          if (access?.access?.state === "ok") {
            for (const [key, m] of Object.entries(cat.proprietary)) {
              out[key] = {
                ...(template ?? {}),
                name: m.name,
                limit: m.limit,
                reasoning: m.reasoning,
                tool_call: m.tool_call,
                rate: m.rate,
                variants: m.variants,
                api: { id: m.id, url: m.provider.api, npm: m.provider.npm },
              }
            }
          }
        }

        return Object.keys(out).length ? out : provider.models
      },
    },
  }
}

// Tests need these; the community convention is to hang them off one object
// so magpie does not mistake a helper for a plugin.
export const _internal = { modelsFromCatalog, proprietaryModels, imagesFromOpenweight, imageIdsFromNote, readAccess }
