import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    // Test environment
    environment: 'node',
    
    // Test file patterns
    include: [
      'src/**/*.{test,spec}.{ts,js}',
      'router/**/*.{test,spec}.{ts,js}',
      'tests/**/*.{test,spec}.{ts,js}'
    ],
    
    // Exclude patterns
    exclude: [
      'node_modules/**',
      'dist/**',
      '**/*.d.ts'
    ],
    
    // Global setup/teardown
    globalSetup: ['./tests/setup/global-setup.ts'],
    setupFiles: ['./tests/setup/test-setup.ts'],
    
    // Test timeout
    testTimeout: 10000,
    hookTimeout: 10000,
    
    // Coverage configuration
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      reportsDirectory: './coverage',
      
      // Coverage thresholds - enforce >85% coverage
      thresholds: {
        global: {
          lines: 85,
          functions: 85,
          branches: 85,
          statements: 85
        }
      },
      
      // Include/exclude patterns for coverage
      include: [
        'src/**/*.{ts,js}',
        'router/**/*.{ts,js}'
      ],
      
      exclude: [
        'node_modules/**',
        'dist/**',
        '**/*.d.ts',
        '**/*.test.{ts,js}',
        '**/*.spec.{ts,js}',
        '**/test-*.{ts,js}',
        'tests/**',
        'scripts/**',
        '**/*.config.{ts,js}',
        'router/services/tuning/**/*.py'
      ],
      
      // Exclude specific files that are hard to test or not critical
      excludeNodeModules: true,
      skipFull: false
    },
    
    // Parallel execution
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: false
      }
    },
    
    // Reporter configuration
    reporter: ['verbose', 'json', 'junit'],
    outputFile: {
      json: './test-results/results.json',
      junit: './test-results/junit.xml'
    },
    
    // Mock configuration
    clearMocks: true,
    restoreMocks: true,
    
    // Watch options
    watch: false
  },
  
  // Resolve configuration for imports
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@router': path.resolve(__dirname, './router'),
      '@tests': path.resolve(__dirname, './tests')
    }
  },
  
  // Define globals for tests
  define: {
    'import.meta.vitest': undefined
  }
})