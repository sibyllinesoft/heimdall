# Project Spec — Bifrost Router with Avengers-style cost↔quality routing, GBDT triage, direct GPT-5/Gemini/Claude OAuth paths, and pluggable auth adapters

**TL;DR:** Build a Bifrost **PreHook** that (1) extracts cheap features; (2) runs a tiny **gradient-boosted tree (GBDT)** to pick a **bucket** (cheap ⇢ DeepSeek/Qwen via OpenRouter; mid ⇢ Claude via OAuth **or** GPT-5/Gemini with *mid* “thinking”; hard/long ⇢ GPT-5/Gemini with *high* “thinking”); (3) runs the paper’s **Avengers-Pro α-score** *inside that bucket* to choose the specific model. Use **direct API** for GPT-5 and Gemini (env keys), **OAuth passthrough** for Claude (and modular adapters for Gemini & OpenAI user auth), and **OpenRouter** for cheap models only. On **Claude 429**, immediately fall back to the best **non-Anthropic** candidate. Two sidecars/services: **Catalog** (live model/pricing/capabilities) and **Tuning** (train GBDT + α/threshold search). Avengers-Pro mechanism & gains are from the paper; GPT-5 exposes `reasoning_effort`; Gemini exposes `thinkingBudget` and 1M context; DeepSeek R1 and Qwen3-Coder are available on OpenRouter. ([arXiv][1], [OpenAI][2], [Google AI for Developers][3], [Google Cloud][4], [OpenRouter][5])

---

## 0) Assumptions (explicit)

* **Platform:** Bifrost gateway that supports request-mutation PreHooks and PostHooks.
* **Primary objective:** maximize **quality per \$** with **quality slightly > price**, maintain interactive latency.
* **Providers:**

  * **Claude** (Code/Sonnet): **direct Anthropic** via **user OAuth** token in headers, when present.
  * **GPT-5**: **direct OpenAI** via `OPENAI_API_KEY`; use `reasoning_effort`. ([OpenAI][2])
  * **Gemini 2.5 Pro**: **direct Gemini** via **API key** (or **OAuth token** where available); supports **thinking** + **1,048,576** token input. ([Google AI for Developers][3])
  * **Cheap pool:** **DeepSeek R1** and **Qwen3-Coder** via **OpenRouter** (Anthropic excluded). ([OpenRouter][5])
* **Catalog & tuning** run as separate services with HTTP/gRPC APIs.
* **OAuth “trick”:** we modularize per-provider **AuthAdapters**; **Gemini supports OAuth** for the API; **OpenAI’s model API is key-based** (no official end-user OAuth for model calls), so the “OpenAI OAuth” module is a BYOK shim unless OpenAI later ships it. ([Google AI for Developers][6], [Anthropic][7])

---

## 1) Architecture (high level)

**Data-plane (Bifrost plugins):**

* **Router PreHook** (this project): feature extraction → **GBDT triage (3-way)** → **Avengers α-score in-bucket** → choose target `{kind, model, params, auth}` and rewrite request accordingly.
* **Evaluator PostHook:** collects latency, tokens, provider headers (rate limits), judge scores; emits training rows.

**Control-plane services (separate processes):**

1. **Catalog Service**

   * Syncs: **OpenRouter models** (slugs, price, context, features), **OpenAI GPT-5** (price, `reasoning_effort` support, context), **Gemini 2.5** (context, `thinkingBudget` ranges), and feature flags (JSON mode, tools). Exposes **read-only API** used by Router + Tuning. ([OpenRouter][8], [OpenAI][2], [Google AI for Developers][3])
2. **Tuning Service**

   * Trains **GBDT triage** + fits **α, thresholds** from logs, and exports the **Avengers artifact** `{centroids, Q̂[m,c], Ĉ[m], penalties}`. Uses LightGBM/XGBoost. Avengers-Pro clustering & α-score come from the paper. ([arXiv][1])

**Auth Adapters (modular):**

* **AnthropicOAuthAdapter** (Claude Code): uses inbound user token; forwards to Anthropic endpoints. Docs reference IAM/enterprise setup. ([Anthropic][9])
* **GeminiOAuthAdapter**: supports **OAuth bearer** per Google’s guide, else env key. ([Google AI for Developers][6])
* **OpenAIKeyAdapter**: uses env key by default; optionally “user-key” store (not true OAuth). Be explicit that **OpenAI model API has no official OAuth for model calls**. ([OpenAI Community][10], [Anthropic][7])

