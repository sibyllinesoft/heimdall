/**
 * Bifrost Router PreHook
 * Main routing logic with GBDT triage and Avengers-Pro α-score selection
 */

import { RouterConfig, RouterDecision, RequestFeatures, BucketProbabilities, Bucket, AuthInfo, AvengersArtifact } from '../../../src/types/common.js';
import { AuthAdapterRegistry } from './adapters/auth_adapter.js';
import { AnthropicOAuthAdapter } from './adapters/anthropic_oauth.js';
import { GeminiOAuthAdapter } from './adapters/gemini_oauth.js';
import { OpenAIKeyAdapter } from './adapters/openai_key.js';
import { FeatureExtractor } from './triage/features.js';
import { GBDTRuntime } from './triage/gbdt_runtime.js';
import { AlphaScorer } from './scoring/alpha_score.js';
import { CatalogClient } from './catalog_client.js';
import { ArtifactLoader } from './artifact_loader.js';
import { RouterExecutor, ExecutionRequest, ExecutionResult } from './router_executor.js';
import { ProviderConfig } from './providers/provider_registry.js';
import { ThinkingParameterMapper } from './thinking_mappers.js';
import { ProviderInference } from '../../../src/utils/provider-inference.js';
import { ModelParameterBuilder } from '../../../src/utils/model-parameters.js';

export interface PreHookRequest {
  url: string;
  method: string;
  headers: Record<string, string | string[]>;
  body?: {
    messages?: Array<{ role: string; content: string }>;
    model?: string;
    stream?: boolean;
    [key: string]: unknown;
  };
}

export interface PreHookResponse {
  decision: RouterDecision;
  features: RequestFeatures;
  bucket: Bucket;
  bucket_probabilities: BucketProbabilities;
  auth_info: AuthInfo | null;
  fallback_reason?: string;
}

export interface ExecuteRequest extends PreHookRequest {
  // Execution phase includes the decision from PreHook
  decision: RouterDecision;
  features: RequestFeatures;
  auth_info: AuthInfo | null;
}

export interface ExecuteResponse {
  success: boolean;
  response?: any;
  error?: any;
  provider_used: string;
  fallback_used?: boolean;
  fallback_reason?: string;
  execution_time_ms: number;
}

/**
 * Main router PreHook implementation
 */
export class RouterPreHook {
  private authRegistry: AuthAdapterRegistry;
  private featureExtractor: FeatureExtractor;
  private gbdtRuntime: GBDTRuntime;
  private alphaScorer: AlphaScorer;
  private catalogClient: CatalogClient;
  private artifactLoader: ArtifactLoader;
  private executor: RouterExecutor;
  private thinkingMapper: ThinkingParameterMapper;
  
  private currentArtifact: AvengersArtifact | null = null;
  private lastArtifactLoad = 0;
  
  constructor(
    private config: RouterConfig,
    catalogBaseUrl: string,
    providerConfig?: ProviderConfig
  ) {
    // Initialize components
    this.authRegistry = new AuthAdapterRegistry();
    this.catalogClient = new CatalogClient(catalogBaseUrl);
    this.featureExtractor = new FeatureExtractor();
    this.gbdtRuntime = new GBDTRuntime();
    this.alphaScorer = new AlphaScorer();
    this.artifactLoader = new ArtifactLoader(config.tuning.artifact_url);
    this.thinkingMapper = new ThinkingParameterMapper();
    
    // Initialize executor with provider configuration
    const defaultProviderConfig: ProviderConfig = {
      openai: { enabled: true },
      google: { 
        enabled: true,
        oauth: {
          client_id: process.env.GOOGLE_CLIENT_ID || '',
          client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
          redirect_uri: process.env.GOOGLE_REDIRECT_URI || ''
        }
      },
      anthropic: { enabled: true }
    };
    
    this.executor = new RouterExecutor(
      providerConfig || defaultProviderConfig,
      this.thinkingMapper
    );
    
    // Register auth adapters
    this.setupAuthAdapters();
  }
  
