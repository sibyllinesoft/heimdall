/**
 * Common types for Bifrost Router
 */

export interface ModelCapabilities {
  ctx_in_max: number;
  ctx_out_max: number;
  supports_json: boolean;
  tools: boolean;
  thinking: {
    type: 'effort' | 'budget';
    ranges: {
      low?: string | number;
      medium?: string | number;
      high?: string | number;
      max?: number;
    };
  } | null;
}

export interface ModelPricing {
  in_per_million: number;
  out_per_million: number;
  unit: string;
}

export interface ModelInfo {
  slug: string;
  provider: 'openrouter' | 'openai' | 'google' | 'anthropic';
  family: string;
  ctx_in: number;
  params: {
    thinking: boolean;
    json: boolean;
    tools?: boolean;
  };
  pricing: ModelPricing;
  capabilities?: ModelCapabilities;
}

export interface RouterDecision {
  kind: 'anthropic' | 'openai' | 'google' | 'openrouter';
  model: string;
  params: {
    reasoning_effort?: 'low' | 'medium' | 'high';
    thinkingBudget?: number;
    max_output_tokens?: number;
    [key: string]: unknown;
  };
  provider_prefs: {
    sort: string;
    max_price: number;
    allow_fallbacks: boolean;
  };
  auth: {
    mode: 'oauth' | 'env' | 'userkey';
    token_ref?: string;
  };
  fallbacks: string[];
}

export interface RequestFeatures {
  embedding: number[];
  cluster_id: number;
  top_p_distances: number[];
  token_count: number;
  has_code: boolean;
  has_math: boolean;
  ngram_entropy: number;
  context_ratio: number;
  user_success_rate?: number;
  avg_latency?: number;
}

export interface BucketProbabilities {
  cheap: number;
  mid: number;
  hard: number;
}

export type Bucket = 'cheap' | 'mid' | 'hard';

export interface AvengersArtifact {
  version: string;
  centroids: string; // path to faiss index
  alpha: number;
  thresholds: {
    cheap: number;
    hard: number;
  };
  penalties: {
    latency_sd: number;
    ctx_over_80pct: number;
  };
  qhat: Record<string, number[]>; // model -> cluster quality scores
  chat: Record<string, number>; // model -> normalized cost
  gbdt: {
    framework: string;
    model_path: string;
    feature_schema: Record<string, unknown>;
  };
}

export interface AuthInfo {
  provider: string;
  type: 'bearer' | 'apikey';
  token: string;
}

export interface RouterConfig {
  router: {
    alpha: number;
    thresholds: {
      cheap: number;
      hard: number;
    };
    top_p: number;
    penalties: {
      latency_sd: number;
      ctx_over_80pct: number;
    };
    bucket_defaults: {
      mid: {
        gpt5_reasoning_effort: string;
        gemini_thinking_budget: number;
      };
      hard: {
        gpt5_reasoning_effort: string;
        gemini_thinking_budget: number;
      };
    };
    cheap_candidates: string[];
    mid_candidates: string[];
    hard_candidates: string[];
    openrouter: {
      exclude_authors: string[];
      provider: {
        sort: string;
        max_price: number;
        allow_fallbacks: boolean;
      };
    };
  };
  auth_adapters: {
    enabled: string[];
  };
  catalog: {
    base_url: string;
    refresh_seconds: number;
  };
  tuning: {
    artifact_url: string;
    reload_seconds: number;
  };
}