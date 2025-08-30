**TL;DR:** Bifrost middleware is a **Go** plugin that implements `schemas.Plugin` with a **PreHook** you can use to read/mutate the `BifrostRequest` or short-circuit with a response/error; order is deterministic (PreHooks forward, PostHooks reverse). Register your plugin in `BifrostConfig.Plugins` (Go SDK) or via `APP_PLUGINS`/`-plugins` (HTTP gateway). ([Maxim AI][1])

### 1) What you’re targeting (interfaces & data shapes)

* **Plugin interface (Go):**

  ```go
  type Plugin interface {
    GetName() string
    PreHook(*context.Context, *BifrostRequest) (*BifrostRequest, *PluginShortCircuit, error)
    PostHook(*context.Context, *BifrostResponse, *BifrostError) (*BifrostResponse, *BifrostError, error)
    Cleanup() error
  }
  ```

  PreHook runs before provider I/O; return `(req', nil, nil)` to continue, or `(_, short, nil)` to short-circuit (cache, auth fail, etc.). PostHook always runs for each executed PreHook (even on short-circuits) and may transform the response or error. ([Maxim AI][1])
* **Short-circuit control:**

  ```go
  type PluginShortCircuit struct {
    Response *BifrostResponse
    Error    *BifrostError
    AllowFallbacks *bool // default true
  }
  ```

  Use `AllowFallbacks=false` for hard denials (e.g., auth). ([Maxim AI][2])
* **Request/response types (OpenAI-compatible):** `BifrostRequest{Provider, Model, Input{…}, Params, Fallbacks}`, `BifrostResponse{Choices, Model, Usage, ExtraFields{Provider,…}}`. For chat, mutate `Input.ChatCompletionInput` (array of `BifrostMessage{Role, Content{ContentStr|Blocks}, …}`). ([Maxim AI][1])

### 2) Execution model & wiring (router placement, order, loading)

* **Placement:** Router → **PreHook pipeline** → provider call (unless short-circuited) → **PostHook pipeline** (reverse order). **PreHooks execute in registration order**; **PostHooks reverse**. This symmetry guarantees cleanup/metrics even when you short-circuit. ([Maxim AI][3])
* **Registering your plugin:**

  * **Go SDK:** `bifrost.Init(BifrostConfig{Plugins: []schemas.Plugin{YourPlugin(...)}})`; order = slice order. ([Maxim AI][4])
  * **HTTP gateway:** supply plugin names in `APP_PLUGINS="maxim,custom-plugin"` (Docker) or `-plugins "maxim,ratelimit,custom"` (binary). ([Maxim AI][3])

### 3) PreRequest hook: a “porting contract”

When you port existing logic into Bifrost, think of PreHook as a pure function on `(ctx, req)` with optional **policy gates** and **enrichment**:

**Request read/write surface (most used):**

* **Model & provider hints:** `req.Provider`, `req.Model`, `req.Fallbacks` (edit to steer routing).
* **Messages:** `req.Input.ChatCompletionInput` slice of messages—prepend/append system text, redact user content, inject tool stubs.
* **Params:** `req.Params` (temperature, max tokens, tool choice).
  These are stable fields you’ll map to from your existing router/middleware. ([Maxim AI][1])

**Short-circuit patterns (decide early, fail fast):**

* **Cache hit:** return `PluginShortCircuit{Response: cached}`.
* **Auth/quotas:** return `PluginShortCircuit{Error: &BifrostError{StatusCode: 401/429,…}, AllowFallbacks: boolPtr(false)}`.
* **Static reply (maintenance):** set `Response` with a templated message. ([Maxim AI][2])

**Context usage:** The hook receives a **pointer** to `context.Context` so you can enrich it (`*ctx = context.WithValue(*ctx, key, val)`) for downstream plugins/providers; avoid storing values globally. ([Maxim AI][2])

### 4) Streaming, concurrency, and performance

