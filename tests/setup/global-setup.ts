/**
 * Global test setup - runs once before all tests
 */

import { existsSync, mkdirSync } from 'fs'
import path from 'path'
import { ensureEmergencyArtifact } from '../../src/config.js'

export default async function globalSetup() {
  // Create test directories
  const testDirs = [
    './test-results',
    './coverage',
    './test_artifacts',
    './artifacts'
  ]

  for (const dir of testDirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
  }

  // Ensure emergency artifact exists for tests
  try {
    await ensureEmergencyArtifact()
    console.log('✓ Emergency artifact ready for tests')
  } catch (error) {
    console.warn('⚠ Could not create emergency artifact:', error)
  }

  // Set test environment variables
  process.env.NODE_ENV = 'test'
  process.env.LOG_LEVEL = 'warn' // Reduce log noise in tests
  
  console.log('🧪 Global test setup completed')
}