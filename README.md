# Bifrost Router

An intelligent LLM router implementing Avengers-style cost↔quality routing with GBDT triage, direct GPT-5/Gemini/Claude OAuth paths, and pluggable auth adapters.

## Architecture

- **Router PreHook**: Feature extraction → GBDT triage (3-way) → Avengers α-score in-bucket → route decision
- **Catalog Service**: Live model/pricing/capabilities from OpenRouter, OpenAI GPT-5, Gemini
- **Tuning Service**: Trains GBDT + fits α/thresholds from logs
- **Auth Adapters**: Modular authentication (Claude OAuth, Gemini OAuth/key, OpenAI key)

## Key Features

- **GBDT Triage**: Intelligent bucket selection (cheap/mid/hard) based on request features
- **Avengers-Pro α-score**: Quality vs cost optimization within buckets
- **Thinking Budget Control**: GPT-5 `reasoning_effort`, Gemini `thinkingBudget`
- **OAuth Support**: Claude Code integration, Gemini OAuth with PKCE
- **429 Fallback**: Immediate non-Anthropic rerouting on rate limits
- **Long Context**: Gemini 2.5 Pro 1M token support

## Quick Start

### Prerequisites

- Node.js 18+
- API keys (optional but recommended):
  - `OPENAI_API_KEY` for GPT-5
  - `GEMINI_API_KEY` for Gemini models
  - `OPENROUTER_API_KEY` for DeepSeek R1, Qwen3-Coder

### Installation

```bash
# Clone repository
git clone <repository-url>
cd heimdall

# Install dependencies
npm install

# Copy example environment file
cp .env.example .env
# Edit .env with your API keys

# Build the project
npm run build
```

### Configuration

Copy the example configuration:

```bash
cp router/config.example.yaml config.yaml
```

Edit `config.yaml` to customize:

- **Alpha**: Quality vs cost trade-off (0.6 = 60% quality focus)
- **Thresholds**: Bucket selection sensitivity
- **Thinking Budgets**: Reasoning effort for GPT-5/Gemini
- **Model Candidates**: Available models per bucket

### Running

```bash
# Development mode
npm run dev

# Production mode
npm start
```

The service will start:
- **Catalog Service**: http://localhost:8080
- **Health Check**: http://localhost:8080/health

## API Endpoints

### Catalog Service

- `GET /v1/models` - List all models with optional filtering
- `GET /v1/capabilities/:model` - Get model capabilities
- `GET /v1/pricing/:model` - Get model pricing
- `GET /v1/feature-flags` - Get feature flags
- `GET /health` - Health check and statistics

### Router Usage

The router is designed as a Bifrost PreHook. Example integration:

```typescript
import { RouterPreHook } from './router/plugins/bifrost/router_prehook.js';

const router = new RouterPreHook(config, catalogBaseUrl);

const decision = await router.decide({
  url: '/v1/chat/completions',
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'authorization': 'Bearer user-oauth-token' // For Claude
  },
  body: {
    messages: [{ role: 'user', content: 'Write a Python function' }],
    model: 'auto'
  }
});

// Decision contains routing information:
// - kind: 'anthropic' | 'openai' | 'google' | 'openrouter'
// - model: Selected model slug
// - params: Thinking budget, reasoning effort
// - auth: Authentication method
// - fallbacks: Alternative models
```

## Routing Algorithm

1. **Feature Extraction** (≤25ms):
   - Embedding of prompt (cached)
   - Cluster signals (ANN search)
   - Lexical features (code/math detection)
   - Context analysis

2. **GBDT Triage**:
   - Predict bucket probabilities
   - Apply context guardrails
   - Select bucket (cheap/mid/hard)

3. **In-Bucket Selection**:
   - **Cheap**: DeepSeek R1, Qwen3-Coder via OpenRouter
   - **Mid**: Claude (if OAuth) or GPT-5/Gemini with medium thinking
   - **Hard**: GPT-5/Gemini with high thinking, prefer Gemini for long context

4. **α-Score Calculation**:
   ```
   score = α × Quality[model,cluster] - (1-α) × Cost[model] - penalties
   ```

## Model Support