---

## 2) Routing algorithm (single, cohesive)

We keep Avengers-Pro’s mechanism for **in-bucket** selection and add a **GBDT triager** for bucket choice.

### 2.1 Features (per request, ≤25 ms budget)

* **Embedding** of prompt (self-hosted; cached).
* **Cluster signals:** nearest centroid id, top-p distances.
* **Lexical:** token count, code/math flags (regex), n-gram entropy.
* **Context fit:** estimated tokens vs model context capacity (from Catalog).
* **Historical:** per-user success/latency priors (optional).

### 2.2 Buckets

* **Cheap:** `deepseek/deepseek-r1`, `qwen/qwen3-coder` (OpenRouter). ([OpenRouter][5])
* **Mid:** **Claude** (if Anthropic OAuth present) **or** **GPT-5/Gemini** with **mid thinking**.
* **Hard/Long:** **GPT-5/Gemini** with **high thinking**; if `ctx_in` is huge (≥200k), prefer **Gemini 2.5 Pro** for long-context. ([Google AI for Developers][3])

### 2.3 Thinking budgets (provider-specific mapping)

* **GPT-5:** set `reasoning_effort` ∈ {`low`,`medium`,`high`}. For reference, Google’s OpenAI-compat doc maps OpenAI levels to **\~1K / 8K / 24.6K reasoning tokens** (useful for target budgets and telemetry). ([Google AI for Developers][11])
* **Gemini:** set `thinkingBudget` (integer tokens). Gemini docs: **Pro supports “Thinking”** with budget control; **1,048,576** input token limit; thinking guide describes budget semantics. Use **4–8k** for *mid*, **16–32k** for *hard*; allow `-1` (dynamic) as an experiment. ([Google AI for Developers][3], [Google Cloud][12])

### 2.4 Decision flow (deterministic, fail-safe)

```
features ← extract(req)
bucket_probs ← GBDT(features)            # p_cheap, p_mid, p_hard

if context_exceeds(cheap_models):        # guardrail
    bucket ← hard
else if context_exceeds(mid_models):
    bucket ← hard
else if p_hard > τ_hard:
    bucket ← hard
else if p_cheap > τ_cheap:
    bucket ← cheap
else:
    bucket ← mid

if bucket == cheap:
    candidates ← {DeepSeek-R1, Qwen3-Coder}      # OpenRouter
    pick ← argmax_m α·Q̂[m,c] − (1−α)·Ĉ[m] − penalties
    route_openrouter(pick, anthropic_excluded=true)

if bucket == mid:
    if has_anthropic_oauth(req.headers):
        route_anthropic_oauth(claude_model)
    else:
        candidates ← {GPT-5(mid), Gemini(mid)}
        pick ← α-score
        route_direct(pick)

if bucket == hard:
    candidates ← {GPT-5(high), Gemini(high)}
    if very_long_context: bias_to(Gemini)
    pick ← α-score
    route_direct(pick)
```

**On Anthropic 429 / rate-limit:** **do not retry** Anthropic; immediately recompute **best non-Anthropic** for the same bucket and **reissue** (OpenRouter for cheap; GPT-5/Gemini for mid/hard). Record “escalated-from-anthropic=true”.

---

## 3) Services and APIs

### 3.1 Catalog Service (separate)

**Responsibilities:** fetch & normalize **models, slugs, prices, context, capabilities, thinking/effort params**, and provider quirks.

**Ingestors:**

* **OpenRouter:** `/api/v1/models` + model pages for price/context caps; **exclude Anthropic** in our consumer. ([OpenRouter][8])
* **OpenAI GPT-5:** pricing; `reasoning_effort`, context maxima. ([OpenAI][2])
* **Gemini 2.5:** models page (Pro/Flash), thinking docs, context limits. ([Google AI for Developers][3])

**API (HTTP/JSON):**

* `GET /v1/models?provider=openrouter|openai|google&family=deepseek|qwen|gpt5|gemini`
* `GET /v1/capabilities/:model` → `{ctx_in_max, ctx_out_max, supports_json, tools, thinking: {type: "effort"|"budget", ranges}}`
* `GET /v1/pricing/:model` → `{in_per_million, out_per_million}`
* `GET /v1/feature-flags` (e.g., disable model X)

