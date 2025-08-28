/**
 * Thinking Parameter Mappers for GPT-5 and Gemini
 * 
 * Maps bucket decisions to appropriate thinking/reasoning parameters:
 * - GPT-5: reasoning_effort (low/medium/high)  
 * - Gemini: thinkingBudget (4K-8K mid, 16K-32K hard)
 * 
 * Based on TODO.md specifications and provider documentation.
 */

import { Bucket, RouterDecision } from '../../../src/types/common.js';

export interface ThinkingParameters {
  reasoning_effort?: 'low' | 'medium' | 'high';
  thinkingBudget?: number;
}

export interface ThinkingConfig {
  gpt5: {
    low: 'low';
    medium: 'medium'; 
    high: 'high';
  };
  gemini: {
    mid: {
      min: number;
      max: number;
      default: number;
    };
    hard: {
      min: number;
      max: number;
      default: number;
    };
  };
}

/**
 * Default thinking configuration based on TODO.md specifications
 */
export const DEFAULT_THINKING_CONFIG: ThinkingConfig = {
  gpt5: {
    low: 'low',
    medium: 'medium',
    high: 'high'
  },
  gemini: {
    mid: {
      min: 4000,
      max: 8000,
      default: 6000
    },
    hard: {
      min: 16000,
      max: 32000,
      default: 20000
    }
  }
};

export class ThinkingParameterMapper {
  private config: ThinkingConfig;
  
  constructor(config: ThinkingConfig = DEFAULT_THINKING_CONFIG) {
    this.config = config;
  }
  
  /**
   * Map bucket to GPT-5 reasoning_effort parameter
   */
  mapGPT5ReasoningEffort(bucket: Bucket, contextLength?: number): 'low' | 'medium' | 'high' {
    switch (bucket) {
      case 'cheap':
        // Cheap bucket shouldn't typically use GPT-5, but if it does, use low effort
        return this.config.gpt5.low;
        
      case 'mid':
        // Mid bucket uses medium reasoning effort
        return this.config.gpt5.medium;
        
      case 'hard':
        // Hard bucket uses high reasoning effort
        // Consider context length for extremely long requests
        if (contextLength && contextLength > 100000) {
          // Very long context might benefit from high reasoning
          return this.config.gpt5.high;
        }
        return this.config.gpt5.high;
        
      default:
        return this.config.gpt5.medium;
    }
  }
  
  /**
   * Map bucket to Gemini thinkingBudget parameter
   */
  mapGeminiThinkingBudget(
    bucket: Bucket, 
    contextLength?: number,
    taskComplexity?: 'low' | 'medium' | 'high'
  ): number {
    switch (bucket) {
      case 'cheap':
        // Cheap bucket shouldn't typically use Gemini thinking, but provide minimal budget
        return 1000;
        
      case 'mid':
        // Mid bucket: 4K-8K range, default 6K
        let midBudget = this.config.gemini.mid.default;
        
        // Adjust based on task complexity
        if (taskComplexity === 'high') {
          midBudget = this.config.gemini.mid.max;
        } else if (taskComplexity === 'low') {
          midBudget = this.config.gemini.mid.min;
        }
        
        // Slight adjustment for context length
        if (contextLength && contextLength > 50000) {
          midBudget = Math.min(midBudget + 1000, this.config.gemini.mid.max);
        }
        
        return midBudget;
        
      case 'hard':
        // Hard bucket: 16K-32K range, default 20K
        let hardBudget = this.config.gemini.hard.default;
        
        // Adjust based on task complexity
        if (taskComplexity === 'high') {
          hardBudget = this.config.gemini.hard.max;
        } else if (taskComplexity === 'low') {
          hardBudget = this.config.gemini.hard.min;
        }
        
        // Increase budget for very long context (Gemini's strength)
        if (contextLength && contextLength > 200000) {
          // Very long context gets maximum thinking budget
          hardBudget = this.config.gemini.hard.max;
        } else if (contextLength && contextLength > 100000) {
          hardBudget = Math.min(hardBudget + 5000, this.config.gemini.hard.max);
        }
        
        return hardBudget;
        
      default:
        return this.config.gemini.mid.default;
    }
  }
  
  /**
   * Apply thinking parameters to router decision based on model and bucket
   */
  applyThinkingParameters(
    decision: RouterDecision,
    bucket: Bucket,
    contextLength?: number,
    taskComplexity?: 'low' | 'medium' | 'high'
  ): RouterDecision {
    const updatedDecision = { ...decision };
    
    // Apply parameters based on the target model
    if (decision.kind === 'openai' && decision.model.includes('gpt-5')) {
      // GPT-5 reasoning effort
      updatedDecision.params.reasoning_effort = this.mapGPT5ReasoningEffort(bucket, contextLength);
      
    } else if (decision.kind === 'google' && decision.model.includes('gemini')) {
      // Gemini thinking budget
      updatedDecision.params.thinkingBudget = this.mapGeminiThinkingBudget(
        bucket, 
        contextLength, 
        taskComplexity
      );
      
      // For very long context, prefer Gemini due to 1M token limit
      if (contextLength && contextLength > 200000) {
        // This bias is handled in the router logic, but we can note it here
        console.log(`Long context (${contextLength} tokens) - Gemini thinking budget: ${updatedDecision.params.thinkingBudget}`);
      }
    }
    
    return updatedDecision;
  }
  
