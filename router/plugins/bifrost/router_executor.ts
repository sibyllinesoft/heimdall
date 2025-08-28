/**
 * Router Executor - Direct Provider Integration
 * Handles actual API calls to providers and fallback logic
 */

import { RouterDecision, RequestFeatures, AuthInfo } from '../../../src/types/common.js';
import { ProviderRegistry, DefaultProviderRegistry, ProviderConfig } from './providers/provider_registry.js';
import { OpenAIClient } from './providers/openai_client.js';
import { GeminiClient } from './providers/gemini_client.js';
import { AnthropicClient } from './providers/anthropic_client.js';
import { AuthCredentials, ProviderRequest, ProviderResponse, ProviderError } from './providers/base_provider.js';
import { ThinkingParameterMapper } from './thinking_mappers.js';

export interface ExecutionRequest {
  decision: RouterDecision;
  originalRequest: {
    messages: Array<{ role: string; content: string }>;
    stream?: boolean;
    max_tokens?: number;
    temperature?: number;
  };
  authInfo: AuthInfo | null;
  features: RequestFeatures;
}

export interface ExecutionResult {
  success: boolean;
  response?: ProviderResponse;
  error?: ProviderError;
  provider_used: string;
  fallback_used?: boolean;
  fallback_reason?: string;
  execution_time_ms: number;
}

/**
 * Router Executor manages direct provider calls and fallback logic
 */
export class RouterExecutor {
  private providerRegistry: ProviderRegistry;
  private thinkingMapper: ThinkingParameterMapper;
  
  constructor(
    providerConfig: ProviderConfig,
    thinkingMapper?: ThinkingParameterMapper
  ) {
    this.providerRegistry = new DefaultProviderRegistry(providerConfig);
    this.thinkingMapper = thinkingMapper || new ThinkingParameterMapper();
  }
  
  /**
   * Execute router decision with fallback handling
   */
  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const startTime = Date.now();
    
