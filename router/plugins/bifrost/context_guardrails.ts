/**
 * Context Guardrails for Overflow Handling - Milestone 3
 * 
 * Implements context overflow detection and automatic bucket escalation
 * to ensure requests don't fail due to context limits. Provides fallback
 * routing when requests exceed model context capacities.
 * 
 * Based on TODO.md decision flow:
 * ```
 * if context_exceeds(cheap_models):        # guardrail
 *     bucket ← hard
 * else if context_exceeds(mid_models):
 *     bucket ← hard  
 * ```
 */

import { ModelInfo, Bucket, RequestFeatures, AvengersArtifact } from '../../../src/types/common.js';

export interface ContextLimits {
  input: number;
  output: number;
  total: number;
}

export interface ContextGuardrailConfig {
  // Safety margins (percentage of max context to reserve)
  safetyMarginPercent: number;
  
  // Emergency escalation thresholds
  emergencyEscalationThreshold: number;
  
  // Model context limits (updated from catalog)
  modelLimits: Record<string, ContextLimits>;
  
  // Bucket context limits for guardrail decisions
  bucketLimits: {
    cheap: ContextLimits;
    mid: ContextLimits;
    hard: ContextLimits;
  };
}

export const DEFAULT_CONTEXT_CONFIG: ContextGuardrailConfig = {
  safetyMarginPercent: 10, // Reserve 10% for safety
  emergencyEscalationThreshold: 0.95, // 95% of context limit
  
  // Model-specific limits (updated from catalog service)
  modelLimits: {
    'deepseek/deepseek-r1': { input: 163840, output: 8192, total: 172032 },
    'qwen/qwen3-coder': { input: 32768, output: 8192, total: 40960 },
    'openai/gpt-5': { input: 128000, output: 16384, total: 144384 },
    'google/gemini-2.5-pro': { input: 1048576, output: 8192, total: 1056768 },
    'anthropic/claude-3.5-sonnet': { input: 200000, output: 8192, total: 208192 }
  },
  
  // Bucket-level limits (worst case for each bucket)
  bucketLimits: {
    cheap: { input: 32768, output: 8192, total: 40960 }, // Limited by Qwen3
    mid: { input: 128000, output: 8192, total: 144384 }, // Limited by GPT-5 (when no Claude OAuth)
    hard: { input: 1048576, output: 8192, total: 1056768 } // Gemini 2.5 Pro max
  }
};

export class ContextGuardrails {
  private config: ContextGuardrailConfig;
  private stats = {
    totalChecks: 0,
    escalations: 0,
    emergencyEscalations: 0,
    bucketOverrides: {
      cheapToMid: 0,
      cheapToHard: 0,
      midToHard: 0
    }
  };
  
  constructor(config: ContextGuardrailConfig = DEFAULT_CONTEXT_CONFIG) {
    this.config = config;
  }
  
  /**
   * Check if request context exceeds bucket limits and escalate if necessary
   */
  checkContextOverflow(
    originalBucket: Bucket,
    features: RequestFeatures,
    availableModels: string[]
  ): {
    finalBucket: Bucket;
    escalated: boolean;
    reason?: string;
    recommendedModel?: string;
  } {
    this.stats.totalChecks++;
    
    const inputTokens = features.token_count || 0;
    const estimatedOutputTokens = this.estimateOutputTokens(features);
    const totalTokens = inputTokens + estimatedOutputTokens;
    
    console.log(`Context check: ${inputTokens} input + ${estimatedOutputTokens} output = ${totalTokens} total tokens`);
    
    // Check against bucket limits with safety margins
    const bucketLimit = this.config.bucketLimits[originalBucket];
    const safeInputLimit = bucketLimit.input * (1 - this.config.safetyMarginPercent / 100);
    const safeTotalLimit = bucketLimit.total * (1 - this.config.safetyMarginPercent / 100);
    
    // If request fits in original bucket, no escalation needed
    if (inputTokens <= safeInputLimit && totalTokens <= safeTotalLimit) {
      return {
        finalBucket: originalBucket,
        escalated: false
      };
    }
    
    // Context overflow detected - escalate bucket
    console.warn(`Context overflow detected: ${inputTokens}/${bucketLimit.input} input tokens, ${totalTokens}/${bucketLimit.total} total`);
    
    const escalationResult = this.escalateBucket(
      originalBucket,
      inputTokens,
      totalTokens,
      availableModels
    );
    
    // Update statistics
    this.stats.escalations++;
    if (originalBucket === 'cheap' && escalationResult.finalBucket === 'mid') {
      this.stats.bucketOverrides.cheapToMid++;
    } else if (originalBucket === 'cheap' && escalationResult.finalBucket === 'hard') {
      this.stats.bucketOverrides.cheapToHard++;
    } else if (originalBucket === 'mid' && escalationResult.finalBucket === 'hard') {
      this.stats.bucketOverrides.midToHard++;
    }
    
    return escalationResult;
  }
  
