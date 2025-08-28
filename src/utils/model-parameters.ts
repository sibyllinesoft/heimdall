/**
 * Model parameter builder utility for constructing model-specific parameters
 * based on model name and bucket type configuration.
 */

/**
 * Type definition for model bucket types
 */
export type ModelBucketType = 'mid' | 'hard';

/**
 * Utility class for building model-specific parameters based on model name and bucket configuration
 */
export class ModelParameterBuilder {
  /**
   * Build model-specific parameters based on the model name and bucket type
   * 
   * @param modelName - The name of the model (e.g., 'gpt-5', 'gemini-pro', etc.)
   * @param bucketType - The bucket type ('mid' or 'hard')
   * @param bucketDefaults - Default configuration values for the bucket type
   * @returns A record containing model-specific parameters
   * 
   * @example
   * ```typescript
   * const params = ModelParameterBuilder.buildParams(
   *   'gpt-5-preview',
   *   'hard',
   *   { reasoning_effort: 'high', thinkingBudget: 60000 }
   * );
   * // Returns: { reasoning_effort: 'high' }
   * ```
   */
  static buildParams(
    modelName: string,
    bucketType: ModelBucketType,
    bucketDefaults: Record<string, unknown>
  ): Record<string, unknown> {
    const params: Record<string, unknown> = {};

    // Handle GPT-5 models - set reasoning_effort parameter
    if (this.isGPT5Model(modelName)) {
      if (bucketDefaults.reasoning_effort !== undefined) {
        params.reasoning_effort = bucketDefaults.reasoning_effort;
      }
    }

    // Handle Gemini models - set thinkingBudget parameter
    if (this.isGeminiModel(modelName)) {
      if (bucketDefaults.thinkingBudget !== undefined) {
        params.thinkingBudget = bucketDefaults.thinkingBudget;
      }
    }

    // Handle Claude models - extensible pattern for future parameters
    if (this.isClaudeModel(modelName)) {
      // Claude models currently don't require special parameters
      // but this provides an extensible pattern for future additions
    }

    // Handle other model types - extensible pattern
    if (this.isOtherModel(modelName)) {
      // Additional model types can be handled here
      // Example: OpenAI GPT-4, Anthropic other models, etc.
    }

    return params;
  }

  /**
   * Check if the model is a GPT-5 variant
   * 
   * @param modelName - The model name to check
   * @returns True if the model is a GPT-5 variant
   */
  private static isGPT5Model(modelName: string): boolean {
    const gpt5Patterns = ['gpt-5', 'o1', 'o3'];
    return gpt5Patterns.some(pattern => 
      modelName.toLowerCase().includes(pattern.toLowerCase())
    );
  }

  /**
   * Check if the model is a Gemini variant
   * 
   * @param modelName - The model name to check
   * @returns True if the model is a Gemini variant
   */
  private static isGeminiModel(modelName: string): boolean {
    return modelName.toLowerCase().includes('gemini');
  }

  /**
   * Check if the model is a Claude variant
   * 
   * @param modelName - The model name to check
   * @returns True if the model is a Claude variant
   */
  private static isClaudeModel(modelName: string): boolean {
    return modelName.toLowerCase().includes('claude');
  }

  /**
   * Check if the model is another supported model type
   * 
   * @param modelName - The model name to check
   * @returns True if the model is another supported type
   */
  private static isOtherModel(modelName: string): boolean {
    // This method provides extensibility for future model types
    // Currently returns false, but can be extended as needed
    const otherPatterns = ['gpt-4', 'gpt-3.5'];
    return otherPatterns.some(pattern => 
      modelName.toLowerCase().includes(pattern.toLowerCase())
    );
  }

  /**
   * Get supported model parameter keys for a given model
   * 
   * @param modelName - The model name to check
   * @returns Array of supported parameter keys for the model
   * 
   * @example
   * ```typescript
   * const supportedParams = ModelParameterBuilder.getSupportedParams('gpt-5-preview');
   * // Returns: ['reasoning_effort']
   * ```
   */
  static getSupportedParams(modelName: string): string[] {
    const params: string[] = [];

    if (this.isGPT5Model(modelName)) {
      params.push('reasoning_effort');
    }

    if (this.isGeminiModel(modelName)) {
      params.push('thinkingBudget');
    }

    return params;
  }

  /**
   * Validate that the provided bucket defaults contain the necessary parameters
   * for the given model
   * 
   * @param modelName - The model name to validate against
   * @param bucketDefaults - The bucket defaults to validate
   * @returns True if all required parameters are present
   * 
   * @example
   * ```typescript
   * const isValid = ModelParameterBuilder.validateBucketDefaults(
   *   'gpt-5-preview',
   *   { reasoning_effort: 'high' }
   * );
   * // Returns: true
   * ```
   */
  static validateBucketDefaults(
    modelName: string,
    bucketDefaults: Record<string, unknown>
  ): boolean {
    const supportedParams = this.getSupportedParams(modelName);
    
    // For now, we don't require any parameters to be present
    // This method provides a hook for future validation requirements
    return true;
  }
}