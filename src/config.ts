/**
 * Configuration loader with validation
 */

import { RouterConfig } from './types/common.js';
import * as yaml from 'js-yaml';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ensureDirectories } from './utils/filesystem.js';
import { Logger } from './utils/logger.js';
import { processEnvMappings, EnvMapping, transforms } from './utils/env-config.js';

const DEFAULT_CONFIG_PATHS = [
  'config.yaml',
  'config.yml', 
  'router/config.example.yaml',
  path.join(process.cwd(), 'config.yaml'),
  path.join(process.cwd(), 'router', 'config.example.yaml')
];

/**
 * Load and validate configuration
 */
export async function loadConfig(configPath?: string): Promise<RouterConfig> {
  const pathsToTry = configPath ? [configPath] : DEFAULT_CONFIG_PATHS;
  
  for (const filePath of pathsToTry) {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const config = yaml.load(content) as RouterConfig;
      
      // Validate configuration
      validateConfig(config);
      
      console.log(`Loaded configuration from: ${filePath}`);
      return config;
    } catch (error) {
      if (configPath) {
        // If specific path was provided, throw error
        throw new Error(`Failed to load config from ${configPath}: ${error}`);
      }
      // Continue trying other paths
      continue;
    }
  }
  
  // If no config file found, return default configuration
  console.warn('No configuration file found, using defaults');
  return getDefaultConfig();
}

/**
 * Validate configuration structure
 */
export function validateConfig(config: unknown): asserts config is RouterConfig {
  if (!config || typeof config !== 'object') {
    throw new Error('Configuration must be an object');
  }
  
  const c = config as Record<string, unknown>;
  
  // Validate router section
  if (!c.router || typeof c.router !== 'object') {
    throw new Error('Missing required router configuration');
  }
  
  const router = c.router as Record<string, unknown>;
  
  if (typeof router.alpha !== 'number' || router.alpha < 0 || router.alpha > 1) {
    throw new Error('Alpha must be between 0 and 1');
  }
  
  // Validate auth_adapters section
  if (!c.auth_adapters || typeof c.auth_adapters !== 'object') {
    throw new Error('Missing required auth_adapters configuration');
  }
  
  // Validate catalog section
  if (!c.catalog || typeof c.catalog !== 'object') {
    throw new Error('Missing required catalog configuration');
  }
  
  const catalog = c.catalog as Record<string, unknown>;
  if (typeof catalog.base_url !== 'string') {
    throw new Error('catalog.base_url must be a string');
  }
  
  // Validate tuning section
  if (!c.tuning || typeof c.tuning !== 'object') {
    throw new Error('Missing or invalid tuning configuration');
  }
  
  const tuning = c.tuning as Record<string, unknown>;
  if (typeof tuning.artifact_url !== 'string') {
    throw new Error('tuning.artifact_url must be a string');
  }
}

/**
 * Get default configuration
 */
export function getDefaultConfig(): RouterConfig {
  return {
    router: {
      alpha: 0.60,
      thresholds: {
        cheap: 0.62,
        hard: 0.58
      },
      top_p: 3,
      penalties: {
        latency_sd: 0.05,
        ctx_over_80pct: 0.15
      },
      bucket_defaults: {
        mid: {
          gpt5_reasoning_effort: 'medium',
          gemini_thinking_budget: 6000
        },
        hard: {
          gpt5_reasoning_effort: 'high',
          gemini_thinking_budget: 20000
        }
      },
      cheap_candidates: ['deepseek/deepseek-r1', 'qwen/qwen3-coder'],
      mid_candidates: ['openai/gpt-5', 'google/gemini-2.5-pro'],
      hard_candidates: ['openai/gpt-5', 'google/gemini-2.5-pro'],
      openrouter: {
        exclude_authors: ['anthropic'],
        provider: {
          sort: 'latency',
          max_price: 0.006,
          allow_fallbacks: true
        }
      }
    },
    auth_adapters: {
      enabled: ['anthropic-oauth', 'google-oauth', 'openai-key']
    },
    catalog: {
      base_url: 'http://localhost:8080',
      refresh_seconds: 3600
    },
    tuning: {
      artifact_url: './artifacts/emergency.json',
      reload_seconds: 300
    }
  };
}

