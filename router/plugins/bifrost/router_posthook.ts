/**
 * Bifrost Router PostHook
 * Handles completion logging, metrics collection, and post-processing
 */

import { RouterDecision, RequestFeatures } from '../../../src/types/common.js';
import { ExecuteResponse } from './router_prehook.js';

export interface PostHookRequest {
  originalRequest: {
    url: string;
    method: string;
    headers: Record<string, string | string[]>;
    body?: any;
  };
  decision: RouterDecision;
  features: RequestFeatures;
  execution: ExecuteResponse;
  startTime: number;
  endTime: number;
}

export interface PostHookResponse {
  logged: boolean;
  metrics: {
    request_id: string;
    provider_used: string;
    bucket_inferred: string;
    execution_time_ms: number;
    tokens_used?: number;
    cost_estimate?: number;
    success: boolean;
    fallback_used: boolean;
    error_type?: string;
  };
}

export interface LogEntry {
  timestamp: string;
  request_id: string;
  provider: string;
  model: string;
  bucket: string;
  success: boolean;
  execution_time_ms: number;
  fallback_used: boolean;
  fallback_reason?: string;
  tokens?: {
    prompt: number;
    completion: number;
    total: number;
  };
  cost?: number;
  error?: {
    type: string;
    message: string;
    status?: number;
  };
  features: {
    token_count: number;
    has_code: boolean;
    has_math: boolean;
    context_ratio: number;
  };
  headers: {
    user_agent?: string;
    anthropic_version?: string;
    content_type?: string;
  };
}

/**
 * Router PostHook implementation
 */
export class RouterPostHook {
  private logs: LogEntry[] = [];
  private metrics = {
    total_requests: 0,
    successful_requests: 0,
    fallback_requests: 0,
    provider_counts: {} as Record<string, number>,
    bucket_counts: {} as Record<string, number>,
    average_latency: 0,
    error_counts: {} as Record<string, number>
  };
  
  constructor(
    private logToConsole = true,
    private logToFile = false,
    private logFilePath = './router_logs.jsonl',
    private maxLogEntries = 10000
  ) {}
  
  /**
   * Process completion and log results
   */
  async process(request: PostHookRequest): Promise<PostHookResponse> {
    const startTime = Date.now();
    
    try {
      // Generate request ID
      const requestId = this.generateRequestId();
      
      // Infer bucket from decision and features
      const bucket = this.inferBucket(request.decision, request.features);
      
      // Build log entry
      const logEntry = this.buildLogEntry(request, requestId, bucket);
      
      // Store log entry
      this.storeLogEntry(logEntry);
      
      // Update metrics
      this.updateMetrics(logEntry);
      
      // Log to console if enabled
      if (this.logToConsole) {
        this.logToConsoleOutput(logEntry);
      }
      
      // Log to file if enabled
      if (this.logToFile) {
        await this.logToFileOutput(logEntry);
      }
      
      // Build response metrics
      const metrics = {
        request_id: requestId,
        provider_used: request.execution.provider_used,
        bucket_inferred: bucket,
        execution_time_ms: request.execution.execution_time_ms,
        tokens_used: logEntry.tokens?.total,
        cost_estimate: logEntry.cost,
        success: request.execution.success,
        fallback_used: request.execution.fallback_used || false,
        error_type: logEntry.error?.type
      };
      
      return {
        logged: true,
        metrics
      };
      
    } catch (error) {
      console.error('PostHook processing failed:', error);
      return {
        logged: false,
        metrics: {
          request_id: 'error',
          provider_used: request.execution?.provider_used || 'unknown',
          bucket_inferred: 'unknown',
          execution_time_ms: Date.now() - startTime,
          success: false,
          fallback_used: false,
          error_type: 'posthook_error'
        }
      };
    }
  }
  