  /**
   * Main routing decision logic
   * Follows the algorithm specified in TODO.md
   */
  async decide(request: PreHookRequest): Promise<PreHookResponse> {
    try {
      // Step 1: Ensure we have current artifacts
      await this.ensureCurrentArtifact();
      
      if (!this.currentArtifact) {
        throw new Error('No routing artifact available');
      }
      
      // Step 2: Auth detection
      const authAdapter = this.authRegistry.findMatch(request.headers);
      const authInfo = authAdapter?.extract(request.headers) || null;
      
      // Step 3: Feature extraction (≤25ms budget)
      const features = await this.featureExtractor.extract(request, this.currentArtifact);
      
      // Step 4: GBDT triage
      const bucketProbs = await this.gbdtRuntime.predict(features, this.currentArtifact);
      
      // Step 5: Bucket selection with guardrails
      const bucket = this.selectBucket(bucketProbs, features);
      
      // Step 6: In-bucket α-score selection
      const decision = await this.selectModel(bucket, features, authInfo);
      
      return {
        decision,
        features,
        bucket,
        bucket_probabilities: bucketProbs,
        auth_info: authInfo
      };
      
    } catch (error) {
      console.error('Router decision failed:', error);
      // Fallback to safe default
      return this.getFallbackDecision(request, error as Error);
    }
  }
  
  /**
   * Execute the routing decision with direct provider calls
   * This is the main execution phase after decision is made
   */
  async execute(request: ExecuteRequest): Promise<ExecuteResponse> {
    try {
      if (!request.decision || !request.features) {
        throw new Error('Invalid execute request: missing decision or features');
      }
      
      // Build execution request for provider
      const executionRequest: ExecutionRequest = {
        decision: request.decision,
        originalRequest: {
          messages: request.body?.messages || [],
          stream: request.body?.stream,
          max_tokens: request.body?.max_tokens as number,
          temperature: request.body?.temperature as number
        },
        authInfo: request.auth_info,
        features: request.features
      };
      
      // Execute with fallback handling
      const result = await this.executor.execute(executionRequest);
      
      return {
        success: result.success,
        response: result.response,
        error: result.error,
        provider_used: result.provider_used,
        fallback_used: result.fallback_used,
        fallback_reason: result.fallback_reason,
        execution_time_ms: result.execution_time_ms
      };
      
    } catch (error) {
      console.error('Router execution failed:', error);
      return {
        success: false,
        error: {
          message: error instanceof Error ? error.message : 'Unknown execution error',
          type: 'execution_error'
        },
        provider_used: request.decision?.kind || 'unknown',
        execution_time_ms: 0
      };
    }
  }
  