* **Streaming:** Plugins operate at request/response boundaries by default. For **stream-aware** work, PostHook can process streaming deltas (e.g., the bundled **JSON-parser** plugin fixes partial JSON chunks during streams, toggleable per-request via context). ([Bifrost][5])
* **Concurrency:** Hooks run across many goroutines. Make your plugin **reentrant and thread-safe** (lock or use atomics for shared maps; avoid blocking network calls on hot paths; set timeouts). Bifrost isolates provider pools, uses backpressure and object pools; your plugin should respect context timeouts/cancellation. ([Maxim AI][6])
* **Latency budget:** Simple plugins add **\~1–10 µs**; heavy I/O dominates—prefer caches, batched lookups, or async/queue handoff in PostHook. ([Maxim AI][3])

### 5) “Claude-ready” porting checklist (the handoff spec)

Give this to Claude (or any coder) as the exact contract to implement:

1. **Module layout (Go):**

````
plugins/<your-plugin>/
  main.go          // implements schemas.Plugin
  plugin_test.go   // unit + integration tests
  go.mod           // module name; require github.com/maximhq/bifrost
  README.md
``` :contentReference[oaicite:13]{index=13}

2) **Public constructor & name:** `New<Plugin>(Config) Plugin` and `GetName() string` returns a unique, stable name. :contentReference[oaicite:14]{index=14}

3) **Config surface (plain-English schema):**  
- Required: feature flags, denylist/allowlist rules, cache TTL, external endpoints (with timeouts).  
- Optional: per-model overrides; context keys to toggle behaviors (e.g., `Enable<Feature>`).  
Keep JSON-serializable; validate eagerly.

4) **PreHook algorithm (pseudocode):**  
````

Input: \*ctx, \*req

1. Read identity from ctx (X-API-Key/JWT) → userID or orgID.
2. Enforce org policy:

   * if model ∉ allowed\[orgID] → shortCircuit(Error 403, AllowFallbacks=false).
   * if tokens\_over\_budget(req, orgID) → shortCircuit(Error 429, AllowFallbacks=false).
3. Transform:

   * If chat: rewrite messages (prepend system guardrails; redact PII).
   * Tune params: clamp temperature/max\_tokens per policy.
   * Optionally set req.Fallbacks for resilience.
4. Cache probe (key := hash(provider, model, messages, params)):

   * if hit → shortCircuit(Response=cached).
5. Context enrichment:

   * \*ctx = withValue(\*ctx, "tenant", orgID); withValue(\*ctx, "<feature-flags>", flags)
6. return (req', nil, nil)

````
(Errors via `PluginShortCircuit.Error`; never panic; always respect `context`.)

5) **PostHook algorithm (for observability/recovery):**  
- On success: record metrics; update cache.  
- On `BifrostError` with 429/5xx: optionally synthesize fallback response or just pass through. :contentReference[oaicite:15]{index=15}

6) **Registration & order:** In the host app:  
```go
bifrost.Init(BifrostConfig{
  Account: &MyAccount{},
  Plugins: []schemas.Plugin{ Authz(), Quotas(), YourPlugin(cfg), Observability() },
})
// Order matters: auth/limits → transforms → caching/observability
````

For the HTTP gateway binary: `APP_PLUGINS="maxim,your-plugin"` or `-plugins "maxim,your-plugin"`. ([Maxim AI][4])

7. **Thread safety & limits:**

* Protect shared maps (`sync.RWMutex`) or use `sync.Map`.
* Bound external I/O (timeouts, circuit-breakers).
* Honor cancellation: check `ctx.Err()` in loops. ([Maxim AI][6])

8. **Tests:**

* **Unit:** PreHook transformation and short-circuit paths (happy + deny + cache-hit).
* **Integration:** Initialize a test Bifrost with your plugin chain; assert order and side-effects. The docs include working unit/integration patterns you can mirror. ([Maxim AI][2])