    try {
      // Try primary provider first
      const result = await this.executeProvider(request);
      result.execution_time_ms = Date.now() - startTime;
      return result;
      
    } catch (error) {
      const providerError = this.handleError(error);
      
      // Check if we should attempt fallback
      if (this.shouldFallback(providerError, request.decision)) {
        console.log(`Primary provider failed, attempting fallback: ${providerError.error.message}`);
        
        try {
          const fallbackResult = await this.executeFallback(request, providerError);
          fallbackResult.execution_time_ms = Date.now() - startTime;
          return fallbackResult;
          
        } catch (fallbackError) {
          const finalError = this.handleError(fallbackError);
          return {
            success: false,
            error: finalError,
            provider_used: request.decision.kind,
            fallback_used: true,
            fallback_reason: 'fallback_failed',
            execution_time_ms: Date.now() - startTime
          };
        }
      }
      
      return {
        success: false,
        error: providerError,
        provider_used: request.decision.kind,
        execution_time_ms: Date.now() - startTime
      };
    }
  }
  
  /**
   * Execute against primary provider
   */
  private async executeProvider(request: ExecutionRequest): Promise<ExecutionResult> {
    const { decision, originalRequest, authInfo, features } = request;
    
    // Build provider request
    const providerRequest: ProviderRequest = {
      model: decision.model,
      messages: originalRequest.messages,
      stream: originalRequest.stream,
      max_tokens: originalRequest.max_tokens || decision.params.max_output_tokens,
      temperature: originalRequest.temperature,
      ...decision.params
    };
    
    // Apply thinking parameters
    this.applyThinkingParameters(providerRequest, decision, features);
    
    // Get credentials
    const credentials = this.buildCredentials(decision, authInfo);
    
    // Execute request
    const response = await this.providerRegistry.complete(
      decision.kind,
      providerRequest,
      credentials
    );
    
    return {
      success: true,
      response,
      provider_used: decision.kind,
      execution_time_ms: 0 // Will be set by caller
    };
  }
  
  /**
   * Execute fallback logic
   */
  private async executeFallback(
    originalRequest: ExecutionRequest,
    originalError: ProviderError
  ): Promise<ExecutionResult> {
    const fallbackDecision = await this.determineFallback(originalRequest, originalError);
    
    if (!fallbackDecision) {
      throw new Error('No fallback available');
    }
    
    const fallbackRequest: ExecutionRequest = {
      ...originalRequest,
      decision: fallbackDecision
    };
    
    const result = await this.executeProvider(fallbackRequest);
    result.fallback_used = true;
    result.fallback_reason = this.getFallbackReason(originalError);
    
    return result;
  }
  
  /**
   * Determine appropriate fallback based on error and original decision
   */
  private async determineFallback(
    request: ExecutionRequest,
    error: ProviderError
  ): Promise<RouterDecision | null> {
    const { decision, features } = request;
    
    // Handle Anthropic 429 specifically
    if (decision.kind === 'anthropic' && this.isRateLimitError(error)) {
      return this.selectNonAnthropicFallback(features, decision);
    }
    
    // Handle other provider errors
    if (decision.kind === 'openai' || decision.kind === 'google') {
      return this.selectCrossProviderFallback(decision, features);
    }
    
    // Use configured fallbacks if available
    if (decision.fallbacks && decision.fallbacks.length > 0) {
      return this.buildFallbackDecision(decision.fallbacks[0], decision);
    }
    
    return null;
  }
  
  /**
   * Select non-Anthropic fallback for 429 errors
   */
  private selectNonAnthropicFallback(
    features: RequestFeatures,
    originalDecision: RouterDecision
  ): RouterDecision {
    // Determine original bucket intent from context
    const isLongContext = features.token_count > 200000;
    const isComplex = features.has_code || features.has_math;
    
    if (isLongContext) {
      // Long context - prefer Gemini
      return {
        kind: 'google',
        model: 'google/gemini-2.5-pro',
        params: {
          thinkingBudget: 20000 // High thinking budget for fallback
        },
        provider_prefs: { sort: 'quality', max_price: 100, allow_fallbacks: true },
        auth: { mode: 'env' },
        fallbacks: ['openai/gpt-5']
      };
    } else if (isComplex) {
      // Complex task - prefer GPT-5
      return {
        kind: 'openai',
        model: 'openai/gpt-5',
        params: {
          reasoning_effort: 'high'
        },
        provider_prefs: { sort: 'quality', max_price: 100, allow_fallbacks: true },
        auth: { mode: 'env' },
        fallbacks: ['google/gemini-2.5-pro']
      };
    } else {
      // Default to cheaper option - OpenRouter
      return {
        kind: 'openrouter',
        model: 'qwen/qwen3-coder',
        params: {},
        provider_prefs: { sort: 'latency', max_price: 10, allow_fallbacks: true },
        auth: { mode: 'env' },
        fallbacks: ['deepseek/deepseek-r1']
      };
    }
  }
  
  /**
   * Cross-provider fallback for OpenAI/Gemini
   */
  private selectCrossProviderFallback(
    originalDecision: RouterDecision,
    features: RequestFeatures
  ): RouterDecision {
    if (originalDecision.kind === 'openai') {
      // OpenAI failed, try Gemini
      return {
        kind: 'google',
        model: 'google/gemini-2.5-pro',
        params: {
          thinkingBudget: this.thinkingMapper.mapGeminiThinkingBudget('hard', features.token_count)
        },
        provider_prefs: originalDecision.provider_prefs,
        auth: { mode: 'env' },
        fallbacks: []
      };
    } else if (originalDecision.kind === 'google') {
      // Gemini failed, try OpenAI
      return {
        kind: 'openai',
        model: 'openai/gpt-5',
        params: {
          reasoning_effort: 'high'
        },
        provider_prefs: originalDecision.provider_prefs,
        auth: { mode: 'env' },
        fallbacks: []
      };
    }
    
    // Fallback to cheap option
    return {
      kind: 'openrouter',
      model: 'qwen/qwen3-coder',
      params: {},
      provider_prefs: { sort: 'latency', max_price: 10, allow_fallbacks: true },
      auth: { mode: 'env' },
      fallbacks: []
    };
  }
  
  private buildFallbackDecision(fallbackModel: string, originalDecision: RouterDecision): RouterDecision {
    return {
      ...originalDecision,
      model: fallbackModel,
      fallbacks: originalDecision.fallbacks.slice(1) // Remove used fallback
    };
  }
  
  private applyThinkingParameters(
    providerRequest: ProviderRequest,
    decision: RouterDecision,
    features: RequestFeatures
  ): void {
    const taskComplexity = this.thinkingMapper.assessTaskComplexity(features);
    
    if (decision.kind === 'openai' && decision.model.includes('gpt-5')) {
      // Apply reasoning effort if not already set
      if (!providerRequest.reasoning_effort) {
        const bucket = this.inferBucket(features);
        providerRequest.reasoning_effort = this.thinkingMapper.mapGPT5ReasoningEffort(
          bucket,
          features.token_count
        );
      }
    } else if (decision.kind === 'google' && decision.model.includes('gemini')) {
      // Apply thinking budget if not already set
      if (!providerRequest.thinkingBudget) {
        const bucket = this.inferBucket(features);
        providerRequest.thinkingBudget = this.thinkingMapper.mapGeminiThinkingBudget(
          bucket,
          features.token_count,
          taskComplexity
        );
      }
    }
  }
  
  private inferBucket(features: RequestFeatures): 'cheap' | 'mid' | 'hard' {
    // Simple heuristic to infer bucket from features
    if (features.token_count > 100000 || (features.has_code && features.has_math)) {
      return 'hard';
    } else if (features.token_count > 10000 || features.has_code || features.has_math) {
      return 'mid';
    } else {
      return 'cheap';
    }
  }
  
  private buildCredentials(decision: RouterDecision, authInfo: AuthInfo | null): AuthCredentials {
    if (authInfo) {
      return {
        type: authInfo.type as 'bearer' | 'apikey',
        token: authInfo.token
      };
    }
    
    // Use environment credentials
    switch (decision.kind) {
      case 'openai':
        const openaiKey = process.env.OPENAI_API_KEY;
        if (!openaiKey) {
          throw new Error('OPENAI_API_KEY not found in environment');
        }
        return { type: 'apikey', token: openaiKey };
        
      case 'google':
        const geminiKey = process.env.GEMINI_API_KEY;
        if (!geminiKey) {
          throw new Error('GEMINI_API_KEY not found in environment');
        }
        return { type: 'apikey', token: geminiKey };
        
      case 'anthropic':
        throw new Error('Anthropic requires user OAuth token');
        
      default:
        throw new Error(`No credentials available for provider: ${decision.kind}`);
    }
  }
  
  private shouldFallback(error: ProviderError, decision: RouterDecision): boolean {
    // Don't fallback on auth errors (user needs to fix credentials)
    if (error.status === 401 || error.status === 403) {
      return false;
    }
    
    // Don't fallback on bad requests (request is malformed)
    if (error.status === 400) {
      return false;
    }
    
    // Always fallback on Anthropic 429
    if (decision.kind === 'anthropic' && this.isRateLimitError(error)) {
      return true;
    }
    
    // Fallback on server errors and rate limits for other providers
    return error.status === undefined || 
           error.status >= 500 || 
           this.isRateLimitError(error);
  }
  
  private isRateLimitError(error: ProviderError): boolean {
    return error.status === 429 || 
           error.error.type?.includes('rate_limit') ||
           error.error.message?.toLowerCase().includes('rate limit');
  }
  
  private getFallbackReason(error: ProviderError): string {
    if (this.isRateLimitError(error)) {
      return 'rate_limit';
    }
    if (error.status && error.status >= 500) {
      return 'server_error';
    }
    return 'provider_error';
  }
  
  private handleError(error: unknown): ProviderError {
    if (typeof error === 'object' && error !== null && 'error' in error) {
      return error as ProviderError;
    }
    
    if (error instanceof Error) {
      return {
        error: {
          message: error.message,
          type: 'client_error'
        }
      };
    }
    
    return {
      error: {
        message: 'Unknown execution error',
        type: 'unknown_error'
      }
    };
  }
  
  /**
   * Get provider registry for advanced operations
   */
  getProviderRegistry(): ProviderRegistry {
    return this.providerRegistry;
  }
  
  /**
   * Health check all providers
   */
  async healthCheck(): Promise<Record<string, { status: 'healthy' | 'unhealthy'; error?: string }>> {
    if (this.providerRegistry instanceof DefaultProviderRegistry) {
      return this.providerRegistry.healthCheck();
    }
    return {};
  }
}