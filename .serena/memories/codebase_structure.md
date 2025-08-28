# Codebase Structure

## Directory Layout

```
/src/                           # Main application code
  index.ts                      # Main entry point
  config.ts                     # Configuration loader
  /types/                       # TypeScript definitions
  /utils/                       # Utility functions
    logger.ts
    env-config.ts
    filesystem.ts
    model-parameters.ts
    provider-inference.ts

/router/                        # Router implementation
  /plugins/bifrost/             # Main router logic
    router_prehook.ts           # Entry point
    /adapters/                  # Auth adapters
    /scoring/                   # α-score implementation
    /triage/                    # GBDT + features
  /services/catalog/            # Model catalog service
    api.ts                      # HTTP API
    /ingest_*.ts                # Provider ingestors
  config.example.yaml           # Example configuration
  config.schema.yaml            # Configuration schema

/tests/                         # Test files
/scripts/                       # Development and operational scripts
/artifacts/                     # Build artifacts and caches
```

## Key Components
- **RouterPreHook**: Main routing decision engine
- **CatalogService**: Model inventory and capabilities management
- **Auth Adapters**: Pluggable authentication for different providers
- **Scoring System**: Cost/quality optimization algorithms
- **Triage System**: GBDT-based request classification