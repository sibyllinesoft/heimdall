/**
 * Provider inference and configuration utilities for model routing
 * 
 * This module provides utilities to infer AI model providers from model names
 * and generate appropriate configuration preferences for different use cases.
 */

/**
 * Supported AI model provider types
 */
export type ProviderKind = 'openai' | 'google' | 'anthropic' | 'openrouter';

/**
 * Provider preference configuration for routing decisions
 */
export interface ProviderPreferences {
  /** Sorting criteria for provider selection */
  sort: string[];
  /** Maximum price threshold for provider selection */
  max_price?: number;
  /** Whether to allow fallback to other providers */
  allow_fallbacks: boolean;
}

/**
 * Provider inference patterns for model name matching
 */
const PROVIDER_PATTERNS: Record<ProviderKind, RegExp> = {
  openai: /openai\//i,
  google: /gemini/i,
  anthropic: /claude/i,
  openrouter: /.*/  // Default catch-all pattern
};

/**
 * Default provider preferences by bucket type
 */
const DEFAULT_PREFERENCES: Record<string, ProviderPreferences> = {
  fast: {
    sort: ['response_time', 'price'],
    max_price: 0.01,
    allow_fallbacks: true
  },
  smart: {
    sort: ['quality', 'capabilities'],
    max_price: 0.05,
    allow_fallbacks: true
  },
  cheap: {
    sort: ['price', 'response_time'],
    max_price: 0.001,
    allow_fallbacks: true
  },
  premium: {
    sort: ['quality', 'capabilities', 'reliability'],
    allow_fallbacks: false
  }
};

/**
 * Utilities for inferring AI model providers and generating configuration preferences
 */
export class ProviderInference {
  /**
   * Infers the provider type from a model name using pattern matching
   * 
   * @param modelName - The model name to analyze (e.g., "openai/gpt-4", "gemini-pro", "claude-3-opus")
   * @returns The inferred provider kind, defaults to 'openrouter' if no pattern matches
   * 
   * @example
   * ```typescript
   * ProviderInference.inferKind('openai/gpt-4'); // returns 'openai'
   * ProviderInference.inferKind('gemini-pro'); // returns 'google'
   * ProviderInference.inferKind('claude-3-opus'); // returns 'anthropic'
   * ProviderInference.inferKind('llama-2-70b'); // returns 'openrouter'
   * ```
   */
  static inferKind(modelName: string): ProviderKind {
    // Test patterns in priority order (most specific first)
    const providers: ProviderKind[] = ['openai', 'google', 'anthropic'];
    
    for (const provider of providers) {
      if (PROVIDER_PATTERNS[provider].test(modelName)) {
        return provider;
      }
    }
    
    // Default to openrouter for unmatched models
    return 'openrouter';
  }

  /**
   * Generates provider preferences based on bucket type and optional price constraints
   * 
   * @param bucketType - The type of bucket determining preference priorities ('fast', 'smart', 'cheap', 'premium')
   * @param maxPrice - Optional maximum price override for provider selection
   * @returns Provider preferences configuration object
   * 
   * @example
   * ```typescript
   * // Get fast response preferences
   * const fastPrefs = ProviderInference.getProviderPreferences('fast');
   * // { sort: ['response_time', 'price'], max_price: 0.01, allow_fallbacks: true }
   * 
   * // Get smart preferences with custom price limit
   * const smartPrefs = ProviderInference.getProviderPreferences('smart', 0.02);
   * // { sort: ['quality', 'capabilities'], max_price: 0.02, allow_fallbacks: true }
   * ```
   */
  static getProviderPreferences(bucketType: string, maxPrice?: number): ProviderPreferences {
    const basePreferences = DEFAULT_PREFERENCES[bucketType.toLowerCase()];
    
    if (!basePreferences) {
      // Return default preferences for unknown bucket types
      return {
        sort: ['price', 'response_time'],
        max_price: maxPrice || 0.01,
        allow_fallbacks: true
      };
    }

    // Create a copy and apply price override if provided
    const preferences: ProviderPreferences = {
      ...basePreferences,
      sort: [...basePreferences.sort]
    };

    if (maxPrice !== undefined) {
      preferences.max_price = maxPrice;
    }

    return preferences;
  }

  /**
   * Gets all supported provider kinds
   * 
   * @returns Array of all supported provider types
   */
  static getSupportedProviders(): ProviderKind[] {
    return ['openai', 'google', 'anthropic', 'openrouter'];
  }

  /**
   * Validates if a string is a valid provider kind
   * 
   * @param provider - The provider string to validate
   * @returns True if the provider is supported, false otherwise
   */
  static isValidProvider(provider: string): provider is ProviderKind {
    return this.getSupportedProviders().includes(provider as ProviderKind);
  }

  /**
   * Gets available bucket types for provider preferences
   * 
   * @returns Array of supported bucket type strings
   */
  static getAvailableBucketTypes(): string[] {
    return Object.keys(DEFAULT_PREFERENCES);
  }
}