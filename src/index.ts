/**
 * Bifrost Router Main Entry Point
 */

import { CatalogService } from '../router/services/catalog/api.js';
import { RouterPreHook } from '../router/plugins/bifrost/router_prehook.js';
import { loadConfig, ensureEmergencyArtifact, applyEnvOverrides } from './config.js';
import * as dotenv from 'dotenv';
import { ensureDirectories } from './utils/filesystem.js';
import { Logger } from './utils/logger.js';

// Load environment variables
dotenv.config();

async function main() {
  try {
    Logger.info('Starting Bifrost Router...', { component: 'main' });
    
    // Ensure data directories exist
    await ensureDirectories('./data', './logs', './artifacts');
    
    // Create emergency artifact if needed
    await ensureEmergencyArtifact();
    
    // Load configuration
    let config = await loadConfig();
    config = applyEnvOverrides(config);
    console.log('Configuration loaded and environment overrides applied');
    
    // Start Catalog Service
    const catalogService = new CatalogService({
      port: 8080,
      host: '0.0.0.0',
      refreshIntervalMs: config.catalog.refresh_seconds * 1000,
      store: {
        type: 'sqlite',
        path: './data/catalog.db'
      }
    });
    
    console.log('Starting Catalog Service...');
    await catalogService.start();
    console.log('Catalog Service started');
    
    // Initialize Router PreHook
    const router = new RouterPreHook(config, config.catalog.base_url);
    console.log('Router PreHook initialized');
    
    // Example usage
    const testRequest = {
      url: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer test-token'
      },
      body: {
        messages: [
          {
            role: 'user',
            content: 'Write a Python function to calculate fibonacci numbers'
          }
        ],
        model: 'auto',
        stream: false
      }
    };
    
    console.log('\nTesting router decision...');
    const decision = await router.decide(testRequest);
    console.log('Router decision:', JSON.stringify(decision, null, 2));
    
    console.log('\nBifrost Router is running...');
    console.log('Catalog Service: http://localhost:8080');
    console.log('Health check: http://localhost:8080/health');
    
  } catch (error) {
    Logger.error('start Bifrost Router', error, { component: 'main' });
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\nReceived SIGINT, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nReceived SIGTERM, shutting down gracefully...');
  process.exit(0);
});

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}