  /**
   * Escalate bucket to handle context overflow
   */
  private escalateBucket(
    originalBucket: Bucket,
    inputTokens: number,
    totalTokens: number,
    availableModels: string[]
  ): {
    finalBucket: Bucket;
    escalated: boolean;
    reason: string;
    recommendedModel?: string;
  } {
    // Try escalating one level first
    const nextBucket = this.getNextBucket(originalBucket);
    
    if (nextBucket && this.canBucketHandle(nextBucket, inputTokens, totalTokens)) {
      return {
        finalBucket: nextBucket,
        escalated: true,
        reason: `Context overflow: escalated from ${originalBucket} to ${nextBucket}`,
        recommendedModel: this.getRecommendedModelForContext(nextBucket, inputTokens, availableModels)
      };
    }
    
    // If mid bucket can't handle it, go straight to hard
    if (this.canBucketHandle('hard', inputTokens, totalTokens)) {
      return {
        finalBucket: 'hard',
        escalated: true,
        reason: `Context overflow: escalated from ${originalBucket} to hard (skipping mid)`,
        recommendedModel: this.getRecommendedModelForContext('hard', inputTokens, availableModels)
      };
    }
    
    // Emergency escalation - even hard bucket might struggle
    this.stats.emergencyEscalations++;
    console.error(`Emergency context escalation: ${inputTokens} input tokens exceeds all bucket limits`);
    
    return {
      finalBucket: 'hard',
      escalated: true,
      reason: `Emergency escalation: ${inputTokens} input tokens requires maximum context model`,
      recommendedModel: this.getHighestContextModel(availableModels)
    };
  }
  
  /**
   * Check if bucket can handle the token count
   */
  private canBucketHandle(bucket: Bucket, inputTokens: number, totalTokens: number): boolean {
    const bucketLimit = this.config.bucketLimits[bucket];
    const safeInputLimit = bucketLimit.input * (1 - this.config.safetyMarginPercent / 100);
    const safeTotalLimit = bucketLimit.total * (1 - this.config.safetyMarginPercent / 100);
    
    return inputTokens <= safeInputLimit && totalTokens <= safeTotalLimit;
  }
  
  /**
   * Get next bucket in escalation chain
   */
  private getNextBucket(currentBucket: Bucket): Bucket | null {
    switch (currentBucket) {
      case 'cheap':
        return 'mid';
      case 'mid':
        return 'hard';
      case 'hard':
        return null; // Already at highest bucket
      default:
        return null;
    }
  }
  
  /**
   * Estimate output tokens based on request features
   */
  private estimateOutputTokens(features: RequestFeatures): number {
    // Base estimate
    let estimatedOutput = 2048;
    
    // Adjust based on input length
    const inputTokens = features.token_count || 0;
    
    if (inputTokens > 50000) {
      // Very long input likely needs substantial output
      estimatedOutput = 8192;
    } else if (inputTokens > 20000) {
      // Long input needs more output
      estimatedOutput = 4096;
    } else if (inputTokens < 1000) {
      // Short input likely needs short output
      estimatedOutput = 1024;
    }
    
    // Adjust based on task type
    if (features.has_code) {
      // Code tasks often need longer outputs
      estimatedOutput = Math.max(estimatedOutput, 4096);
    }
    
    if (features.has_math) {
      // Math tasks might need detailed explanations
      estimatedOutput = Math.max(estimatedOutput, 3072);
    }
    
    return estimatedOutput;
  }
  
  /**
   * Get recommended model for context requirements within bucket
   */
  private getRecommendedModelForContext(
    bucket: Bucket,
    inputTokens: number,
    availableModels: string[]
  ): string | undefined {
    // Filter models by bucket
    const bucketModels = this.getModelsForBucket(bucket, availableModels);
    
    // Find models that can handle the context
    const suitableModels = bucketModels.filter(model => {
      const limits = this.config.modelLimits[model];
      return limits && inputTokens <= limits.input * (1 - this.config.safetyMarginPercent / 100);
    });
    
    if (suitableModels.length === 0) {
      return undefined;
    }
    
    // For very long context (>200k), prefer Gemini
    if (inputTokens > 200000) {
      const geminiModel = suitableModels.find(model => model.includes('gemini'));
      if (geminiModel) {
        return geminiModel;
      }
    }
    
    // Otherwise, return the first suitable model (they're pre-sorted by preference)
    return suitableModels[0];
  }
  
  /**
   * Get highest context model from available models
   */
  private getHighestContextModel(availableModels: string[]): string | undefined {
    let highestContextModel: string | undefined;
    let maxContext = 0;
    
    for (const model of availableModels) {
      const limits = this.config.modelLimits[model];
      if (limits && limits.input > maxContext) {
        maxContext = limits.input;
        highestContextModel = model;
      }
    }
    
    return highestContextModel;
  }
  
  /**
   * Get models available for a specific bucket
   */
  private getModelsForBucket(bucket: Bucket, availableModels: string[]): string[] {
    // This is a simplified mapping - in production, this would come from configuration
    switch (bucket) {
      case 'cheap':
        return availableModels.filter(model => 
          model.includes('deepseek') || model.includes('qwen')
        );
      case 'mid':
        return availableModels.filter(model =>
          model.includes('claude') || model.includes('gpt') || model.includes('gemini')
        );
      case 'hard':
        return availableModels.filter(model =>
          model.includes('gpt-5') || model.includes('gemini-2.5')
        );
      default:
        return availableModels;
    }
  }
  
