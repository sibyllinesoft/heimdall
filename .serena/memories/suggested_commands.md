# Suggested Commands

## Development Commands
- `npm run dev` - Start development server with hot reload
- `npm run build` - Compile TypeScript to JavaScript
- `npm start` - Run production build

## Testing Commands
- `npm test` - Run test suite
- `npm run test:watch` - Run tests in watch mode
- `npm run test:coverage` - Run tests with coverage report
- `npm run test:ui` - Open Vitest UI
- `npm run test:basic` - Run basic integration test
- `npm run test:milestone-*` - Run specific milestone tests

## Code Quality Commands
- `npm run lint` - Run ESLint
- `npm run format` - Format code with Prettier

## Operational Commands
- `npm run obs` - Observability CLI
- `npm run dashboard` - Open monitoring dashboard
- `npm run deploy-check` - Validate deployment readiness
- `npm run slo-status` - Check SLA status
- `npm run emergency-check` - Emergency system check
- `npm run ops-report` - Generate operational report

## Service Endpoints (when running)
- **Catalog Service**: http://localhost:8080
- **Health Check**: http://localhost:8080/health
- **API Docs**: http://localhost:8080/documentation (Swagger)

## Environment Setup
- Copy `.env.example` to `.env` and configure API keys
- Copy `router/config.example.yaml` to `config.yaml` for custom routing config