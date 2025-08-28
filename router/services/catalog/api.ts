/**
 * Catalog Service API
 * Provides unified access to model information from multiple providers
 */

import Fastify, { FastifyInstance } from 'fastify';
import { ModelInfo, ModelCapabilities, ModelPricing } from '../../../src/types/common.js';
import { CatalogStore } from './store.js';
import { OpenRouterIngestor } from './ingest_openrouter.js';
import { OpenAIIngestor } from './ingest_openai.js';
import { GeminiIngestor } from './ingest_gemini.js';

export interface CatalogConfig {
  port: number;
  host: string;
  refreshIntervalMs: number;
  store: {
    type: 'sqlite';
    path: string;
  };
}

export class CatalogService {
  private app: FastifyInstance;
  private store: CatalogStore;
  private ingestors: {
    openrouter: OpenRouterIngestor;
    openai: OpenAIIngestor;
    gemini: GeminiIngestor;
  };
  private refreshTimer?: NodeJS.Timeout;
  
  constructor(private config: CatalogConfig) {
    this.app = Fastify({ logger: true });
    this.store = new CatalogStore(config.store.path);
    
    this.ingestors = {
      openrouter: new OpenRouterIngestor(),
      openai: new OpenAIIngestor(),
      gemini: new GeminiIngestor()
    };
    
    this.setupRoutes();
  }
  
  async start(): Promise<void> {
    await this.store.initialize();
    
    // Initial data ingestion
    await this.refreshData();
    
    // Start periodic refresh
    this.refreshTimer = setInterval(() => {
      this.refreshData().catch(console.error);
    }, this.config.refreshIntervalMs);
    
    await this.app.listen({ port: this.config.port, host: this.config.host });
    console.log(`Catalog Service listening on ${this.config.host}:${this.config.port}`);
  }
  
  async stop(): Promise<void> {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }
    await this.app.close();
    await this.store.close();
  }
  
  private setupRoutes(): void {
    // Get models with optional filtering
    this.app.get<{
      Querystring: {
        provider?: string;
        family?: string;
      };
    }>('/v1/models', async (request, reply) => {
      try {
        const { provider, family } = request.query;
        const models = await this.store.getModels({ provider, family });
        return { models };
      } catch (error) {
        reply.code(500).send({ error: 'Failed to retrieve models' });
      }
    });
    
    // Get capabilities for specific model
    this.app.get<{
      Params: { model: string };
    }>('/v1/capabilities/:model', async (request, reply) => {
      try {
        const model = decodeURIComponent(request.params.model);
        const capabilities = await this.store.getCapabilities(model);
        
        if (!capabilities) {
          reply.code(404).send({ error: 'Model not found' });
          return;
        }
        
        return capabilities;
      } catch (error) {
        reply.code(500).send({ error: 'Failed to retrieve capabilities' });
      }
    });
    
    // Get pricing for specific model
    this.app.get<{
      Params: { model: string };
    }>('/v1/pricing/:model', async (request, reply) => {
      try {
        const model = decodeURIComponent(request.params.model);
        const pricing = await this.store.getPricing(model);
        
        if (!pricing) {
          reply.code(404).send({ error: 'Model not found' });
          return;
        }
        
        return pricing;
      } catch (error) {
        reply.code(500).send({ error: 'Failed to retrieve pricing' });
      }
    });
    
    // Get feature flags
    this.app.get('/v1/feature-flags', async (request, reply) => {
      try {
        const flags = await this.store.getFeatureFlags();
        return { flags };
      } catch (error) {
        reply.code(500).send({ error: 'Failed to retrieve feature flags' });
      }
    });
    
    // Health check
    this.app.get('/health', async () => {
      const stats = await this.store.getStats();
      return {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        stats
      };
    });
  }
  
  private async refreshData(): Promise<void> {
    console.log('Refreshing catalog data...');
    
    try {
      // Parallel ingestion from all providers
      const [openrouterModels, openaiModels, geminiModels] = await Promise.allSettled([
        this.ingestors.openrouter.ingest(),
        this.ingestors.openai.ingest(),
        this.ingestors.gemini.ingest()
      ]);
      
      // Process results and update store
      const allModels: ModelInfo[] = [];
      
      if (openrouterModels.status === 'fulfilled') {
        allModels.push(...openrouterModels.value);
        console.log(`Ingested ${openrouterModels.value.length} OpenRouter models`);
      } else {
        console.error('OpenRouter ingestion failed:', openrouterModels.reason);
      }
      
      if (openaiModels.status === 'fulfilled') {
        allModels.push(...openaiModels.value);
        console.log(`Ingested ${openaiModels.value.length} OpenAI models`);
      } else {
        console.error('OpenAI ingestion failed:', openaiModels.reason);
      }
      
      if (geminiModels.status === 'fulfilled') {
        allModels.push(...geminiModels.value);
        console.log(`Ingested ${geminiModels.value.length} Gemini models`);
      } else {
        console.error('Gemini ingestion failed:', geminiModels.reason);
      }
      
      // Update store with new data
      await this.store.updateModels(allModels);
      
      console.log(`Catalog refresh complete: ${allModels.length} total models`);
    } catch (error) {
      console.error('Catalog refresh failed:', error);
    }
  }
}