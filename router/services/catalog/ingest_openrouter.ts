/**
 * OpenRouter Ingestor
 * Fetches model information from OpenRouter API and normalizes it
 */

import { ModelInfo } from '../../../src/types/common.js';

interface OpenRouterModel {
  id: string;
  name: string;
  description: string;
  pricing: {
    prompt: string;
    completion: string;
  };
  context_length: number;
  architecture: {
    modality: string;
    tokenizer: string;
    instruct_type?: string;
  };
  top_provider: {
    context_length: number;
    max_completion_tokens: number;
  };
  per_request_limits?: {
    prompt_tokens: string;
    completion_tokens: string;
  };
}

export class OpenRouterIngestor {
  private readonly baseUrl = 'https://openrouter.ai/api/v1';
  private readonly excludeAuthors = ['anthropic']; // As specified in requirements
  
  async ingest(): Promise<ModelInfo[]> {
    try {
      console.log('Fetching models from OpenRouter API...');
      
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'Bifrost-Router/1.0',
        'HTTP-Referer': process.env.HTTP_REFERER || 'https://bifrost-router.com',
        'X-Title': process.env.X_TITLE || 'Bifrost Router'
      };
      
      // Add Authorization header if API key is available
      if (process.env.OPENROUTER_API_KEY) {
        headers['Authorization'] = `Bearer ${process.env.OPENROUTER_API_KEY}`;
      } else {
        console.warn('OPENROUTER_API_KEY not set - using free tier with rate limits');
      }
      
      const response = await fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers,
        // Add timeout for reliability
        signal: AbortSignal.timeout(30000) // 30 second timeout
      });
      
      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`OpenRouter API error: ${response.status} ${response.statusText} - ${errorText}`);
      }
      
      const data = await response.json() as { data: OpenRouterModel[] };
      
      if (!data.data || !Array.isArray(data.data)) {
        throw new Error('Invalid response format from OpenRouter API');
      }
      
      console.log(`Retrieved ${data.data.length} models from OpenRouter`);
      
      const filteredModels = data.data
        .filter(model => this.shouldIncludeModel(model))
        .map(model => this.normalizeModel(model))
        .filter((model): model is ModelInfo => model !== null);
      
      console.log(`Filtered to ${filteredModels.length} target models (excluded ${data.data.length - filteredModels.length} models)`);
      
      // Log excluded Anthropic models for verification
      const anthropicModels = data.data.filter(model => 
        model.id.toLowerCase().includes('anthropic') || 
        model.id.toLowerCase().includes('claude')
      );
      
      if (anthropicModels.length > 0) {
        console.log(`Successfully excluded ${anthropicModels.length} Anthropic models:`, 
          anthropicModels.map(m => m.id));
      }
      
      return filteredModels;
      
    } catch (error) {
      if (error instanceof Error) {
        console.error('Failed to ingest from OpenRouter:', error.message);
        
        // Check for common issues and provide helpful error messages
        if (error.message.includes('401')) {
          console.error('Authentication failed - check OPENROUTER_API_KEY');
        } else if (error.message.includes('429')) {
          console.error('Rate limited - consider upgrading OpenRouter plan or adding API key');
        } else if (error.message.includes('timeout')) {
          console.error('Request timeout - OpenRouter API may be slow');
        }
      } else {
        console.error('Failed to ingest from OpenRouter:', error);
      }
      
      // Return empty array instead of throwing to allow graceful degradation
      // The catalog service can still work with other providers
      return [];
    }
  }
  
  private shouldIncludeModel(model: OpenRouterModel): boolean {
    // Filter out excluded authors (e.g., anthropic) - comprehensive check
    const modelId = model.id.toLowerCase();
    const modelName = model.name?.toLowerCase() || '';
    
    // Check for Anthropic/Claude in multiple ways
    const anthropicPatterns = [
      'anthropic',
      'claude',
      'claude-',
      'claude_',
      '/claude',
      'claude/',
      'sonnet',
      'haiku',
      'opus'
    ];
    
    for (const pattern of anthropicPatterns) {
      if (modelId.includes(pattern) || modelName.includes(pattern)) {
        console.debug(`Excluding Anthropic model: ${model.id}`);
        return false;
      }
    }
    
    // Additional exclusion for any model from excluded authors
    for (const excludedAuthor of this.excludeAuthors) {
      if (modelId.includes(excludedAuthor) || modelName.includes(excludedAuthor)) {
        console.debug(`Excluding model from ${excludedAuthor}: ${model.id}`);
        return false;
      }
    }
    
    // Only include models we're interested in for cheap bucket
    const targetModels = [
      'deepseek/deepseek-r1',
      'deepseek/r1',
      'qwen/qwen3-coder',
      'qwen/qwen-3',
      'deepseek',
      'qwen',
      // Allow other cost-effective models that might be good for cheap bucket
      'mistral',
      'llama',
      'yi'
    ];
    
    const isTargetModel = targetModels.some(target => 
      modelId.includes(target) || modelName.includes(target)
    );
    
    if (!isTargetModel) {
      console.debug(`Model ${model.id} not in target list for cheap bucket`);
      return false;
    }
    
    // Additional quality filters
    if (model.context_length < 8000) {
      console.debug(`Model ${model.id} has insufficient context length: ${model.context_length}`);
      return false;
    }
    
    // Check if pricing is reasonable for cheap bucket
    try {
      const inputPrice = parseFloat(model.pricing?.prompt || '0');
      if (inputPrice > 0.001) { // More than $1 per million tokens
        console.debug(`Model ${model.id} too expensive for cheap bucket: $${inputPrice * 1000000}/1M`);
        return false;
      }
    } catch (error) {
      console.warn(`Could not parse pricing for ${model.id}:`, error);
    }
    
    return true;
  }
  
  private normalizeModel(model: OpenRouterModel): ModelInfo | null {
    try {
      // Parse pricing
      const inputPrice = parseFloat(model.pricing.prompt) * 1000000; // Convert to per million
      const outputPrice = parseFloat(model.pricing.completion) * 1000000;
      
      // Determine family from model ID
      const family = this.extractFamily(model.id);
      
      // Check if model supports thinking (based on model capabilities)
      const supportsThinking = this.checkThinkingSupport(model);
      
      return {
        slug: model.id,
        provider: 'openrouter',
        family,
        ctx_in: model.context_length || model.top_provider?.context_length || 4096,
        params: {
          thinking: supportsThinking,
          json: this.checkJsonSupport(model),
          tools: this.checkToolSupport(model)
        },
        pricing: {
          in_per_million: inputPrice,
          out_per_million: outputPrice,
          unit: 'USD_per_1M_tokens'
        },
        capabilities: {
          ctx_in_max: model.context_length || 4096,
          ctx_out_max: model.top_provider?.max_completion_tokens || 4096,
          supports_json: this.checkJsonSupport(model),
          tools: this.checkToolSupport(model),
          thinking: supportsThinking ? {
            type: 'budget',
            ranges: {
              low: 1000,
              medium: 4000,
              high: 8000,
              max: 16000
            }
          } : null
        }
      };
    } catch (error) {
      console.error(`Failed to normalize model ${model.id}:`, error);
      return null;
    }
  }
  
  private extractFamily(modelId: string): string {
    const parts = modelId.split('/');
    if (parts.length >= 2) {
      return parts[0]; // e.g., 'deepseek' from 'deepseek/deepseek-r1'
    }
    
    // Fallback: extract from model name
    if (modelId.includes('deepseek')) return 'deepseek';
    if (modelId.includes('qwen')) return 'qwen';
    
    return 'unknown';
  }
  
  private checkThinkingSupport(model: OpenRouterModel): boolean {
    // R1 models support reasoning/thinking
    return model.id.toLowerCase().includes('r1') || 
           model.name.toLowerCase().includes('reasoning');
  }
  
  private checkJsonSupport(model: OpenRouterModel): boolean {
    // Most modern models support JSON mode
    // This is a heuristic - in production you'd have more specific data
    return !model.id.includes('legacy') && 
           model.context_length > 2000;
  }
  
  private checkToolSupport(model: OpenRouterModel): boolean {
    // Tool support detection heuristic
    return model.architecture?.instruct_type !== null &&
           model.context_length > 4000;
  }
}