# Task Completion Checklist

## Before Committing Code
1. **Build Check**: `npm run build` - Ensure TypeScript compiles without errors
2. **Test Suite**: `npm test` - All tests must pass
3. **Code Quality**: `npm run lint` - Fix any linting issues
4. **Formatting**: `npm run format` - Ensure consistent code formatting
5. **Type Safety**: Verify no `any` types introduced, proper type coverage

## Testing Requirements
- Unit tests for new functions/methods
- Integration tests for new API endpoints
- Coverage should not decrease significantly
- All milestone tests should continue to pass

## Configuration Updates
- Update `config.schema.yaml` if new configuration options added
- Verify `config.example.yaml` reflects all available options
- Test with both example config and production-like config

## Documentation Updates
- Update README.md for new features
- Add/update API documentation
- Update configuration reference if needed
- Consider updating roadmap/milestones

## Deployment Considerations
- Test with Docker container: `docker build` and basic container run
- Verify environment variable handling
- Check health endpoints work correctly
- Validate observability/monitoring integration

## Performance Validation
- Run performance benchmarks if applicable
- Verify routing decision times stay under 50ms
- Check memory usage for long-running processes