**Data model (normalized):**

```json
{
  "slug": "deepseek/deepseek-r1",
  "provider": "openrouter",
  "family": "deepseek",
  "ctx_in": 163840,
  "params": { "thinking": false, "json": true },
  "pricing": { "in": 0.40, "out": 2.00, "unit": "USD_per_1M_tokens" }
}
```

(Values for R1 and Qwen3-Coder verified on OpenRouter pages.) ([OpenRouter][5])

**Refresh cadence:** hourly poll; diff + version.

### 3.2 Tuning Service (separate)

**Inputs:**

* PostHook logs: `{prompt_id, cluster_id, model, cost_in,out, latency, label/grade, success}`
* Catalog snapshots (for normalization)
* Avengers artifacts from prior run

**Jobs:**

* **Clustering** (k-means) on embeddings; save centroids.
* **Per-cluster Q̂ & Ĉ** for models (quality & normalized cost).
* **GBDT triage** training (3-class: cheap/mid/hard).
* **Hyperparameter search** over `α`, thresholds `τ_cheap, τ_hard`, penalty weights (latency, context).
* **Export artifact** (versioned) to object store; **notify Router** to hot-reload.

**Artifact format (single JSON/TAR):**

```json
{
  "version": "2025-08-27T12:00Z",
  "centroids": "faiss_index.bin",
  "alpha": 0.60,
  "thresholds": { "cheap": 0.62, "hard": 0.58 },
  "penalties": { "latency_sd": 0.05, "ctx_over_80pct": 0.15 },
  "qhat": { "deepseek/deepseek-r1": [ ... per cluster ... ], "qwen/qwen3-coder": [ ... ] },
  "chat": { "deepseek/deepseek-r1": 0.12, "qwen/qwen3-coder": 0.09, "openai/gpt-5": 0.75, "google/gemini-2.5-pro": 0.55 },
  "gbdt": { "framework": "lightgbm", "model.bin": "…", "feature_schema": { ... } }
}
```

(Avengers-Pro core idea—clusters + α trade-off—comes from the paper.) ([arXiv][1])

---

## 4) Bifrost Plugin (data-plane)

### 4.1 PreHook — `Router.Decide(ctx, req) -> Decision`

**Inputs:** request (prompt, headers), Catalog cache, latest Tuning artifact.

**Steps:**

1. **Auth detect:** `AuthAdapter.match(req.headers)` → `{provider, type, token}`.
2. **Features:** embed; ANN top-p centroids; lexical features; context estimate.
3. **GBDT triage:** `p = gbdt.predict_proba(features)` → choose bucket via thresholds and guardrails.
4. **In-bucket α-score:** score candidate models using `Q̂`/`Ĉ` and penalties (latency prior, context pressure).
5. **Thinking params:**

   * GPT-5: set `reasoning_effort = "medium"` for **mid**; `"high"` for **hard**. ([OpenAI][2])
   * Gemini: set `thinkingBudget = 4000–8000` for **mid**; `16000–32000` for **hard** (respect model limits; Pro supports thinking and 1M context). ([Google AI for Developers][3], [Google Cloud][12])
6. **Rewrite:**

   * **Claude path:** `kind="anthropic"`, pass user OAuth headers unchanged; **no OpenRouter**.
   * **Direct path:** `kind="openai"` or `kind="google"`; attach API key from env; set thinking params.
   * **Cheap path:** `kind="openrouter"`, set `model=deepseek/deepseek-r1` or `qwen/qwen3-coder`; set `provider.sort` and **exclude Anthropic**.

**Decision shape (internal):**

```json
{
  "kind": "anthropic" | "openai" | "google" | "openrouter",
  "model": "anthropic/claude-3.7-sonnet" | "openai/gpt-5" | "google/gemini-2.5-pro" | "deepseek/deepseek-r1" | "qwen/qwen3-coder",
  "params": { "reasoning_effort": "low|medium|high|minimal", "thinkingBudget": 16000, "max_output_tokens": 2048 },
  "provider_prefs": { "sort": "latency", "max_price": 0.006, "allow_fallbacks": true },
  "auth": { "mode": "oauth|env|userkey", "token_ref": "…" },
  "fallbacks": ["deepseek/deepseek-r1", "qwen/qwen3-coder"]
}
```