9. **Streaming (optional):** If your legacy logic massages SSE tokens, model it after the **JSON Parser** plugin: enable via context key; operate only on streaming chunks in PostHook; keep a bounded per-request buffer and a cleanup timer. ([Bifrost][5])

---

### 6) Trade-offs & gotchas

* **Power vs. latency:** Every network hop in PreHook taxes your P99. Prefer local policy + cache in PreHook; shove heavy enrichment to PostHook or to a sidecar queue. ([Maxim AI][3])
* **Ordering hazards:** If you mutate messages then run a cache plugin, ensure the cache key reflects **post-transform** content or you’ll poison the cache. ([Maxim AI][4])
* **Fallback semantics:** Be explicit—deny flows should set `AllowFallbacks=false` so you don’t “fail open.” ([Maxim AI][2])
* **Concurrency races:** Avoid writing to shared plugin state without locks; Bifrost will run many requests in parallel. ([Maxim AI][6])

### 7) Minimal “porting template” (Claude can fill the blanks)

```
type Config struct {
  // feature flags, allowlists, cacheTTL, http endpoints, timeouts...
}
type Plugin struct {
  name string
  cfg  Config
  // caches, clients (thread-safe), metrics handles...
}
func New(cfg Config) *Plugin { ... }            // validate cfg
func (p *Plugin) GetName() string { return p.name }

func (p *Plugin) PreHook(ctx *context.Context, req *schemas.BifrostRequest)
  (*schemas.BifrostRequest, *schemas.PluginShortCircuit, error) {
  // 1) identity & policy  2) transforms  3) cache probe  4) ctx enrich
}

func (p *Plugin) PostHook(ctx *context.Context, res *schemas.BifrostResponse, be *schemas.BifrostError)
  (*schemas.BifrostResponse, *schemas.BifrostError, error) {
  // metrics, cache fill, optional error recovery (429/5xx)
}

func (p *Plugin) Cleanup() error { /* close clients, flush */ }
```

(Claude: implement per the interface; keep structures private; expose only `New`.)

---

**Primary references:** official plugin API & examples, schema shapes, lifecycle/loader, concurrency model, and a streaming-aware example plugin. ([Maxim AI][4], [Bifrost][5])

[1]: https://www.getmaxim.ai/docs/bifrost/usage/go-package/schemas "Schemas - Maxim Docs"
[2]: https://www.getmaxim.ai/docs/bifrost/contributing/plugin "Plugin Development Guide - Maxim Docs"
[3]: https://www.getmaxim.ai/docs/bifrost/architecture/plugins "Plugin System Architecture - Maxim Docs"
[4]: https://www.getmaxim.ai/docs/bifrost/usage/go-package/plugins "Plugins - Maxim Docs"
[5]: https://docs.getbifrost.ai/features/plugins/jsonparser "JSON Parser - Bifrost"
[6]: https://www.getmaxim.ai/docs/bifrost/architecture/concurrency "Concurrency Model - Maxim Docs"

**TL;DR:** In the HTTP gateway, “middleware” = a Go plugin that implements `schemas.Plugin` and is passed into `bifrost.Init(...)`. Your `PreHook(ctx, *BifrostRequest)` runs before provider routing; mutate the request (model, params, headers-derived metadata) or short-circuit; then wire the plugin into a thin HTTP-gateway main and build. ([Go Packages][1], [Bifrost][2])

**Idea → mechanism.** Bifrost’s core exposes a first-class plugin contract:

```go
type Plugin interface {
  GetName() string
  PreHook(ctx *context.Context, req *schemas.BifrostRequest) (*schemas.BifrostRequest, *schemas.PluginShortCircuit, error)
  PostHook(ctx *context.Context, res *schemas.BifrostResponse, err *schemas.BifrostError) (*schemas.BifrostResponse, *schemas.BifrostError, error)
  Cleanup() error
}
```