/**
 * Create emergency artifact file if it doesn't exist
 */
export async function ensureEmergencyArtifact(): Promise<void> {
  const artifactPath = './artifacts/emergency.json';
  
  try {
    await fs.access(artifactPath);
    // File exists, no need to create
    return;
  } catch {
    // File doesn't exist, create it
  }
  
  const emergencyArtifact = {
    version: new Date().toISOString(),
    centroids: '',
    alpha: 0.60,
    thresholds: {
      cheap: 0.62,
      hard: 0.58
    },
    penalties: {
      latency_sd: 0.05,
      ctx_over_80pct: 0.15
    },
    qhat: {
      'deepseek/deepseek-r1': [0.7, 0.6, 0.8],
      'qwen/qwen3-coder': [0.6, 0.7, 0.7],
      'openai/gpt-5': [0.9, 0.95, 0.9],
      'google/gemini-2.5-pro': [0.85, 0.9, 0.95]
    },
    chat: {
      'deepseek/deepseek-r1': 0.05,
      'qwen/qwen3-coder': 0.04,
      'openai/gpt-5': 0.75,
      'google/gemini-2.5-pro': 0.55
    },
    gbdt: {
      framework: 'emergency',
      model_path: '',
      feature_schema: {}
    }
  };
  
  try {
    // Ensure artifacts directory exists
    await ensureDirectories('./artifacts');
    
    // Write emergency artifact
    await fs.writeFile(artifactPath, JSON.stringify(emergencyArtifact, null, 2));
    Logger.info('Created emergency artifact', { path: artifactPath });
  } catch (error) {
    Logger.warn('Failed to create emergency artifact', { error, path: artifactPath });
  }
}

/**
 * Get environment-based config structure
 */
export function getEnvConfig(): Partial<RouterConfig> {
  const envMappings: EnvMapping[] = [
    { 
      envVar: 'ROUTER_ALPHA', 
      configPath: ['router', 'alpha'], 
      transform: transforms.number 
    },
    { 
      envVar: 'ROUTER_ARTIFACT_PATH', 
      configPath: ['router', 'artifact_path'] 
    },
    { 
      envVar: 'CATALOG_BASE_URL', 
      configPath: ['catalog', 'base_url'] 
    },
    { 
      envVar: 'CATALOG_REFRESH_SECONDS',
      configPath: ['catalog', 'refresh_seconds'],
      transform: transforms.number
    },
    { 
      envVar: 'AUTH_ADAPTERS_ENABLED', 
      configPath: ['auth_adapters', 'enabled'], 
      transform: transforms.csvArray 
    }
  ];

  return processEnvMappings(envMappings) as Partial<RouterConfig>;
}

/**
 * Legacy environment function for backward compatibility
 */
export function getEnvVars(): {
  openaiApiKey?: string;
  geminiApiKey?: string;
  openrouterApiKey?: string;
  catalogUrl?: string;
  artifactUrl?: string;
} {
  return {
    openaiApiKey: process.env.OPENAI_API_KEY,
    geminiApiKey: process.env.GEMINI_API_KEY,
    openrouterApiKey: process.env.OPENROUTER_API_KEY,
    catalogUrl: process.env.CATALOG_BASE_URL,
    artifactUrl: process.env.TUNING_ARTIFACT_URL
  };
}

/**
 * Override config with environment variables
 */
export function applyEnvOverrides(config: RouterConfig): RouterConfig {
  const envConfig = getEnvConfig();
  
  const overridden = { ...config };
  
  if (envConfig.router?.alpha !== undefined) {
    overridden.router.alpha = envConfig.router.alpha;
  }
  
  if (envConfig.catalog?.base_url) {
    overridden.catalog.base_url = envConfig.catalog.base_url;
  }
  
  if (envConfig.auth_adapters?.enabled) {
    overridden.auth_adapters.enabled = envConfig.auth_adapters.enabled;
  }
  
  return overridden;
}