### 4.2 PostHook — `Router.Log(ctx, req, resp)`

* Persist: `{decision, costs, latency, provider_headers, 429_flags, labels_if_any}` to the warehouse.
* Emit counters: route share by bucket, win-rate vs. baseline, cost/task, P95 latency.

### 4.3 Error & fallback rules (authoritative)

| Condition                          | Action                                                                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Claude** returns **429 / quota** | **Immediate** reroute to best **non-Anthropic** candidate for same bucket; mark cooldown on this user (e.g., 3–5 min). |
| **OpenAI/Gemini** errors (5xx)     | Cross-fallback **within hard/mid** bucket (e.g., GPT-5 ⇄ Gemini).                                                      |
| **OpenRouter** 5xx                 | Try other cheap model; if both down and `p_hard` high, escalate to **Gemini mid**.                                     |
| **Context overflow**               | If cheap/mid can’t fit, force **hard** (Gemini first for huge input).                                                  |

---

## 5) Auth Adapters (modular, pluggable)

Create a mini-framework so you can drop adapters in/out or move them to another repo.

**Interface:**

```ts
interface AuthAdapter {
  id: "anthropic-oauth" | "google-oauth" | "openai-key" | "user-key" | string
  matches(reqHeaders: Headers): boolean
  extract(reqHeaders: Headers): { scheme: "Bearer"|"ApiKey", token: string }
  apply(outgoing: HttpRequest): HttpRequest    // set Authorization & any provider-specific headers
  validate?(token: string): Promise<boolean>   // optional, for health checks
}
```

**Included adapters:**

* **AnthropicOAuthAdapter**: Detects Anthropic OAuth (Claude Code). Forwards bearer; no OpenRouter. IAM docs cover enterprise auth set-up. ([Anthropic][9])
* **GeminiOAuthAdapter**: Implements Google OAuth bearer flow (Authorization: Bearer `<access_token>`), supports PKCE; otherwise falls back to `GEMINI_API_KEY`. ([Google AI for Developers][6])
* **OpenAIKeyAdapter**: Uses `OPENAI_API_KEY` from env. Note: **no official OpenAI end-user OAuth** for raw model API; treat any “OpenAI OAuth” as BYOK storage. ([OpenAI Community][10], [Anthropic][7])

> **Note:** If you later obtain product-specific “agent OAuth” tokens (e.g., from a hosted agent product), add a new adapter without touching the router.

---

## 6) Config (one file, operator-friendly)

```yaml
router:
  alpha: 0.60                   # quality tilt
  thresholds:
    cheap: 0.62
    hard: 0.58
  top_p: 3
  penalties:
    latency_sd: 0.05
    ctx_over_80pct: 0.15
  bucket_defaults:
    mid:
      gpt5_reasoning_effort: medium
      gemini_thinking_budget: 6000
    hard:
      gpt5_reasoning_effort: high
      gemini_thinking_budget: 20000
  cheap_candidates: [ "deepseek/deepseek-r1", "qwen/qwen3-coder" ]
  mid_candidates:   [ "openai/gpt-5", "google/gemini-2.5-pro" ]   # Claude is governed by OAuth presence
  hard_candidates:  [ "openai/gpt-5", "google/gemini-2.5-pro" ]
  openrouter:
    exclude_authors: [ "anthropic" ]
    provider:
      sort: latency
      max_price: 0.006
      allow_fallbacks: true

auth_adapters:
  enabled: [ "anthropic-oauth", "google-oauth", "openai-key" ]

catalog:
  base_url: http://catalog:8080
  refresh_seconds: 3600

tuning:
  artifact_url: s3://llm-router/artifacts/latest.tar
  reload_seconds: 300
```

---

## 7) Implementation plan (keep the implementer on rails)

**Milestone 1 — Scaffolding (2–3 days)**

* Create **Catalog Service** (read-only): implement ingestors for OpenRouter `/models`, OpenAI GPT-5 (static config initial), Gemini models; persist to SQLite/JSON; serve endpoints above. ([OpenRouter][8], [OpenAI][2], [Google AI for Developers][3])
* Define **AuthAdapter** interface; stub three adapters.
* Bifrost **PreHook** skeleton: read config; call Catalog; no ML yet (route by fixed rules for smoke tests).