### Cheap Bucket (OpenRouter)
- **DeepSeek R1**: Reasoning model, ~$0.40/1M input tokens
- **Qwen3-Coder**: Code specialist, competitive pricing

### Mid/Hard Buckets (Direct APIs)
- **GPT-5**: `reasoning_effort` control (low/medium/high)
- **Gemini 2.5 Pro**: `thinkingBudget` tokens, 1M context
- **Claude**: OAuth passthrough (when available)

## Authentication

### Supported Methods

1. **Claude OAuth** (`anthropic-oauth`):
   - Detects Bearer tokens from Claude Code integration
   - Direct passthrough to Anthropic API
   - Automatic 429 fallback to non-Anthropic models

2. **Gemini OAuth/API Key** (`google-oauth`):
   - OAuth Bearer tokens (PKCE flow)
   - Fallback to `GEMINI_API_KEY`
   - Header or query parameter API key support

3. **OpenAI API Key** (`openai-key`):
   - Environment variable `OPENAI_API_KEY`
   - Optional user-provided keys
   - No official OAuth (key-based only)

### Configuration

Enable/disable adapters in `config.yaml`:

```yaml
auth_adapters:
  enabled: ["anthropic-oauth", "google-oauth", "openai-key"]
```

## Error Handling & Fallbacks

| Condition | Action |
|-----------|--------|
| **Claude 429** | Immediate reroute to best non-Anthropic (GPT-5/Gemini) |
| **OpenAI/Gemini 5xx** | Cross-fallback within bucket |
| **OpenRouter down** | Escalate cheap→mid bucket |
| **Context overflow** | Force higher bucket (Gemini for 200k+) |

## Performance Targets

- **Feature Extraction**: <25ms per request
- **Routing Decision**: <50ms total
- **Fallback Response**: <300ms for 429 handling
- **Context Capacity**: Up to 1M tokens (Gemini)

## Development

### Project Structure

```
/router/
  /plugins/bifrost/          # Main router logic
    router_prehook.ts         # Entry point
    /adapters/                # Auth adapters
    /scoring/                 # α-score implementation
    /triage/                  # GBDT + features
  /services/catalog/          # Model catalog service
    api.ts                    # HTTP API
    /ingest_*.ts              # Provider ingestors
/src/
  index.ts                    # Main entry point
  config.ts                   # Configuration loader
  /types/                     # TypeScript definitions
```

### Testing

```bash
# Run tests
npm test

# Type checking
npm run build

# Linting
npm run lint
```

### Adding New Providers

1. Create ingestor in `/router/services/catalog/`
2. Add to `CatalogService.refreshData()`
3. Update model candidates in config
4. Add routing logic in PreHook if needed

### Adding New Auth Adapters

1. Implement `AuthAdapter` interface
2. Register in `RouterPreHook.setupAuthAdapters()`
3. Add to enabled list in config

## Monitoring

### Metrics

- Route share by bucket (cheap/mid/hard)
- Cost per task, P95 latency
- 429 escalation rates
- Win-rate vs baseline models
- Feature extraction timing

### Logs

- Routing decisions with reasoning
- Fallback triggers and outcomes
- Model performance metrics
- Auth adapter usage

## Configuration Reference

See `router/config.schema.yaml` for complete configuration options.

### Key Settings

- `router.alpha`: Quality vs cost balance (0-1)
- `router.thresholds.cheap`: Threshold for cheap bucket routing
- `router.thresholds.hard`: Threshold for hard bucket routing
- `router.bucket_defaults`: Default thinking parameters
- `catalog.refresh_seconds`: Model data refresh interval
- `tuning.reload_seconds`: Artifact reload interval

## License

MIT License - see LICENSE file for details.

## Contributing

1. Fork the repository
2. Create feature branch
3. Add tests for new functionality
4. Ensure all tests pass
5. Submit pull request

## Roadmap

- [ ] **Milestone 2**: Embeddings + ANN integration (FAISS)
- [ ] **Milestone 3**: Real GBDT training pipeline (LightGBM)
- [ ] **Milestone 4**: Production OAuth flows
- [ ] **Milestone 5**: Monitoring dashboard
- [ ] **Milestone 6**: Automated tuning loop

For detailed implementation plan, see `TODO.md`.