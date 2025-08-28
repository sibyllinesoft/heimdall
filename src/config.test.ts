import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import * as yaml from 'js-yaml'
import {
  loadConfig,
  getDefaultConfig,
  validateConfig,
  ensureEmergencyArtifact,
  applyEnvOverrides,
  getEnvConfig
} from './config.js'
import type { RouterConfig } from './types/common.js'

// Mock file system operations
vi.mock('fs', () => ({
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    access: vi.fn(),
    mkdir: vi.fn()
  }
}))

// Mock yaml parsing
vi.mock('js-yaml')

describe('Config Module', () => {
  const mockFs = vi.mocked(fs)
  const mockYaml = vi.mocked(yaml)
  
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset console methods
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('getDefaultConfig', () => {
    it('should return a valid default configuration', () => {
      const config = getDefaultConfig()
      
      expect(config).toBeDefined()
      expect(config.router).toBeDefined()
      expect(config.router.alpha).toBeGreaterThan(0)
      expect(config.router.alpha).toBeLessThanOrEqual(1)
      expect(config.catalog).toBeDefined()
      expect(config.catalog.base_url).toBeDefined()
      expect(config.auth_adapters).toBeDefined()
      expect(Array.isArray(config.auth_adapters.enabled)).toBe(true)
    })

    it('should include all required configuration sections', () => {
      const config = getDefaultConfig()
      
      expect(config.router).toHaveProperty('alpha')
      expect(config.router).toHaveProperty('artifact_path')
      expect(config.router).toHaveProperty('fallback_models')
      expect(config.catalog).toHaveProperty('base_url')
      expect(config.auth_adapters).toHaveProperty('enabled')
    })
  })

  describe('validateConfig', () => {
    it('should validate a correct configuration', () => {
      const validConfig = getDefaultConfig()
      expect(() => validateConfig(validConfig)).not.toThrow()
    })

    it('should throw for missing router section', () => {
      const invalidConfig = { catalog: {}, auth_adapters: {} } as any
      expect(() => validateConfig(invalidConfig)).toThrow('Missing required router configuration')
    })

    it('should throw for missing catalog section', () => {
      const invalidConfig = { router: {}, auth_adapters: {} } as any
      expect(() => validateConfig(invalidConfig)).toThrow('Missing required catalog configuration')
    })

    it('should throw for missing auth_adapters section', () => {
      const invalidConfig = { router: {}, catalog: {} } as any
      expect(() => validateConfig(invalidConfig)).toThrow('Missing required auth_adapters configuration')
    })

    it('should throw for invalid alpha value', () => {
      const invalidConfig = {
        ...getDefaultConfig(),
        router: { ...getDefaultConfig().router, alpha: 1.5 }
      }
      expect(() => validateConfig(invalidConfig)).toThrow('Alpha must be between 0 and 1')
    })

    it('should throw for negative alpha value', () => {
      const invalidConfig = {
        ...getDefaultConfig(),
        router: { ...getDefaultConfig().router, alpha: -0.1 }
      }
      expect(() => validateConfig(invalidConfig)).toThrow('Alpha must be between 0 and 1')
    })
  })

  describe('loadConfig', () => {
    const validConfigContent = `
router:
  alpha: 0.6
  artifact_path: "./artifacts/production.json"
  fallback_models:
    - "anthropic/claude-3-haiku"
    - "openai/gpt-3.5-turbo"

catalog:
  base_url: "http://localhost:3001"

auth_adapters:
  enabled:
    - "anthropic-oauth"
    - "openai-key"
`

    const validConfigObject: RouterConfig = {
      router: {
        alpha: 0.6,
        artifact_path: "./artifacts/production.json",
        fallback_models: ["anthropic/claude-3-haiku", "openai/gpt-3.5-turbo"]
      },
      catalog: {
        base_url: "http://localhost:3001"
      },
      auth_adapters: {
        enabled: ["anthropic-oauth", "openai-key"]
      }
    }

    it('should load configuration from file successfully', async () => {
      mockFs.readFile.mockResolvedValue(validConfigContent)
      mockYaml.load.mockReturnValue(validConfigObject)

      const config = await loadConfig('./test-config.yaml')

      expect(mockFs.readFile).toHaveBeenCalledWith('./test-config.yaml', 'utf-8')
      expect(mockYaml.load).toHaveBeenCalledWith(validConfigContent)
      expect(config).toEqual(validConfigObject)
    })

    it('should try default paths when no specific path provided', async () => {
      mockFs.readFile
        .mockRejectedValueOnce(new Error('File not found'))
        .mockRejectedValueOnce(new Error('File not found'))
        .mockResolvedValueOnce(validConfigContent)
      mockYaml.load.mockReturnValue(validConfigObject)

      const config = await loadConfig()

      expect(mockFs.readFile).toHaveBeenCalledTimes(3)
      expect(config).toEqual(validConfigObject)
    })

    it('should return default config when no files found', async () => {
      mockFs.readFile.mockRejectedValue(new Error('File not found'))

      const config = await loadConfig()

      expect(config).toEqual(getDefaultConfig())
    })

    it('should throw error when specific path fails', async () => {
      mockFs.readFile.mockRejectedValue(new Error('Permission denied'))

      await expect(loadConfig('./specific-config.yaml'))
        .rejects.toThrow('Failed to load config from ./specific-config.yaml')
    })

    it('should validate loaded configuration', async () => {
      const invalidConfigObject = { router: {} } // Missing required fields
      
      mockFs.readFile.mockResolvedValue('invalid: yaml')
      mockYaml.load.mockReturnValue(invalidConfigObject)

      await expect(loadConfig('./invalid-config.yaml'))
        .rejects.toThrow()
    })
  })

  describe('ensureEmergencyArtifact', () => {
    const mockArtifact = {
      version: expect.any(String),
      centroids: "",
      alpha: 0.6,
      thresholds: { cheap: 0.62, hard: 0.58 },
      penalties: { latency_sd: 0.05, ctx_over_80pct: 0.15 },
      qhat: {},
      chat: {},
      gbdt: { framework: "emergency", model_path: "", feature_schema: {} }
    }

    it('should create emergency artifact if it does not exist', async () => {
      mockFs.access.mockRejectedValue(new Error('File not found'))
      mockFs.mkdir.mockResolvedValue(undefined)
      mockFs.writeFile.mockResolvedValue()

      await ensureEmergencyArtifact()

      expect(mockFs.mkdir).toHaveBeenCalledWith('./artifacts', { recursive: true })
      expect(mockFs.writeFile).toHaveBeenCalledWith(
        './artifacts/emergency.json',
        expect.stringContaining('"framework":"emergency"'),
        'utf-8'
      )
    })

    it('should not create artifact if it already exists', async () => {
      mockFs.access.mockResolvedValue(undefined)

      await ensureEmergencyArtifact()

      expect(mockFs.writeFile).not.toHaveBeenCalled()
    })

    it('should handle directory creation errors gracefully', async () => {
      mockFs.access.mockRejectedValue(new Error('File not found'))
      mockFs.mkdir.mockRejectedValue(new Error('Permission denied'))

      await expect(ensureEmergencyArtifact()).rejects.toThrow('Permission denied')
    })
  })

  describe('applyEnvOverrides', () => {
    beforeEach(() => {
      // Clear environment variables
      delete process.env.ROUTER_ALPHA
      delete process.env.CATALOG_BASE_URL
      delete process.env.AUTH_ADAPTERS_ENABLED
    })

    it('should apply environment overrides to configuration', () => {
      process.env.ROUTER_ALPHA = '0.8'
      process.env.CATALOG_BASE_URL = 'http://env-catalog:3001'
      process.env.AUTH_ADAPTERS_ENABLED = 'anthropic-oauth,openai-key'

      const config = getDefaultConfig()
      const overriddenConfig = applyEnvOverrides(config)

      expect(overriddenConfig.router.alpha).toBe(0.8)
      expect(overriddenConfig.catalog.base_url).toBe('http://env-catalog:3001')
      expect(overriddenConfig.auth_adapters.enabled).toEqual(['anthropic-oauth', 'openai-key'])
    })

    it('should not modify config when no environment variables set', () => {
      const config = getDefaultConfig()
      const overriddenConfig = applyEnvOverrides(config)

      expect(overriddenConfig).toEqual(config)
    })

    it('should handle invalid alpha environment variable', () => {
      process.env.ROUTER_ALPHA = 'invalid'

      const config = getDefaultConfig()
      const overriddenConfig = applyEnvOverrides(config)

      // Should keep original alpha value
      expect(overriddenConfig.router.alpha).toBe(config.router.alpha)
    })

    it('should handle empty auth adapters environment variable', () => {
      process.env.AUTH_ADAPTERS_ENABLED = ''

      const config = getDefaultConfig()
      const overriddenConfig = applyEnvOverrides(config)

      expect(overriddenConfig.auth_adapters.enabled).toEqual([])
    })
  })

  describe('getEnvConfig', () => {
    beforeEach(() => {
      // Clear environment variables
      Object.keys(process.env).forEach(key => {
        if (key.startsWith('ROUTER_') || key.startsWith('CATALOG_') || key.startsWith('AUTH_')) {
          delete process.env[key]
        }
      })
    })

    it('should return configuration from environment variables', () => {
      process.env.ROUTER_ALPHA = '0.7'
      process.env.ROUTER_ARTIFACT_PATH = './env-artifacts/prod.json'
      process.env.CATALOG_BASE_URL = 'http://env-catalog:3001'

      const envConfig = getEnvConfig()

      expect(envConfig.router?.alpha).toBe(0.7)
      expect(envConfig.router?.artifact_path).toBe('./env-artifacts/prod.json')
      expect(envConfig.catalog?.base_url).toBe('http://env-catalog:3001')
    })

    it('should return empty configuration when no environment variables set', () => {
      const envConfig = getEnvConfig()

      expect(envConfig.router).toBeUndefined()
      expect(envConfig.catalog).toBeUndefined()
      expect(envConfig.auth_adapters).toBeUndefined()
    })

    it('should handle partial environment configuration', () => {
      process.env.ROUTER_ALPHA = '0.5'

      const envConfig = getEnvConfig()

      expect(envConfig.router?.alpha).toBe(0.5)
      expect(envConfig.catalog).toBeUndefined()
      expect(envConfig.auth_adapters).toBeUndefined()
    })
  })
})