  /**
   * Combined decide and execute flow for single-call usage
   */
  async decideAndExecute(request: PreHookRequest): Promise<ExecuteResponse> {
    try {
      // First make routing decision
      const decision = await this.decide(request);
      
      if (decision.fallback_reason) {
        console.log(`Decision made with fallback: ${decision.fallback_reason}`);
      }
      
      // Then execute the decision
      const executeRequest: ExecuteRequest = {
        ...request,
        decision: decision.decision,
        features: decision.features,
        auth_info: decision.auth_info
      };
      
      return await this.execute(executeRequest);
      
    } catch (error) {
      console.error('Combined decide and execute failed:', error);
      return {
        success: false,
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          type: 'router_error'
        },
        provider_used: 'unknown',
        execution_time_ms: 0
      };
    }
  }
  
  /**
   * Handle 429 fallback logic
   * Immediately reroute to best non-Anthropic candidate
   */
  async handle429Fallback(
    originalDecision: RouterDecision,
    request: PreHookRequest
  ): Promise<PreHookResponse> {
    console.log('Handling 429 fallback from Anthropic');
    
    try {
      await this.ensureCurrentArtifact();
      
      if (!this.currentArtifact) {
        throw new Error('No routing artifact available for fallback');
      }
      
      const features = await this.featureExtractor.extract(request, this.currentArtifact);
      const bucketProbs = await this.gbdtRuntime.predict(features, this.currentArtifact);
      const bucket = this.selectBucket(bucketProbs, features);
      
      // Force non-Anthropic selection
      const decision = await this.selectModel(bucket, features, null, true); // excludeAnthropic = true
      
      return {
        decision,
        features,
        bucket,
        bucket_probabilities: bucketProbs,
        auth_info: null,
        fallback_reason: 'anthropic_429'
      };
    } catch (error) {
      console.error('429 fallback failed:', error);
      return this.getFallbackDecision(request, error as Error, 'fallback_failed');
    }
  }
  
  private setupAuthAdapters(): void {
    const adapters = {
      'anthropic-oauth': new AnthropicOAuthAdapter(),
      'google-oauth': new GeminiOAuthAdapter(),
      'openai-key': new OpenAIKeyAdapter()
    };
    
    // Register enabled adapters
    for (const adapterId of this.config.auth_adapters.enabled) {
      const adapter = adapters[adapterId as keyof typeof adapters];
      if (adapter) {
        this.authRegistry.register(adapter);
      }
    }
  }
  
  private async ensureCurrentArtifact(): Promise<void> {
    const now = Date.now();
    const reloadIntervalMs = this.config.tuning.reload_seconds * 1000;
    
    if (!this.currentArtifact || (now - this.lastArtifactLoad) > reloadIntervalMs) {
      try {
        console.log('Loading/refreshing routing artifact...');
        this.currentArtifact = await this.artifactLoader.load();
        this.lastArtifactLoad = now;
        console.log(`Loaded artifact version: ${this.currentArtifact.version}`);
      } catch (error) {
        console.error('Failed to load artifact:', error);
        if (!this.currentArtifact) {
          // No artifact at all - use emergency fallback
          throw new Error('No routing artifact available and failed to load');
        }
      }
    }
  }
  
  private selectBucket(probs: BucketProbabilities, features: RequestFeatures): Bucket {
    const { thresholds } = this.config.router;
    
    // Guardrails for context overflow
    if (this.contextExceedsCapacity(features, 'cheap')) {
      if (this.contextExceedsCapacity(features, 'mid')) {
        return 'hard';
      }
      return 'mid';
    }
    
    // Threshold-based bucket selection
    if (probs.hard > thresholds.hard) {
      return 'hard';
    }
    
    if (probs.cheap > thresholds.cheap) {
      return 'cheap';
    }
    
    return 'mid';
  }
  
  private contextExceedsCapacity(features: RequestFeatures, bucket: Bucket): boolean {
    // Rough context capacity estimates
    const capacities = {
      cheap: 16000,   // DeepSeek R1, Qwen3-Coder
      mid: 128000,    // GPT-5 medium, Gemini medium
      hard: 1048576   // Gemini 2.5 Pro with high thinking
    };
    
    return features.token_count > capacities[bucket] * 0.8; // 80% threshold
  }
  
  private async selectModel(
    bucket: Bucket,
    features: RequestFeatures,
    authInfo: AuthInfo | null,
    excludeAnthropic = false
  ): Promise<RouterDecision> {
    if (!this.currentArtifact) {
      throw new Error('No artifact available for model selection');
    }
    
    switch (bucket) {
      case 'cheap':
        return this.selectCheapModel(features);
        
      case 'mid':
        if (!excludeAnthropic && authInfo?.provider === 'anthropic') {
          return this.selectAnthropicModel();
        }
        return this.selectMidModel(features);
        
      case 'hard':
        return this.selectHardModel(features);
        
      default:
        throw new Error(`Unknown bucket: ${bucket}`);
    }
  }
  
  private async selectCheapModel(features: RequestFeatures): Promise<RouterDecision> {
    return this.selectModelForBucket('cheap', features);
  }
  
  private selectAnthropicModel(): RouterDecision {
    return {
      kind: 'anthropic',
      model: 'claude-3-5-sonnet-20241022', // Default Claude model
      params: {},
      provider_prefs: { sort: 'latency', max_price: 100, allow_fallbacks: false },
      auth: { mode: 'oauth' },
      fallbacks: []
    };
  }
  
  private async selectMidModel(features: RequestFeatures): Promise<RouterDecision> {
    return this.selectModelForBucket('mid', features);
  }
  
  private async selectHardModel(features: RequestFeatures): Promise<RouterDecision> {
    return this.selectModelForBucket('hard', features);
  }

  /**
   * Consolidated model selection logic for any bucket type.
   * Eliminates code duplication between selectCheapModel, selectMidModel, and selectHardModel.
   */
  private async selectModelForBucket(
    bucketType: 'cheap' | 'mid' | 'hard',
    features: RequestFeatures,
    candidates?: string[]
  ): Promise<RouterDecision> {
    if (!this.currentArtifact) {
      throw new Error(`No artifact for ${bucketType} model selection`);
    }

    // Get candidates from config if not provided
    const modelCandidates = candidates || this.config.router[`${bucketType}_candidates`];
    
    // Apply special logic for hard models with long context
    let finalCandidates = modelCandidates;
    if (bucketType === 'hard' && features.token_count > 200000) {
      // For very long context, bias towards Gemini
      const geminiModels = modelCandidates.filter(c => c.includes('gemini'));
      const otherModels = modelCandidates.filter(c => !c.includes('gemini'));
      finalCandidates = [...geminiModels, ...otherModels]; // Gemini first
    }

    // Use α-score to pick best model
    const bestModel = await this.alphaScorer.selectBest(
      finalCandidates,
      features,
      this.currentArtifact
    );

    // Build model-specific parameters
    const params = bucketType === 'cheap' 
      ? {} 
      : ModelParameterBuilder.buildParams(
          bestModel, 
          bucketType as 'mid' | 'hard', 
          this.config.router.bucket_defaults
        );

    // Infer provider kind from model name
    const providerKind = ProviderInference.inferKind(bestModel);

    // Get provider preferences
    const providerPrefs = this.getProviderPreferencesForBucket(bucketType);

    return {
      kind: providerKind,
      model: bestModel,
      params,
      provider_prefs: providerPrefs,
      auth: { mode: 'env' },
      fallbacks: finalCandidates.filter(c => c !== bestModel)
    };
  }

  /**
   * Get provider preferences based on bucket type.
   */
  private getProviderPreferencesForBucket(bucketType: 'cheap' | 'mid' | 'hard') {
    switch (bucketType) {
      case 'cheap':
        return this.config.router.openrouter.provider;
      case 'mid':
        return { sort: 'quality', max_price: 50, allow_fallbacks: true };
      case 'hard':
        return { sort: 'quality', max_price: 100, allow_fallbacks: true };
      default:
        return { sort: 'quality', max_price: 50, allow_fallbacks: true };
    }
  }
  
  private getFallbackDecision(
    request: PreHookRequest,
    error: Error,
    reason = 'error'
  ): PreHookResponse {
    console.error(`Falling back to safe default due to ${reason}:`, error);
    
    // Emergency fallback to cheapest reliable option
    const decision: RouterDecision = {
      kind: 'openrouter',
      model: 'qwen/qwen3-coder', // Reliable cheap option
      params: {},
      provider_prefs: this.config.router.openrouter.provider,
      auth: { mode: 'env' },
      fallbacks: ['deepseek/deepseek-r1']
    };
    
    // Basic features for fallback
    const features: RequestFeatures = {
      embedding: [],
      cluster_id: 0,
      top_p_distances: [],
      token_count: this.estimateTokens(request),
      has_code: false,
      has_math: false,
      ngram_entropy: 0,
      context_ratio: 0
    };
    
    return {
      decision,
      features,
      bucket: 'cheap',
      bucket_probabilities: { cheap: 1.0, mid: 0.0, hard: 0.0 },
      auth_info: null,
      fallback_reason: reason
    };
  }
  
  private estimateTokens(request: PreHookRequest): number {
    const messages = request.body?.messages || [];
    // Rough token estimation: ~4 chars per token
    const totalChars = messages.reduce((sum, msg) => sum + (msg.content?.length || 0), 0);
    return Math.ceil(totalChars / 4);
  }
  
  /**
   * Get provider registry for direct access
   */
  getProviderRegistry() {
    return this.executor.getProviderRegistry();
  }
  
  /**
   * Health check all providers
   */
  async healthCheck() {
    return this.executor.healthCheck();
  }
  
  /**
   * Get thinking parameter mapper for configuration
   */
  getThinkingMapper() {
    return this.thinkingMapper;
  }
  
  /**
   * Get current artifact version for monitoring
   */
  getCurrentArtifactVersion(): string | null {
    return this.currentArtifact?.version || null;
  }
}