/**
 * Catalog Service Client
 * HTTP client for interacting with the Catalog Service API
 */

import { ModelInfo, ModelCapabilities, ModelPricing } from '../../../src/types/common.js';

export interface CatalogModelsResponse {
  models: ModelInfo[];
}

export interface CatalogStatsResponse {
  total_models: number;
  providers: Record<string, number>;
  last_updated: string;
}

/**
 * Client for Catalog Service API
 */
export class CatalogClient {
  private cache = new Map<string, { data: unknown; expires: number }>();
  private readonly cacheTimeout = 300000; // 5 minutes
  
  constructor(private baseUrl: string) {
    // Ensure baseUrl doesn't end with slash
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }
  
  /**
   * Get models with optional filtering
   */
  async getModels(params?: {
    provider?: string;
    family?: string;
  }): Promise<ModelInfo[]> {
    const queryString = params ? new URLSearchParams(
      Object.fromEntries(
        Object.entries(params).filter(([, v]) => v !== undefined)
      )
    ).toString() : '';
    
    const url = `${this.baseUrl}/v1/models${queryString ? '?' + queryString : ''}`;
    const cacheKey = `models:${queryString}`;
    
    const cached = this.getFromCache<CatalogModelsResponse>(cacheKey);
    if (cached) {
      return cached.models;
    }
    
    try {
      const response = await this.fetchWithRetry(url);
      const data = await response.json() as CatalogModelsResponse;
      
      this.setCache(cacheKey, data);
      return data.models;
    } catch (error) {
      console.error('Failed to fetch models from catalog:', error);
      throw error;
    }
  }
  
  /**
   * Get capabilities for a specific model
   */
  async getCapabilities(modelSlug: string): Promise<ModelCapabilities | null> {
    const encodedModel = encodeURIComponent(modelSlug);
    const url = `${this.baseUrl}/v1/capabilities/${encodedModel}`;
    const cacheKey = `capabilities:${modelSlug}`;
    
    const cached = this.getFromCache<ModelCapabilities>(cacheKey);
    if (cached) {
      return cached;
    }
    
    try {
      const response = await this.fetchWithRetry(url);
      
      if (response.status === 404) {
        return null;
      }
      
      const data = await response.json() as ModelCapabilities;
      this.setCache(cacheKey, data);
      return data;
    } catch (error) {
      console.error(`Failed to fetch capabilities for ${modelSlug}:`, error);
      return null; // Graceful degradation
    }
  }
  
  /**
   * Get pricing for a specific model
   */
  async getPricing(modelSlug: string): Promise<ModelPricing | null> {
    const encodedModel = encodeURIComponent(modelSlug);
    const url = `${this.baseUrl}/v1/pricing/${encodedModel}`;
    const cacheKey = `pricing:${modelSlug}`;
    
    const cached = this.getFromCache<ModelPricing>(cacheKey);
    if (cached) {
      return cached;
    }
    
    try {
      const response = await this.fetchWithRetry(url);
      
      if (response.status === 404) {
        return null;
      }
      
      const data = await response.json() as ModelPricing;
      this.setCache(cacheKey, data);
      return data;
    } catch (error) {
      console.error(`Failed to fetch pricing for ${modelSlug}:`, error);
      return null; // Graceful degradation
    }
  }
  
  /**
   * Get feature flags
   */
  async getFeatureFlags(): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}/v1/feature-flags`;
    const cacheKey = 'feature-flags';
    
    const cached = this.getFromCache<{ flags: Record<string, unknown> }>(cacheKey);
    if (cached) {
      return cached.flags;
    }
    
    try {
      const response = await this.fetchWithRetry(url);
      const data = await response.json() as { flags: Record<string, unknown> };
      
      this.setCache(cacheKey, data);
      return data.flags;
    } catch (error) {
      console.error('Failed to fetch feature flags:', error);
      return {}; // Graceful degradation
    }
  }
  
  /**
   * Health check and stats
   */
  /**
   * Get service health and statistics
   */
  /**
   * Get service health and statistics
   */
  /**
   * Get service health and statistics
   */
  async getHealth(): Promise<{ status: string; timestamp: string; stats: CatalogStatsResponse }> {
    try {
      const response = await this.fetchWithRetry(`${this.baseUrl}/health`);
      const data = await response.json() as any;
      
      return {
        status: data.status || 'unknown',
        timestamp: data.timestamp || new Date().toISOString(),
        stats: data.stats || { total_models: 0, providers: {}, last_updated: new Date().toISOString() }
      };
    } catch (error) {
      console.error('Failed to get health:', error);
      return {
        status: 'error',
        timestamp: new Date().toISOString(),
        stats: { total_models: 0, providers: {}, last_updated: new Date().toISOString() }
      };
    }
  }
  
  /**
   * Get all models for a specific provider
   */
  async getProviderModels(provider: string): Promise<ModelInfo[]> {
    return this.getModels({ provider });
  }
  
  /**
   * Get models by family (e.g., 'deepseek', 'qwen', 'gpt5')
   */
  async getFamilyModels(family: string): Promise<ModelInfo[]> {
    return this.getModels({ family });
  }
  
  /**
   * Find models that match context requirements
   */
  async findModelsWithContext(minContext: number): Promise<ModelInfo[]> {
    const allModels = await this.getModels();
    return allModels.filter(model => model.ctx_in >= minContext);
  }
  
  /**
   * Find models within price range
   */
  async findModelsInPriceRange(
    maxInputPrice: number,
    maxOutputPrice: number
  ): Promise<ModelInfo[]> {
    const allModels = await this.getModels();
    return allModels.filter(model => 
      model.pricing.in_per_million <= maxInputPrice &&
      model.pricing.out_per_million <= maxOutputPrice
    );
  }
  
  private async fetchWithRetry(
    url: string,
    retries = 3,
    delay = 1000
  ): Promise<Response> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const response = await fetch(url, {
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Bifrost-Router/1.0'
          },
          timeout: 10000 // 10 second timeout
        } as RequestInit);
        
        if (!response.ok) {
          if (response.status >= 500 && attempt < retries) {
            // Retry on server errors
            await this.sleep(delay * attempt);
            continue;
          }
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        return response;
      } catch (error) {
        if (attempt === retries) {
          throw error;
        }
        
        console.warn(`Catalog request attempt ${attempt} failed:`, error);
        await this.sleep(delay * attempt);
      }
    }
    
    throw new Error('All retry attempts failed');
  }
  
  private getFromCache<T>(key: string): T | null {
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) {
      return cached.data as T;
    }
    return null;
  }
  
  private setCache(key: string, data: unknown): void {
    this.cache.set(key, {
      data,
      expires: Date.now() + this.cacheTimeout
    });
  }
  
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * Clear all cached data
   */
  clearCache(): void {
    this.cache.clear();
  }
  
  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; keys: string[] } {
    const now = Date.now();
    const validKeys: string[] = [];
    
    for (const [key, cached] of this.cache.entries()) {
      if (cached.expires > now) {
        validKeys.push(key);
      } else {
        this.cache.delete(key); // Cleanup expired entries
      }
    }
    
    return {
      size: this.cache.size,
      keys: validKeys
    };
  }
}