  /**
   * Update model context limits from catalog service
   */
  updateModelLimits(modelLimits: Record<string, ContextLimits>): void {
    this.config.modelLimits = { ...this.config.modelLimits, ...modelLimits };
    
    // Update bucket limits based on worst case for each bucket
    this.updateBucketLimits();
  }
  
  /**
   * Update bucket limits based on available models
   */
  private updateBucketLimits(): void {
    const cheapModels = ['deepseek/deepseek-r1', 'qwen/qwen3-coder'];
    const midModels = ['openai/gpt-5', 'google/gemini-2.5-pro', 'anthropic/claude-3.5-sonnet'];
    const hardModels = ['openai/gpt-5', 'google/gemini-2.5-pro'];
    
    // Find minimum limits for each bucket (worst case)
    this.config.bucketLimits.cheap = this.getMinLimitsForModels(cheapModels);
    this.config.bucketLimits.mid = this.getMinLimitsForModels(midModels);
    this.config.bucketLimits.hard = this.getMaxLimitsForModels(hardModels); // Use max for hard bucket
  }
  
  /**
   * Get minimum context limits across a set of models
   */
  private getMinLimitsForModels(models: string[]): ContextLimits {
    let minLimits: ContextLimits = {
      input: Infinity,
      output: Infinity,
      total: Infinity
    };
    
    for (const model of models) {
      const limits = this.config.modelLimits[model];
      if (limits) {
        minLimits.input = Math.min(minLimits.input, limits.input);
        minLimits.output = Math.min(minLimits.output, limits.output);
        minLimits.total = Math.min(minLimits.total, limits.total);
      }
    }
    
    return minLimits;
  }
  
  /**
   * Get maximum context limits across a set of models
   */
  private getMaxLimitsForModels(models: string[]): ContextLimits {
    let maxLimits: ContextLimits = {
      input: 0,
      output: 0,
      total: 0
    };
    
    for (const model of models) {
      const limits = this.config.modelLimits[model];
      if (limits) {
        maxLimits.input = Math.max(maxLimits.input, limits.input);
        maxLimits.output = Math.max(maxLimits.output, limits.output);
        maxLimits.total = Math.max(maxLimits.total, limits.total);
      }
    }
    
    return maxLimits;
  }
  
  /**
   * Check if a specific model can handle the context
   */
  canModelHandleContext(
    model: string,
    inputTokens: number,
    outputTokens?: number
  ): { canHandle: boolean; utilization: number; reason?: string } {
    const limits = this.config.modelLimits[model];
    
    if (!limits) {
      return {
        canHandle: false,
        utilization: 0,
        reason: `Unknown model: ${model}`
      };
    }
    
    const safeInputLimit = limits.input * (1 - this.config.safetyMarginPercent / 100);
    const estimatedOutput = outputTokens || this.estimateOutputTokens({ token_count: inputTokens } as RequestFeatures);
    const totalTokens = inputTokens + estimatedOutput;
    const safeTotalLimit = limits.total * (1 - this.config.safetyMarginPercent / 100);
    
    const inputUtilization = inputTokens / limits.input;
    const totalUtilization = totalTokens / limits.total;
    const maxUtilization = Math.max(inputUtilization, totalUtilization);
    
    if (inputTokens > safeInputLimit) {
      return {
        canHandle: false,
        utilization: maxUtilization,
        reason: `Input tokens (${inputTokens}) exceed safe limit (${Math.floor(safeInputLimit)})`
      };
    }
    
    if (totalTokens > safeTotalLimit) {
      return {
        canHandle: false,
        utilization: maxUtilization,
        reason: `Total tokens (${totalTokens}) exceed safe limit (${Math.floor(safeTotalLimit)})`
      };
    }
    
    return {
      canHandle: true,
      utilization: maxUtilization
    };
  }
  
  /**
   * Get context guardrail statistics
   */
  getStats(): {
    totalChecks: number;
    escalations: number;
    emergencyEscalations: number;
    escalationRate: number;
    bucketOverrides: {
      cheapToMid: number;
      cheapToHard: number;
      midToHard: number;
    };
  } {
    return {
      ...this.stats,
      escalationRate: this.stats.totalChecks > 0 ? this.stats.escalations / this.stats.totalChecks : 0
    };
  }
  
  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      totalChecks: 0,
      escalations: 0,
      emergencyEscalations: 0,
      bucketOverrides: {
        cheapToMid: 0,
        cheapToHard: 0,
        midToHard: 0
      }
    };
  }
  
  /**
   * Update guardrail configuration
   */
  updateConfig(newConfig: Partial<ContextGuardrailConfig>): void {
    this.config = {
      ...this.config,
      ...newConfig
    };
  }
  
  /**
   * Get current configuration
   */
  getConfig(): ContextGuardrailConfig {
    return { ...this.config };
  }
}