`PreHook` executes on the hot path before provider selection and fallback; return a modified `req`, or a `PluginShortCircuit{Response|Stream|Error}` to bypass the upstream call (set `Error.AllowFallbacks = false` to block fallbacks). You register your plugin by constructing it and passing it in `schemas.BifrostConfig{Plugins: []schemas.Plugin{...}}` when you create the core instance the HTTP transport uses. The HTTP transport converts OpenAI/Anthropic/GenAI-style requests into a `BifrostRequest`, injects HTTP headers into context, and calls the core; you can read caller metadata (e.g., `x-bf-vk`, `x-bf-user-id`, `x-bf-team-id`, `x-bf-trace-id`) from the request context for routing, labeling, or governance. ([Go Packages][1]) ([Go Packages][3]) ([Bifrost][2])

**What to implement (HTTP-gateway specific).** 1) **Plugin package**: `plugins/yourmw` exporting `New(config any) (schemas.Plugin, error)`. In `PreHook`, do pure, fast mutations—e.g., normalize `req.Model` (`"gpt-4o"`→`"openai/gpt-4o-mini"`), set `req.Provider`, enrich `req.Input` (system prelude, tool policy), or inject trace labels in `req.ExtraFields`. To reject/redirect, return `PluginShortCircuit{Error: &BifrostError{..., AllowFallbacks: ptr(false)}}` or a synthetic `Response`. 2) **Wire into the gateway**: create a tiny `main` that starts the HTTP transport but supplies your initialized core with plugins:

```go
client, _ := bifrost.Init(schemas.BifrostConfig{
  Account: yourAccount,                      // providers, keys, timeouts
  Plugins: []schemas.Plugin{yourPlugin},     // <- prerequest middleware here
})
// hand `client` to the HTTP transport’s server bootstrap (same binary)
```

Run exactly the same HTTP endpoints (`/v1/chat/completions`, `/openai/v1/chat/completions`, etc.). Build and run with the documented flags (`-app-dir`, `-port`; env keys like `OPENAI_API_KEY` are auto-detected); the transport is FastHTTP and exposes provider-native compatibility routes, so your clients don’t change—only the base URL. ([Go Packages][3])

**Trade-offs & constraints.** Today the stable path is **compile-time registration** (your custom binary includes the plugin) rather than hot-loading; you keep zero overhead and type safety, but upgrades mean a quick rebuild. `PreHook` is on the hot path—treat it like a router filter: avoid blocking I/O, prefer O(1) lookups, and use immutable config. For streaming short-circuits you must return a channel in `PluginShortCircuit.Stream`. Any error you surface can allow or suppress fallbacks via `AllowFallbacks` (nil means “allow”). Keep the plugin stateless or guard mutable state for high concurrency. ([Go Packages][1])

**Next steps (handable to Claude Code):**

1. Scaffold `plugins/yourmw` implementing `schemas.Plugin` with a focused `PreHook` (read needed `x-bf-*` headers from context; set provider/model/params; optional short-circuit). 2) Add a `cmd/bifrost-http-with-yourmw` that initializes the core with your plugin and starts the HTTP transport; build and run with `-app-dir`/`-port` and your provider env keys. 3) Smoke-test via `/openai/v1/chat/completions` while sending `x-bf-*` headers; verify routing and labels. 4) Add a `PostHook` only if you need response rewriting or accounting. References: core plugin interface & config; HTTP transport endpoints/flags; header contract for passing metadata. ([Go Packages][1], [Bifrost][2])


[1]: https://pkg.go.dev/github.com/maximhq/bifrost/core%40v1.1.24/schemas "schemas package - github.com/maximhq/bifrost/core/schemas - Go Packages"
[2]: https://docs.getbifrost.ai/integrations/genai-sdk?utm_source=chatgpt.com "Google GenAI SDK - Bifrost"
[3]: https://pkg.go.dev/github.com/maximhq/bifrost/transports/bifrost-http "bifrost-http command - github.com/maximhq/bifrost/transports/bifrost-http - Go Packages"