  private buildLogEntry(request: PostHookRequest, requestId: string, bucket: string): LogEntry {
    const { originalRequest, decision, features, execution } = request;
    
    // Extract tokens from response
    let tokens;
    if (execution.response?.usage) {
      tokens = {
        prompt: execution.response.usage.prompt_tokens || 0,
        completion: execution.response.usage.completion_tokens || 0,
        total: execution.response.usage.total_tokens || 0
      };
    }
    
    // Estimate cost
    const cost = this.estimateCost(decision.model, tokens);
    
    // Extract error info
    let error;
    if (execution.error) {
      error = {
        type: execution.error.type || 'unknown',
        message: execution.error.message || 'Unknown error',
        status: execution.error.status
      };
    }
    
    // Extract relevant headers
    const headers = {
      user_agent: this.getHeader(originalRequest.headers, 'user-agent'),
      anthropic_version: this.getHeader(originalRequest.headers, 'anthropic-version'),
      content_type: this.getHeader(originalRequest.headers, 'content-type')
    };
    
    return {
      timestamp: new Date().toISOString(),
      request_id: requestId,
      provider: execution.provider_used,
      model: decision.model,
      bucket,
      success: execution.success,
      execution_time_ms: execution.execution_time_ms,
      fallback_used: execution.fallback_used || false,
      fallback_reason: execution.fallback_reason,
      tokens,
      cost,
      error,
      features: {
        token_count: features.token_count,
        has_code: features.has_code,
        has_math: features.has_math,
        context_ratio: features.context_ratio
      },
      headers
    };
  }
  
  private storeLogEntry(entry: LogEntry): void {
    this.logs.push(entry);
    
    // Keep only recent entries to prevent memory bloat
    if (this.logs.length > this.maxLogEntries) {
      this.logs = this.logs.slice(-this.maxLogEntries);
    }
  }
  
  private updateMetrics(entry: LogEntry): void {
    this.metrics.total_requests++;
    
    if (entry.success) {
      this.metrics.successful_requests++;
    }
    
    if (entry.fallback_used) {
      this.metrics.fallback_requests++;
    }
    
    // Update provider counts
    this.metrics.provider_counts[entry.provider] = 
      (this.metrics.provider_counts[entry.provider] || 0) + 1;
    
    // Update bucket counts
    this.metrics.bucket_counts[entry.bucket] = 
      (this.metrics.bucket_counts[entry.bucket] || 0) + 1;
    
    // Update error counts
    if (entry.error) {
      this.metrics.error_counts[entry.error.type] = 
        (this.metrics.error_counts[entry.error.type] || 0) + 1;
    }
    
    // Update average latency (simple moving average)
    const prevAvg = this.metrics.average_latency;
    const count = this.metrics.total_requests;
    this.metrics.average_latency = 
      (prevAvg * (count - 1) + entry.execution_time_ms) / count;
  }
  
  private logToConsoleOutput(entry: LogEntry): void {
    const status = entry.success ? '✅' : '❌';
    const fallback = entry.fallback_used ? ' (fallback)' : '';
    const cost = entry.cost ? ` $${entry.cost.toFixed(4)}` : '';
    const tokens = entry.tokens ? ` ${entry.tokens.total}t` : '';
    
    console.log(
      `${status} ${entry.provider}/${entry.model}${fallback} ` +
      `${entry.execution_time_ms}ms${tokens}${cost} [${entry.bucket}]`
    );
    
    if (entry.error) {
      console.log(`   Error: ${entry.error.type} - ${entry.error.message}`);
    }
  }
  
  private async logToFileOutput(entry: LogEntry): Promise<void> {
    try {
      // Use require instead of dynamic import for compatibility
      const fs = require('fs/promises');
      const logLine = JSON.stringify(entry) + '\n';
      await fs.appendFile(this.logFilePath, logLine, 'utf8');
    } catch (error) {
      console.error('Failed to write to log file:', error);
    }
  }
  
  private inferBucket(decision: RouterDecision, features: RequestFeatures): string {
    // Heuristic to infer bucket from decision and features
    if (decision.kind === 'openrouter') {
      return 'cheap';
    }
    
    if (features.token_count > 100000 || 
        (features.has_code && features.has_math) ||
        decision.params.reasoning_effort === 'high' ||
        (decision.params.thinkingBudget && decision.params.thinkingBudget > 15000)) {
      return 'hard';
    }
    
    if (features.token_count > 10000 || 
        features.has_code || 
        features.has_math ||
        decision.params.reasoning_effort === 'medium' ||
        (decision.params.thinkingBudget && decision.params.thinkingBudget > 3000)) {
      return 'mid';
    }
    
    return 'cheap';
  }
  
