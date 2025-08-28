/**
 * OpenAI Ingestor
 * Static configuration for GPT-5 and reasoning models
 * Uses OpenAI API for dynamic model discovery when available
 */

import { ModelInfo } from '../../../src/types/common.js';

interface OpenAIModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

export class OpenAIIngestor {
  private readonly baseUrl = 'https://api.openai.com/v1';
  
  // Static configuration for GPT-5 (as it may not appear in /models endpoint yet)
  private readonly staticModels: ModelInfo[] = [
    {
      slug: 'openai/gpt-5',
      provider: 'openai',
      family: 'gpt5',
      ctx_in: 200000, // Expected context window for GPT-5
      params: {
        thinking: true,
        json: true,
        tools: true
      },
      pricing: {
        in_per_million: 10.00, // Estimated pricing - update when official
        out_per_million: 30.00,
        unit: 'USD_per_1M_tokens'
      },
      capabilities: {
        ctx_in_max: 200000,
        ctx_out_max: 16384,
        supports_json: true,
        tools: true,
        thinking: {
          type: 'effort',
          ranges: {
            low: 'low',
            medium: 'medium',
            high: 'high'
          }
        }
      }
    },
    // Add other reasoning models as they become available
    {
      slug: 'openai/o1-preview',
      provider: 'openai',
      family: 'o1',
      ctx_in: 128000,
      params: {
        thinking: true,
        json: false, // O1 models have limited JSON support
        tools: false
      },
      pricing: {
        in_per_million: 15.00,
        out_per_million: 60.00,
        unit: 'USD_per_1M_tokens'
      },
      capabilities: {
        ctx_in_max: 128000,
        ctx_out_max: 32768,
        supports_json: false,
        tools: false,
        thinking: {
          type: 'effort',
          ranges: {
            low: 'low',
            medium: 'medium', 
            high: 'high'
          }
        }
      }
    }
  ];
  
  async ingest(): Promise<ModelInfo[]> {
    try {
      const models = [...this.staticModels];
      
      // Try to fetch dynamic models if API key is available
      if (process.env.OPENAI_API_KEY) {
        try {
          const dynamicModels = await this.fetchDynamicModels();
          models.push(...dynamicModels);
        } catch (error) {
          console.warn('Failed to fetch dynamic OpenAI models, using static config:', error);
        }
      }
      
      return models;
    } catch (error) {
      console.error('Failed to ingest from OpenAI:', error);
      // Return static models as fallback
      return this.staticModels;
    }
  }
  
  private async fetchDynamicModels(): Promise<ModelInfo[]> {
    const response = await fetch(`${this.baseUrl}/models`, {
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Bifrost-Router/1.0'
      }
    });
    
    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json() as { data: OpenAIModel[] };
    
    return data.data
      .filter(model => this.shouldIncludeModel(model))
      .map(model => this.normalizeModel(model))
      .filter((model): model is ModelInfo => model !== null);
  }
  
  private shouldIncludeModel(model: OpenAIModel): boolean {
    // Focus on reasoning and latest models
    const targetModels = [
      'gpt-5',
      'o1',
      'gpt-4o-reasoning',
      'reasoning'
    ];
    
    const modelId = model.id.toLowerCase();
    return targetModels.some(target => modelId.includes(target)) &&
           !modelId.includes('instruct'); // Skip instruct variants for now
  }
  
  private normalizeModel(model: OpenAIModel): ModelInfo | null {
    try {
      const family = this.extractFamily(model.id);
      
      // Default capabilities based on model family
      const supportsThinking = this.checkThinkingSupport(model.id);
      const contextWindow = this.getContextWindow(model.id);
      const pricing = this.getPricing(model.id);
      
      return {
        slug: `openai/${model.id}`,
        provider: 'openai',
        family,
        ctx_in: contextWindow.input,
        params: {
          thinking: supportsThinking,
          json: this.checkJsonSupport(model.id),
          tools: this.checkToolSupport(model.id)
        },
        pricing,
        capabilities: {
          ctx_in_max: contextWindow.input,
          ctx_out_max: contextWindow.output,
          supports_json: this.checkJsonSupport(model.id),
          tools: this.checkToolSupport(model.id),
          thinking: supportsThinking ? {
            type: 'effort',
            ranges: {
              low: 'low',
              medium: 'medium',
              high: 'high'
            }
          } : null
        }
      };
    } catch (error) {
      console.error(`Failed to normalize OpenAI model ${model.id}:`, error);
      return null;
    }
  }
  
  private extractFamily(modelId: string): string {
    if (modelId.includes('gpt-5')) return 'gpt5';
    if (modelId.includes('o1')) return 'o1';
    if (modelId.includes('gpt-4o')) return 'gpt4o';
    if (modelId.includes('gpt-4')) return 'gpt4';
    return 'unknown';
  }
  
  private checkThinkingSupport(modelId: string): boolean {
    return modelId.includes('o1') || 
           modelId.includes('gpt-5') ||
           modelId.includes('reasoning');
  }
  
  private checkJsonSupport(modelId: string): boolean {
    // O1 models have limited JSON support
    return !modelId.includes('o1');
  }
  
  private checkToolSupport(modelId: string): boolean {
    // O1 models don't support function calling yet
    return !modelId.includes('o1');
  }
  
  private getContextWindow(modelId: string): { input: number; output: number } {
    if (modelId.includes('gpt-5')) {
      return { input: 200000, output: 16384 };
    }
    if (modelId.includes('o1')) {
      return { input: 128000, output: 32768 };
    }
    if (modelId.includes('gpt-4o')) {
      return { input: 128000, output: 16384 };
    }
    return { input: 8192, output: 4096 }; // default
  }
  
  private getPricing(modelId: string): { in_per_million: number; out_per_million: number; unit: string } {
    // Pricing based on known OpenAI model costs
    if (modelId.includes('gpt-5')) {
      return { in_per_million: 10.00, out_per_million: 30.00, unit: 'USD_per_1M_tokens' };
    }
    if (modelId.includes('o1-preview')) {
      return { in_per_million: 15.00, out_per_million: 60.00, unit: 'USD_per_1M_tokens' };
    }
    if (modelId.includes('o1-mini')) {
      return { in_per_million: 3.00, out_per_million: 12.00, unit: 'USD_per_1M_tokens' };
    }
    if (modelId.includes('gpt-4o')) {
      return { in_per_million: 5.00, out_per_million: 15.00, unit: 'USD_per_1M_tokens' };
    }
    return { in_per_million: 1.00, out_per_million: 2.00, unit: 'USD_per_1M_tokens' }; // fallback
  }
}