**Milestone 2 — Avengers core + embeddings (3–5 days)**

* Integrate **embeddings** (self-host or fast local; cache by prompt hash).
* Implement **ANN** (FAISS) for cluster lookup.
* Implement **α-score** and artifact loading (use dummy artifact initially).
* Wire **cheap bucket** via OpenRouter (ensure Anthropic excluded). ([OpenRouter][8])

**Milestone 3 — GBDT triage (3–4 days)**

* Build **Tuning Service** training job: features, labels (cheap vs mid vs hard by empirical win-per-\$), LightGBM model, thresholds export.
* PreHook: integrate **GBDT.predict\_proba**; guardrails for context.
* Add **thinking param mappers**: GPT-5 `reasoning_effort`; Gemini `thinkingBudget`. ([OpenAI][2], [Google AI for Developers][13])

**Milestone 4 — Direct providers & OAuth (3–5 days)**

* **Gemini direct** (API key) and **OAuth** path (PKCE) with token cache; respect 1M context. ([Google AI for Developers][3])
* **OpenAI GPT-5 direct** (env key); set `reasoning_effort`. ([OpenAI][2])
* **Claude OAuth** path: forward user token; **429 handling → non-Anthropic** fallback. (IAM ref) ([Anthropic][9])

**Milestone 5 — Observability & guardrails (2–3 days)**

* PostHook logging; dashboards: route share, cost/task, P95 latency, 429 escalations, win-rate vs baseline.
* SLO checks: block deploy if P95>target or failover misfires.

**Milestone 6 — Optimizer loop (ongoing)**

* Nightly **Catalog** refresh; weekly **Tuning** (retrain GBDT + α/thresholds).
* Canary rollout: 5% traffic, then 25/50/100.

---

## 8) Testing & acceptance criteria

**Unit:**

* AuthAdapters: header detection, token application, env-key fallback.
* Context guards: overflow triggers hard bucket.
* α-score correctness on synthetic `Q̂`/`Ĉ`.

**Integration:**

* **Claude OAuth** → 429 injection → OpenRouter fallback within 300 ms.
* **GPT-5/Gemini**: verify `reasoning_effort` / `thinkingBudget` appear in requests and influence latency/quality. ([OpenAI][2], [Google AI for Developers][13])
* **OpenRouter**: model exclusion list enforced; provider sorting honored. ([OpenRouter][14])

**E2E canaries:**

* Easy code prompts route to DeepSeek/Qwen ≥70% of time; hard math routes to GPT-5/Gemini ≥80%; long-context to Gemini ≥90% when input >200k. (Tune after week 1.)
* **Acceptance gate:** non-inferior pass\@1 vs single best model within −2% at ≥25% lower cost on your eval; P95 ≤ 2.5 s interactive; zero Anthropic calls when no OAuth header.

---

## 9) Security & compliance

* **Secrets:** provider keys via env/secret manager; never log tokens or prompts with PII.
* **OAuth:** store **Gemini** refresh tokens encrypted; **Anthropic** tokens are transient; **OpenAI** uses env keys (until official OAuth exists). ([Google AI for Developers][6], [Anthropic][7])
* **Isolation:** Catalog/Tuning services are read-only from the data-plane; artifacts signed + versioned.

---

## 10) Ops runbook (failure modes)

* **Anthropic 429 spike:** verify adapter; reduce mid-bucket prior for affected users; OpenRouter cheap takes over.
* **Gemini INVALID\_ARGUMENT on thinkingBudget:** clamp to model-specific min/max (Pro min \~128, max \~32k per Vertex doc); log. ([Google Cloud][12])
* **GPT-5 timeouts at high effort:** drop to `medium`; reissue once; else switch to Gemini hard. ([OpenAI][2])
* **Catalog drift (price/context):** artifact invalidation; force refresh.

---

## 11) Developer notes (pragmatics & knobs)

* Start `α=0.60` (quality-tilted).
* Set **mid thinking**: GPT-5=`medium`; Gemini `thinkingBudget≈6k`. **Hard**: GPT-5=`high`; Gemini `≈20k`. Adjust after logs; don’t exceed Pro limits. ([OpenAI][2], [Google Cloud][12])
* Huge input (≥200k tokens): bias to **Gemini 2.5 Pro** (1M input) unless hard guardrails say otherwise. ([Google AI for Developers][3])