  private estimateCost(model: string, tokens?: { prompt: number; completion: number; total: number }): number | undefined {
    if (!tokens) return undefined;
    
    // Cost estimation based on known model pricing (per million tokens)
    const pricing = {
      // OpenAI GPT-5 (estimated)
      'openai/gpt-5': { input: 30.0, output: 120.0 },
      
      // Gemini 2.5 Pro (Google AI for Developers pricing)
      'google/gemini-2.5-pro': { input: 1.25, output: 5.0 },
      
      // Claude (Anthropic pricing)
      'claude-3-5-sonnet-20241022': { input: 3.0, output: 15.0 },
      'claude-3-5-haiku-20241022': { input: 0.8, output: 4.0 },
      
      // DeepSeek R1 (OpenRouter)
      'deepseek/deepseek-r1': { input: 0.4, output: 2.0 },
      
      // Qwen3-Coder (OpenRouter)
      'qwen/qwen3-coder': { input: 0.35, output: 1.4 }
    };
    
    const modelPricing = pricing[model as keyof typeof pricing];
    if (!modelPricing) {
      // Generic estimate for unknown models
      return (tokens.prompt * 2.0 + tokens.completion * 10.0) / 1000000;
    }
    
    const inputCost = (tokens.prompt * modelPricing.input) / 1000000;
    const outputCost = (tokens.completion * modelPricing.output) / 1000000;
    
    return inputCost + outputCost;
  }
  
  private generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  private getHeader(headers: Record<string, string | string[]>, name: string): string | undefined {
    const value = headers[name] || headers[name.toLowerCase()];
    if (Array.isArray(value)) {
      return value[0];
    }
    return value;
  }
  
  /**
   * Get current metrics snapshot
   */
  getMetrics() {
    return { ...this.metrics };
  }
  
  /**
   * Get recent log entries
   */
  getRecentLogs(limit = 100): LogEntry[] {
    return this.logs.slice(-limit);
  }
  
  /**
   * Get success rate for time period
   */
  getSuccessRate(timeWindowMs = 3600000): number { // Default: 1 hour
    const cutoff = Date.now() - timeWindowMs;
    const recentLogs = this.logs.filter(log => 
      new Date(log.timestamp).getTime() > cutoff
    );
    
    if (recentLogs.length === 0) return 1.0;
    
    const successful = recentLogs.filter(log => log.success).length;
    return successful / recentLogs.length;
  }
  
  /**
   * Get provider performance stats
   */
  getProviderStats(): Record<string, {
    requests: number;
    success_rate: number;
    avg_latency: number;
    fallback_rate: number;
  }> {
    const stats: Record<string, {
      requests: number;
      success_rate: number;
      avg_latency: number;
      fallback_rate: number;
    }> = {};
    
    for (const log of this.logs) {
      if (!stats[log.provider]) {
        stats[log.provider] = {
          requests: 0,
          success_rate: 0,
          avg_latency: 0,
          fallback_rate: 0
        };
      }
      
      const stat = stats[log.provider];
      const prevRequests = stat.requests;
      
      stat.requests++;
      
      // Update success rate
      if (log.success) {
        stat.success_rate = (stat.success_rate * prevRequests + 1) / stat.requests;
      } else {
        stat.success_rate = (stat.success_rate * prevRequests) / stat.requests;
      }
      
      // Update average latency
      stat.avg_latency = 
        (stat.avg_latency * prevRequests + log.execution_time_ms) / stat.requests;
      
      // Update fallback rate
      if (log.fallback_used) {
        stat.fallback_rate = (stat.fallback_rate * prevRequests + 1) / stat.requests;
      } else {
        stat.fallback_rate = (stat.fallback_rate * prevRequests) / stat.requests;
      }
    }
    
    return stats;
  }
  
  /**
   * Clear logs and reset metrics
   */
  reset(): void {
    this.logs = [];
    this.metrics = {
      total_requests: 0,
      successful_requests: 0,
      fallback_requests: 0,
      provider_counts: {},
      bucket_counts: {},
      average_latency: 0,
      error_counts: {}
    };
  }
}