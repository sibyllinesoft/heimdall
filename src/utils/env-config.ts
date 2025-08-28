/**
 * Environment Variable Configuration Utilities
 * 
 * This module provides utilities for processing environment variables into 
 * structured configuration objects with type safety and flexible transformation.
 */

/**
 * Defines a mapping between an environment variable and a configuration object path
 */
export interface EnvMapping {
  /** The name of the environment variable to read from */
  envVar: string;
  /** The nested path in the configuration object where the value should be set */
  configPath: string[];
  /** Optional transformation function to process the environment variable value */
  transform?: (value: string) => any;
}

/**
 * Sets a nested value in an object, creating intermediate objects as needed
 * 
 * @param obj - The target object to modify
 * @param path - Array of keys representing the nested path
 * @param value - The value to set at the specified path
 * @returns The modified object
 * 
 * @example
 * ```typescript
 * const config = {};
 * setNestedValue(config, ['router', 'alpha'], 0.5);
 * // Result: { router: { alpha: 0.5 } }
 * ```
 */
export function setNestedValue(obj: any, path: string[], value: any): any {
  if (path.length === 0) {
    return value;
  }

  // Ensure the object exists
  if (obj === null || obj === undefined) {
    obj = {};
  }

  let current = obj;
  
  // Navigate to the parent of the target property
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    
    // Create intermediate objects if they don't exist
    if (current[key] === null || current[key] === undefined || typeof current[key] !== 'object') {
      current[key] = {};
    }
    
    current = current[key];
  }
  
  // Set the final value
  const finalKey = path[path.length - 1];
  current[finalKey] = value;
  
  return obj;
}

/**
 * Processes an array of environment variable mappings into a configuration object
 * 
 * @param mappings - Array of EnvMapping objects defining how to process environment variables
 * @returns A configuration object with values set from environment variables
 * 
 * @example
 * ```typescript
 * const mappings: EnvMapping[] = [
 *   { envVar: 'PORT', configPath: ['server', 'port'], transform: Number },
 *   { envVar: 'DEBUG', configPath: ['debug'], transform: (v) => v === 'true' }
 * ];
 * const config = processEnvMappings(mappings);
 * // Result: { server: { port: 3000 }, debug: true }
 * ```
 */
export function processEnvMappings(mappings: EnvMapping[]): any {
  const config: any = {};
  
  for (const mapping of mappings) {
    const envValue = process.env[mapping.envVar];
    
    // Skip if environment variable is not set
    if (envValue === undefined) {
      continue;
    }
    
    // Apply transformation if provided, otherwise use raw string value
    const processedValue = mapping.transform ? mapping.transform(envValue) : envValue;
    
    // Set the value in the configuration object
    setNestedValue(config, mapping.configPath, processedValue);
  }
  
  return config;
}

/**
 * Common transformation functions for environment variable processing
 */
export const transforms = {
  /** Convert string to number */
  number: (value: string): number => Number(value),
  
  /** Convert string to integer */
  int: (value: string): number => parseInt(value, 10),
  
  /** Convert string to float */
  float: (value: string): number => parseFloat(value),
  
  /** Convert string to boolean (true for 'true', '1', 'yes', 'on', case-insensitive) */
  boolean: (value: string): boolean => {
    const normalized = value.toLowerCase().trim();
    return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
  },
  
  /** Split comma-separated string into array */
  csvArray: (value: string): string[] => value.split(',').map(item => item.trim()).filter(Boolean),
  
  /** Parse JSON string */
  json: (value: string): any => JSON.parse(value),
  
  /** Convert to URL object */
  url: (value: string): URL => new URL(value),
  
  /** Convert milliseconds to seconds */
  msToSeconds: (value: string): number => Number(value) / 1000,
  
  /** Convert seconds to milliseconds */
  secondsToMs: (value: string): number => Number(value) * 1000,
};

/**
 * Pre-defined environment variable mappings for common configuration patterns
 */
