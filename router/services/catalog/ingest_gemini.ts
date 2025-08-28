/**
 * Gemini Ingestor
 * Fetches Gemini model information with thinking budget support
 * Supports 1M token context window for Gemini 2.5 Pro
 */

import { ModelInfo } from '../../../src/types/common.js';

export class GeminiIngestor {
  private readonly baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
  
  // Static configuration for Gemini models (as API may not expose all details)
  private readonly staticModels: ModelInfo[] = [
    {
      slug: 'google/gemini-2.5-pro',
      provider: 'google',
      family: 'gemini',
      ctx_in: 1048576, // 1M token context window
      params: {
        thinking: true,
        json: true,
        tools: true
      },
      pricing: {
        in_per_million: 3.50,
        out_per_million: 10.50,
        unit: 'USD_per_1M_tokens'
      },
      capabilities: {
        ctx_in_max: 1048576, // 1M tokens
        ctx_out_max: 8192,
        supports_json: true,
        tools: true,
        thinking: {
          type: 'budget',
          ranges: {
            low: 4000,
            medium: 8000,
            high: 20000,
            max: 32000
          }
        }
      }
    },
    {
      slug: 'google/gemini-2.5-flash',
      provider: 'google',
      family: 'gemini',
      ctx_in: 1048576, // 1M token context window
      params: {
        thinking: true,
        json: true,
        tools: true
      },
      pricing: {
        in_per_million: 0.075,
        out_per_million: 0.30,
        unit: 'USD_per_1M_tokens'
      },
      capabilities: {
        ctx_in_max: 1048576,
        ctx_out_max: 8192,
        supports_json: true,
        tools: true,
        thinking: {
          type: 'budget',
          ranges: {
            low: 2000,
            medium: 4000,
            high: 8000,
            max: 16000
          }
        }
      }
    }
  ];
  
  async ingest(): Promise<ModelInfo[]> {
    try {
      const models = [...this.staticModels];
      
      // Try to fetch dynamic models if API key is available
      if (process.env.GEMINI_API_KEY) {
        try {
          const dynamicModels = await this.fetchDynamicModels();
          // Merge dynamic models with static config
          const mergedModels = this.mergeModels(models, dynamicModels);
          return mergedModels;
        } catch (error) {
          console.warn('Failed to fetch dynamic Gemini models, using static config:', error);
        }
      }
      
      return models;
    } catch (error) {
      console.error('Failed to ingest from Gemini:', error);
      // Return static models as fallback
      return this.staticModels;
    }
  }
  
  private async fetchDynamicModels(): Promise<ModelInfo[]> {
    const response = await fetch(`${this.baseUrl}/models?key=${process.env.GEMINI_API_KEY}`, {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Bifrost-Router/1.0'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json() as {
      models: Array<{
        name: string;
        version: string;
        displayName: string;
        description: string;
        inputTokenLimit: number;
        outputTokenLimit: number;
        supportedGenerationMethods: string[];
      }>;
    };
    
    return data.models
      .filter(model => this.shouldIncludeModel(model))
      .map(model => this.normalizeModel(model))
      .filter((model): model is ModelInfo => model !== null);
  }
  
  private shouldIncludeModel(model: {
    name: string;
    version: string;
    displayName: string;
    supportedGenerationMethods: string[];
  }): boolean {
    // Focus on Gemini 2.5 models that support generation
    const modelName = model.name.toLowerCase();
    
    return (modelName.includes('gemini-2.5') || modelName.includes('gemini-pro')) &&
           model.supportedGenerationMethods.includes('generateContent') &&
           !modelName.includes('vision'); // Skip vision-only models for now
  }
  
  private normalizeModel(model: {
    name: string;
    version: string;
    displayName: string;
    description: string;
    inputTokenLimit: number;
    outputTokenLimit: number;
  }): ModelInfo | null {
    try {
      const slug = this.createSlug(model.name);
      const family = 'gemini';
      
      // Determine thinking support based on model name/version
      const supportsThinking = this.checkThinkingSupport(model.name);
      
      // Context limits from API
      const contextInput = Math.min(model.inputTokenLimit || 1048576, 1048576); // Cap at 1M
      const contextOutput = model.outputTokenLimit || 8192;
      
      // Pricing estimation based on model type
      const pricing = this.estimatePricing(model.name);
      
      return {
        slug,
        provider: 'google',
        family,
        ctx_in: contextInput,
        params: {
          thinking: supportsThinking,
          json: true,
          tools: true
        },
        pricing,
        capabilities: {
          ctx_in_max: contextInput,
          ctx_out_max: contextOutput,
          supports_json: true,
          tools: true,
          thinking: supportsThinking ? {
            type: 'budget',
            ranges: this.getThinkingRanges(model.name)
          } : null
        }
      };
    } catch (error) {
      console.error(`Failed to normalize Gemini model ${model.name}:`, error);
      return null;
    }
  }
  
  private createSlug(modelName: string): string {
    // Convert from 'models/gemini-2.5-pro' to 'google/gemini-2.5-pro'
    const cleanName = modelName.replace('models/', '');
    return `google/${cleanName}`;
  }
  
  private checkThinkingSupport(modelName: string): boolean {
    // Gemini 2.5 Pro supports thinking budgets
    return modelName.includes('gemini-2.5-pro') || 
           modelName.includes('gemini-pro');
  }
  
  private getThinkingRanges(modelName: string): {
    low: number;
    medium: number;
    high: number;
    max: number;
  } {
    if (modelName.includes('gemini-2.5-pro')) {
      return {
        low: 4000,
        medium: 8000,
        high: 20000,
        max: 32000
      };
    }
    
    // Flash model has lower thinking budget limits
    return {
      low: 2000,
      medium: 4000,
      high: 8000,
      max: 16000
    };
  }
  
  private estimatePricing(modelName: string): {
    in_per_million: number;
    out_per_million: number;
    unit: string;
  } {
    if (modelName.includes('flash')) {
      return {
        in_per_million: 0.075,
        out_per_million: 0.30,
        unit: 'USD_per_1M_tokens'
      };
    }
    
    // Pro pricing
    return {
      in_per_million: 3.50,
      out_per_million: 10.50,
      unit: 'USD_per_1M_tokens'
    };
  }
  
  private mergeModels(staticModels: ModelInfo[], dynamicModels: ModelInfo[]): ModelInfo[] {
    const merged = new Map<string, ModelInfo>();
    
    // Start with static models (our curated config)
    for (const model of staticModels) {
      merged.set(model.slug, model);
    }
    
    // Overlay dynamic models, but preserve our static pricing and capabilities
    for (const dynamicModel of dynamicModels) {
      const existing = merged.get(dynamicModel.slug);
      if (existing) {
        // Update context limits from API but keep our pricing/capabilities
        merged.set(dynamicModel.slug, {
          ...existing,
          ctx_in: Math.max(existing.ctx_in, dynamicModel.ctx_in),
          capabilities: existing.capabilities ? {
            ...existing.capabilities,
            ctx_in_max: Math.max(existing.capabilities.ctx_in_max, dynamicModel.ctx_in),
            ctx_out_max: Math.max(
              existing.capabilities.ctx_out_max, 
              dynamicModel.capabilities?.ctx_out_max || 0
            )
          } : dynamicModel.capabilities
        });
      } else {
        merged.set(dynamicModel.slug, dynamicModel);
      }
    }
    
    return Array.from(merged.values());
  }
}