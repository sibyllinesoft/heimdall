# Coding Standards & Conventions

## TypeScript Configuration
- Strict mode enabled in tsconfig.json
- ES modules (`"type": "module"` in package.json)
- Target Node.js 18+

## Code Style
- **Linting**: ESLint with TypeScript rules (`@typescript-eslint`)
- **Formatting**: Prettier for consistent code formatting
- **File Extensions**: `.ts` for TypeScript, `.js` for JavaScript
- **Import Style**: ES6 imports with `.js` extensions for compiled output

## Testing Conventions
- **Framework**: Vitest (fast Vite-native test runner)
- **Coverage**: v8 coverage with thresholds
- **File Naming**: `*.test.ts` for unit tests
- **Integration Tests**: Located in `/tests/` directory
- **Mocking**: MSW for HTTP mocking

## Code Organization
- **Types**: Centralized in `/src/types/`
- **Utils**: Reusable utilities in `/src/utils/`
- **Config**: Environment and YAML-based configuration
- **Services**: Domain-specific business logic in separate modules
- **Plugins**: Extensible architecture for auth adapters and routing logic

## Error Handling
- Structured error responses with appropriate HTTP status codes
- Comprehensive logging with Winston
- Graceful fallbacks for external service failures

## Documentation
- TSDoc comments for public APIs
- YAML schema for configuration validation
- Swagger/OpenAPI documentation for REST endpoints