  /**
   * Determine task complexity from features for thinking parameter adjustment
   */
  assessTaskComplexity(features: {
    has_code?: boolean;
    has_math?: boolean;
    ngram_entropy?: number;
    token_count?: number;
  }): 'low' | 'medium' | 'high' {
    let complexityScore = 0;
    
    // Code tasks add complexity
    if (features.has_code) {
      complexityScore += 1;
    }
    
    // Math tasks add significant complexity
    if (features.has_math) {
      complexityScore += 2;
    }
    
    // High entropy text suggests complex language
    if (features.ngram_entropy && features.ngram_entropy > 6.0) {
      complexityScore += 1;
    } else if (features.ngram_entropy && features.ngram_entropy < 3.0) {
      // Low entropy suggests simple, repetitive text
      complexityScore -= 1;
    }
    
    // Very long context adds complexity
    if (features.token_count && features.token_count > 50000) {
      complexityScore += 1;
    }
    
    // Convert score to complexity level
    if (complexityScore >= 3) {
      return 'high';
    } else if (complexityScore >= 1) {
      return 'medium';
    } else {
      return 'low';
    }
  }
  
  /**
   * Get thinking parameter recommendations for debugging/monitoring
   */
  getThinkingParameterInfo(
    bucket: Bucket,
    modelType: 'gpt5' | 'gemini',
    contextLength?: number,
    taskComplexity?: 'low' | 'medium' | 'high'
  ): {
    bucket: Bucket;
    modelType: string;
    recommendedParams: ThinkingParameters;
    reasoning: string;
  } {
    const reasoning_effort = this.mapGPT5ReasoningEffort(bucket, contextLength);
    const thinkingBudget = this.mapGeminiThinkingBudget(bucket, contextLength, taskComplexity);
    
    let reasoning = `Bucket: ${bucket}`;
    
    if (contextLength) {
      reasoning += `, Context: ${contextLength} tokens`;
    }
    
    if (taskComplexity) {
      reasoning += `, Complexity: ${taskComplexity}`;
    }
    
    const recommendedParams: ThinkingParameters = {};
    
    if (modelType === 'gpt5') {
      recommendedParams.reasoning_effort = reasoning_effort;
      reasoning += ` → GPT-5 reasoning_effort: ${reasoning_effort}`;
    } else if (modelType === 'gemini') {
      recommendedParams.thinkingBudget = thinkingBudget;
      reasoning += ` → Gemini thinkingBudget: ${thinkingBudget}`;
    }
    
    return {
      bucket,
      modelType,
      recommendedParams,
      reasoning
    };
  }
  
  /**
   * Validate thinking parameters against model limits
   */
  validateThinkingParameters(
    modelType: 'gpt5' | 'gemini',
    params: ThinkingParameters
  ): { valid: boolean; adjustedParams?: ThinkingParameters; warnings?: string[] } {
    const warnings: string[] = [];
    const adjustedParams: ThinkingParameters = { ...params };
    
    if (modelType === 'gpt5') {
      // GPT-5 reasoning effort validation
      const validEfforts = ['low', 'medium', 'high'];
      if (params.reasoning_effort && !validEfforts.includes(params.reasoning_effort)) {
        warnings.push(`Invalid reasoning_effort: ${params.reasoning_effort}. Using 'medium' instead.`);
        adjustedParams.reasoning_effort = 'medium';
      }
      
    } else if (modelType === 'gemini') {
      // Gemini thinking budget validation
      if (params.thinkingBudget !== undefined) {
        const minBudget = 128; // Minimum from Vertex AI docs
        const maxBudget = 32768; // Maximum from Vertex AI docs
        
        if (params.thinkingBudget < minBudget) {
          warnings.push(`thinkingBudget ${params.thinkingBudget} below minimum ${minBudget}. Adjusting to minimum.`);
          adjustedParams.thinkingBudget = minBudget;
        } else if (params.thinkingBudget > maxBudget) {
          warnings.push(`thinkingBudget ${params.thinkingBudget} above maximum ${maxBudget}. Adjusting to maximum.`);
          adjustedParams.thinkingBudget = maxBudget;
        }
      }
    }
    
    return {
      valid: warnings.length === 0,
      adjustedParams: warnings.length > 0 ? adjustedParams : undefined,
      warnings: warnings.length > 0 ? warnings : undefined
    };
  }
  
  /**
   * Update thinking configuration (for runtime tuning)
   */
  updateConfig(newConfig: Partial<ThinkingConfig>): void {
    this.config = {
      ...this.config,
      ...newConfig
    };
  }
  
  /**
   * Get current thinking configuration
   */
  getConfig(): ThinkingConfig {
    return { ...this.config };
  }
}