export const commonMappings: Record<string, EnvMapping[]> = {
  /**
   * Standard server configuration mappings
   */
  server: [
    { envVar: 'PORT', configPath: ['server', 'port'], transform: transforms.int },
    { envVar: 'HOST', configPath: ['server', 'host'] },
    { envVar: 'NODE_ENV', configPath: ['server', 'environment'] },
    { envVar: 'SERVER_TIMEOUT', configPath: ['server', 'timeout'], transform: transforms.int },
    { envVar: 'MAX_CONNECTIONS', configPath: ['server', 'maxConnections'], transform: transforms.int },
  ],

  /**
   * Database configuration mappings
   */
  database: [
    { envVar: 'DB_HOST', configPath: ['database', 'host'] },
    { envVar: 'DB_PORT', configPath: ['database', 'port'], transform: transforms.int },
    { envVar: 'DB_NAME', configPath: ['database', 'name'] },
    { envVar: 'DB_USER', configPath: ['database', 'user'] },
    { envVar: 'DB_PASSWORD', configPath: ['database', 'password'] },
    { envVar: 'DB_SSL', configPath: ['database', 'ssl'], transform: transforms.boolean },
    { envVar: 'DB_POOL_SIZE', configPath: ['database', 'pool', 'size'], transform: transforms.int },
    { envVar: 'DB_TIMEOUT', configPath: ['database', 'timeout'], transform: transforms.int },
  ],

  /**
   * Redis/Cache configuration mappings
   */
  redis: [
    { envVar: 'REDIS_URL', configPath: ['redis', 'url'] },
    { envVar: 'REDIS_HOST', configPath: ['redis', 'host'] },
    { envVar: 'REDIS_PORT', configPath: ['redis', 'port'], transform: transforms.int },
    { envVar: 'REDIS_DB', configPath: ['redis', 'database'], transform: transforms.int },
    { envVar: 'REDIS_PASSWORD', configPath: ['redis', 'password'] },
    { envVar: 'REDIS_TTL', configPath: ['redis', 'ttl'], transform: transforms.int },
  ],

  /**
   * Logging configuration mappings
   */
  logging: [
    { envVar: 'LOG_LEVEL', configPath: ['logging', 'level'] },
    { envVar: 'LOG_FORMAT', configPath: ['logging', 'format'] },
    { envVar: 'LOG_FILE', configPath: ['logging', 'file'] },
    { envVar: 'LOG_MAX_SIZE', configPath: ['logging', 'maxSize'] },
    { envVar: 'LOG_MAX_FILES', configPath: ['logging', 'maxFiles'], transform: transforms.int },
    { envVar: 'LOG_COLORIZE', configPath: ['logging', 'colorize'], transform: transforms.boolean },
  ],

  /**
   * Authentication/Security configuration mappings
   */
  auth: [
    { envVar: 'JWT_SECRET', configPath: ['auth', 'jwt', 'secret'] },
    { envVar: 'JWT_EXPIRES_IN', configPath: ['auth', 'jwt', 'expiresIn'] },
    { envVar: 'BCRYPT_ROUNDS', configPath: ['auth', 'bcrypt', 'rounds'], transform: transforms.int },
    { envVar: 'SESSION_SECRET', configPath: ['auth', 'session', 'secret'] },
    { envVar: 'SESSION_MAX_AGE', configPath: ['auth', 'session', 'maxAge'], transform: transforms.int },
    { envVar: 'CORS_ORIGINS', configPath: ['auth', 'cors', 'origins'], transform: transforms.csvArray },
  ],

  /**
   * API/External services configuration mappings
   */
  api: [
    { envVar: 'API_BASE_URL', configPath: ['api', 'baseUrl'] },
    { envVar: 'API_KEY', configPath: ['api', 'key'] },
    { envVar: 'API_TIMEOUT', configPath: ['api', 'timeout'], transform: transforms.int },
    { envVar: 'API_RETRY_ATTEMPTS', configPath: ['api', 'retries', 'attempts'], transform: transforms.int },
    { envVar: 'API_RETRY_DELAY', configPath: ['api', 'retries', 'delay'], transform: transforms.int },
    { envVar: 'RATE_LIMIT_MAX', configPath: ['api', 'rateLimit', 'max'], transform: transforms.int },
    { envVar: 'RATE_LIMIT_WINDOW', configPath: ['api', 'rateLimit', 'windowMs'], transform: transforms.int },
  ],

  /**
   * Monitoring/Observability configuration mappings
   */
  monitoring: [
    { envVar: 'METRICS_ENABLED', configPath: ['monitoring', 'metrics', 'enabled'], transform: transforms.boolean },
    { envVar: 'METRICS_PORT', configPath: ['monitoring', 'metrics', 'port'], transform: transforms.int },
    { envVar: 'HEALTH_CHECK_PATH', configPath: ['monitoring', 'healthCheck', 'path'] },
    { envVar: 'TRACING_ENABLED', configPath: ['monitoring', 'tracing', 'enabled'], transform: transforms.boolean },
    { envVar: 'TRACING_ENDPOINT', configPath: ['monitoring', 'tracing', 'endpoint'] },
  ],
};

/**
 * Convenience function to create a complete configuration object from common patterns
 * 
 * @param patterns - Array of pattern names from commonMappings to include
 * @param additionalMappings - Additional custom mappings to process
 * @returns Complete configuration object
 * 
 * @example
 * ```typescript
 * const config = createConfig(['server', 'database'], [
 *   { envVar: 'CUSTOM_SETTING', configPath: ['custom', 'setting'], transform: transforms.boolean }
 * ]);
 * ```
 */
export function createConfig(
  patterns: (keyof typeof commonMappings)[] = [],
  additionalMappings: EnvMapping[] = []
): any {
  // Collect all mappings from the specified patterns
  const allMappings: EnvMapping[] = [];
  
  for (const pattern of patterns) {
    if (commonMappings[pattern]) {
      allMappings.push(...commonMappings[pattern]);
    }
  }
  
  // Add any additional custom mappings
  allMappings.push(...additionalMappings);
  
  return processEnvMappings(allMappings);
}

/**
 * Type-safe configuration builder for specific configuration schemas
 * 
 * @example
 * ```typescript
 * interface MyConfig {
 *   server: { port: number; host: string };
 *   debug: boolean;
 * }
 * 
 * const builder = new ConfigBuilder<MyConfig>();
 * const config = builder
 *   .map('PORT', ['server', 'port'], transforms.int)
 *   .map('HOST', ['server', 'host'])
 *   .map('DEBUG', ['debug'], transforms.boolean)
 *   .build();
 * ```
 */
export class ConfigBuilder<T = any> {
  private mappings: EnvMapping[] = [];

  /**
   * Add a mapping for an environment variable
   * 
   * @param envVar - Environment variable name
   * @param configPath - Path in configuration object
   * @param transform - Optional transformation function
   * @returns This builder instance for chaining
   */
  map(envVar: string, configPath: string[], transform?: (value: string) => any): this {
    this.mappings.push({ envVar, configPath, transform });
    return this;
  }

  /**
   * Add multiple mappings from a common pattern
   * 
   * @param pattern - Name of common mapping pattern
   * @returns This builder instance for chaining
   */
  usePattern(pattern: keyof typeof commonMappings): this {
    if (commonMappings[pattern]) {
      this.mappings.push(...commonMappings[pattern]);
    }
    return this;
  }

  /**
   * Build the final configuration object
   * 
   * @returns Configuration object of type T
   */
  build(): T {
    return processEnvMappings(this.mappings) as T;
  }
}