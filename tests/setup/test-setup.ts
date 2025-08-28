/**
 * Test setup - runs before each test file
 */

import { vi } from 'vitest'
import { mockDeep, mockReset } from 'vitest-mock-extended'

// Mock external dependencies that should not be called during tests
vi.mock('faiss-node', () => ({
  IndexFlatL2: vi.fn().mockImplementation(() => ({
    ntotal: vi.fn(() => 0),
    add: vi.fn(),
    search: vi.fn(() => ({ distances: Float32Array.from([]), labels: BigInt64Array.from([]) })),
    getDimension: vi.fn(() => 384),
    writeIndex: vi.fn(),
    fromBuffer: vi.fn()
  }))
}))

// Mock python-shell to avoid calling Python during tests
vi.mock('python-shell', () => ({
  PythonShell: {
    run: vi.fn().mockResolvedValue([]),
    runString: vi.fn().mockResolvedValue([])
  }
}))

// Mock node-cron
vi.mock('node-cron', () => ({
  schedule: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  destroy: vi.fn()
}))

// Mock winston logger
vi.mock('winston', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })),
  format: {
    combine: vi.fn(),
    timestamp: vi.fn(),
    errors: vi.fn(),
    json: vi.fn(),
    colorize: vi.fn(),
    simple: vi.fn()
  },
  transports: {
    Console: vi.fn(),
    File: vi.fn()
  }
}))

// Global test utilities
global.testUtils = {
  // Create test timeout wrapper
  withTimeout: (fn: () => Promise<void>, timeout = 5000) => {
    return Promise.race([
      fn(),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error(`Test timeout after ${timeout}ms`)), timeout)
      )
    ])
  },

  // Create sample request for testing
  createMockRequest: (overrides = {}) => ({
    url: '/v1/chat/completions',
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': 'Bearer test-key'
    },
    body: {
      messages: [
        { role: 'user', content: 'Test message' }
      ],
      model: 'test-model'
    },
    ...overrides
  }),

  // Create sample artifact for testing
  createMockArtifact: (overrides = {}) => ({
    version: '2024-01-01T00:00:00.000Z',
    centroids: '',
    alpha: 0.6,
    thresholds: { cheap: 0.62, hard: 0.58 },
    penalties: { latency_sd: 0.05, ctx_over_80pct: 0.15 },
    qhat: {
      'test-model-1': [0.7, 0.6, 0.8],
      'test-model-2': [0.6, 0.7, 0.7]
    },
    chat: {
      'test-model-1': 0.05,
      'test-model-2': 0.04
    },
    gbdt: {
      framework: 'mock',
      model_path: '',
      feature_schema: {}
    },
    ...overrides
  }),

  // Create mock features
  createMockFeatures: (overrides = {}) => ({
    embedding: new Array(384).fill(0.1),
    cluster_id: 0,
    top_p_distances: [0.3, 0.5, 0.8],
    token_count: 100,
    has_code: false,
    has_math: false,
    ngram_entropy: 4.2,
    context_ratio: 0.05,
    ...overrides
  })
}

// Note: Mock setup is done here, but individual test files should handle their own beforeEach/afterEach

// Global error handler for unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason)
})

declare global {
  var testUtils: {
    withTimeout: (fn: () => Promise<void>, timeout?: number) => Promise<void>
    createMockRequest: (overrides?: any) => any
    createMockArtifact: (overrides?: any) => any
    createMockFeatures: (overrides?: any) => any
  }
}