---

## 12) File layout (suggested)

```
/router/
  /plugins/bifrost/
    router_prehook.ts
    router_posthook.ts
    adapters/
      anthropic_oauth.ts
      gemini_oauth.ts
      openai_key.ts
    scoring/
      alpha_score.ts
      penalties.ts
    triage/
      gbdt_runtime.ts
      features.ts
      ann_index.ts
    config.schema.yaml
    config.example.yaml
  /services/catalog/
    ingest_openrouter.ts
    ingest_openai.ts
    ingest_gemini.ts
    api.ts
    store.sqlite
  /services/tuning/
    train_gbdt.py
    fit_clusters.py
    export_artifact.py
    api_publish.py
  /artifacts/
    latest.tar
  /ops/
    dashboards/
    runbooks/
```

---

## 13) Citations (key facts you’ll rely on)

* **Avengers-Pro** test-time routing (clusters + α trade-off; reported cost/quality Pareto). ([arXiv][1])
* **GPT-5** API: `reasoning_effort` control, pricing, long-context improvements. ([OpenAI][2])
* **Gemini**: thinking budget control and 1M-token input limit; Pro supports thinking; budget semantics. ([Google AI for Developers][3])
* **Token ranges for thinking** (reference mapping of OpenAI levels to token counts). ([Google AI for Developers][11])
* **OpenRouter**: models API and specific **DeepSeek R1** / **Qwen3-Coder** slugs & pricing. ([OpenRouter][8])
* **OAuth reality:** Gemini API supports OAuth; OpenAI model API is key-based; Anthropic enterprise docs for Claude Code IAM (used with OAuth tokens in practice). ([Google AI for Developers][6], [Anthropic][7])

---

### What to do next

* Green-light **Catalog & Tuning** as separate repos/services.
* Confirm **Claude OAuth header names** you’ll receive; we’ll key the Anthropic adapter to those.
* I’ll synthesize an **initial artifact** (dummy centroids + priors) so you can deploy and start logging immediately; the Tuning service will replace it after week 1 with real data.

The plan keeps Avengers’ math intact, adds a fast SOTA triager, honors your direct-provider/OAuth constraints, and leaves room for optimizer-driven tuning without code changes.

[1]: https://arxiv.org/abs/2508.12631?utm_source=chatgpt.com "Beyond GPT-5: Making LLMs Cheaper and Better via Performance-Efficiency Optimized Routing"
[2]: https://openai.com/index/introducing-gpt-5-for-developers/ "Introducing GPT‑5 for developers | OpenAI"
[3]: https://ai.google.dev/gemini-api/docs/models "Gemini models  |  Gemini API  |  Google AI for Developers"
[4]: https://cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/2-5-pro?utm_source=chatgpt.com "Gemini 2.5 Pro | Generative AI on Vertex AI"
[5]: https://openrouter.ai/deepseek/deepseek-r1?utm_source=chatgpt.com "R1 - API, Providers, Stats"
[6]: https://ai.google.dev/gemini-api/docs/oauth?utm_source=chatgpt.com "Authentication with OAuth quickstart - Gemini API"
[7]: https://docs.anthropic.com/en/api/overview?utm_source=chatgpt.com "Overview"
[8]: https://openrouter.ai/docs/api-reference/list-available-models?utm_source=chatgpt.com "List available models | OpenRouter | Documentation"
[9]: https://docs.anthropic.com/en/docs/claude-code/iam?utm_source=chatgpt.com "Identity and Access Management"
[10]: https://community.openai.com/t/will-there-be-oauth-available-for-the-api-endpoints/24981?utm_source=chatgpt.com "Will there be OAuth Available for the API endpoints?"
[11]: https://ai.google.dev/gemini-api/docs/openai "OpenAI compatibility  |  Gemini API  |  Google AI for Developers"
[12]: https://cloud.google.com/vertex-ai/generative-ai/docs/thinking?utm_source=chatgpt.com "Thinking | Generative AI on Vertex AI"
[13]: https://ai.google.dev/gemini-api/docs/thinking?utm_source=chatgpt.com "Gemini thinking | Gemini API | Google AI for Developers"
[14]: https://openrouter.ai/docs/quickstart?utm_source=chatgpt.com "OpenRouter Quickstart Guide | Developer Documentation"
