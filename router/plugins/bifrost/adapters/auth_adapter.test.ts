import { describe, it, expect, beforeEach } from 'vitest'
import { AuthAdapter, AuthAdapterRegistry } from './auth_adapter.js'
import type { AuthInfo } from './auth_adapter.js'

// Mock auth adapter implementations for testing
class MockOAuthAdapter implements AuthAdapter {
  id = 'mock-oauth'
  
  matches(headers: Record<string, string | string[]>): boolean {
    const auth = Array.isArray(headers.authorization) 
      ? headers.authorization[0] 
      : headers.authorization
    return auth?.startsWith('Bearer oauth-') || false
  }
  
  extract(headers: Record<string, string | string[]>): AuthInfo | null {
    const auth = Array.isArray(headers.authorization)
      ? headers.authorization[0]
      : headers.authorization
      
    if (!auth || !this.matches(headers)) {
      return null
    }
    
    return {
      provider: 'mock-oauth',
      type: 'oauth',
      credentials: { token: auth.replace('Bearer ', '') }
    }
  }
}

class MockKeyAdapter implements AuthAdapter {
  id = 'mock-key'
  
  matches(headers: Record<string, string | string[]>): boolean {
    const auth = Array.isArray(headers.authorization)
      ? headers.authorization[0]
      : headers.authorization
    return auth?.startsWith('Bearer key-') || false
  }
  
  extract(headers: Record<string, string | string[]>): AuthInfo | null {
    const auth = Array.isArray(headers.authorization)
      ? headers.authorization[0]
      : headers.authorization
      
    if (!auth || !this.matches(headers)) {
      return null
    }
    
    return {
      provider: 'mock-key',
      type: 'api-key',
      credentials: { key: auth.replace('Bearer ', '') }
    }
  }
}

describe('AuthAdapter System', () => {
  let registry: AuthAdapterRegistry
  let oauthAdapter: MockOAuthAdapter
  let keyAdapter: MockKeyAdapter

  beforeEach(() => {
    registry = new AuthAdapterRegistry()
    oauthAdapter = new MockOAuthAdapter()
    keyAdapter = new MockKeyAdapter()
  })

  describe('AuthAdapterRegistry', () => {
    describe('register', () => {
      it('should register an auth adapter', () => {
        registry.register(oauthAdapter)
        
        expect(registry.get('mock-oauth')).toBe(oauthAdapter)
      })

      it('should allow overwriting existing adapter with same ID', () => {
        const newAdapter = new MockOAuthAdapter()
        
        registry.register(oauthAdapter)
        registry.register(newAdapter)
        
        expect(registry.get('mock-oauth')).toBe(newAdapter)
        expect(registry.get('mock-oauth')).not.toBe(oauthAdapter)
      })
    })

    describe('get', () => {
      it('should return registered adapter by ID', () => {
        registry.register(oauthAdapter)
        
        expect(registry.get('mock-oauth')).toBe(oauthAdapter)
      })

      it('should return undefined for non-existent adapter', () => {
        expect(registry.get('non-existent')).toBeUndefined()
      })
    })

    describe('findMatch', () => {
      beforeEach(() => {
        registry.register(oauthAdapter)
        registry.register(keyAdapter)
      })

      it('should find matching OAuth adapter', () => {
        const headers = {
          authorization: 'Bearer oauth-test-token',
          'content-type': 'application/json'
        }
        
        const match = registry.findMatch(headers)
        
        expect(match).toBe(oauthAdapter)
      })

      it('should find matching API key adapter', () => {
        const headers = {
          authorization: 'Bearer key-test-key',
          'content-type': 'application/json'
        }
        
        const match = registry.findMatch(headers)
        
        expect(match).toBe(keyAdapter)
      })

      it('should return null when no adapter matches', () => {
        const headers = {
          authorization: 'Bearer unknown-token',
          'content-type': 'application/json'
        }
        
        const match = registry.findMatch(headers)
        
        expect(match).toBeNull()
      })

      it('should handle headers without authorization', () => {
        const headers = {
          'content-type': 'application/json'
        }
        
        const match = registry.findMatch(headers)
        
        expect(match).toBeNull()
      })

      it('should handle array-type header values', () => {
        const headers = {
          authorization: ['Bearer oauth-test-token'],
          'content-type': 'application/json'
        }
        
        const match = registry.findMatch(headers)
        
        expect(match).toBe(oauthAdapter)
      })

      it('should return first matching adapter when multiple match', () => {
        // Create adapter that matches everything
        class CatchAllAdapter implements AuthAdapter {
          id = 'catch-all'
          matches(): boolean { return true }
          extract(): AuthInfo | null { return null }
        }
        
        const catchAllAdapter = new CatchAllAdapter()
        registry.register(catchAllAdapter)
        
        const headers = {
          authorization: 'Bearer oauth-test-token'
        }
        
        // Should still return oauth adapter since it was registered first
        const match = registry.findMatch(headers)
        expect(match).toBe(oauthAdapter)
      })
    })

    describe('getEnabled', () => {
      beforeEach(() => {
        registry.register(oauthAdapter)
        registry.register(keyAdapter)
      })

      it('should return enabled adapters in order', () => {
        const enabledIds = ['mock-key', 'mock-oauth']
        
        const enabled = registry.getEnabled(enabledIds)
        
        expect(enabled).toHaveLength(2)
        expect(enabled[0]).toBe(keyAdapter)
        expect(enabled[1]).toBe(oauthAdapter)
      })

      it('should filter out non-existent adapters', () => {
        const enabledIds = ['mock-oauth', 'non-existent', 'mock-key']
        
        const enabled = registry.getEnabled(enabledIds)
        
        expect(enabled).toHaveLength(2)
        expect(enabled[0]).toBe(oauthAdapter)
        expect(enabled[1]).toBe(keyAdapter)
      })

      it('should return empty array for empty input', () => {
        const enabled = registry.getEnabled([])
        
        expect(enabled).toHaveLength(0)
      })

      it('should handle duplicate IDs in input', () => {
        const enabledIds = ['mock-oauth', 'mock-oauth', 'mock-key']
        
        const enabled = registry.getEnabled(enabledIds)
        
        expect(enabled).toHaveLength(3)
        expect(enabled[0]).toBe(oauthAdapter)
        expect(enabled[1]).toBe(oauthAdapter) // Duplicate
        expect(enabled[2]).toBe(keyAdapter)
      })
    })
  })

  describe('Mock Auth Adapters', () => {
    describe('MockOAuthAdapter', () => {
      it('should match OAuth bearer tokens', () => {
        const headers = { authorization: 'Bearer oauth-token-123' }
        
        expect(oauthAdapter.matches(headers)).toBe(true)
      })

      it('should not match non-OAuth tokens', () => {
        const headers = { authorization: 'Bearer regular-token' }
        
        expect(oauthAdapter.matches(headers)).toBe(false)
      })

      it('should not match missing authorization', () => {
        const headers = {}
        
        expect(oauthAdapter.matches(headers)).toBe(false)
      })

      it('should extract OAuth auth info', () => {
        const headers = { authorization: 'Bearer oauth-token-123' }
        
        const authInfo = oauthAdapter.extract(headers)
        
        expect(authInfo).toEqual({
          provider: 'mock-oauth',
          type: 'oauth',
          credentials: { token: 'oauth-token-123' }
        })
      })

      it('should return null for non-matching headers', () => {
        const headers = { authorization: 'Bearer regular-token' }
        
        const authInfo = oauthAdapter.extract(headers)
        
        expect(authInfo).toBeNull()
      })

      it('should handle array authorization headers', () => {
        const headers = { authorization: ['Bearer oauth-token-123'] }
        
        expect(oauthAdapter.matches(headers)).toBe(true)
        
        const authInfo = oauthAdapter.extract(headers)
        expect(authInfo).toEqual({
          provider: 'mock-oauth',
          type: 'oauth',
          credentials: { token: 'oauth-token-123' }
        })
      })
    })

    describe('MockKeyAdapter', () => {
      it('should match API key bearer tokens', () => {
        const headers = { authorization: 'Bearer key-abc123' }
        
        expect(keyAdapter.matches(headers)).toBe(true)
      })

      it('should not match non-key tokens', () => {
        const headers = { authorization: 'Bearer oauth-token' }
        
        expect(keyAdapter.matches(headers)).toBe(false)
      })

      it('should extract API key auth info', () => {
        const headers = { authorization: 'Bearer key-abc123' }
        
        const authInfo = keyAdapter.extract(headers)
        
        expect(authInfo).toEqual({
          provider: 'mock-key',
          type: 'api-key',
          credentials: { key: 'key-abc123' }
        })
      })

      it('should return null for non-matching headers', () => {
        const headers = { authorization: 'Bearer oauth-token' }
        
        const authInfo = keyAdapter.extract(headers)
        
        expect(authInfo).toBeNull()
      })
    })
  })

  describe('Integration scenarios', () => {
    it('should handle complete auth flow', () => {
      registry.register(oauthAdapter)
      registry.register(keyAdapter)

      // Test OAuth flow
      const oauthHeaders = { authorization: 'Bearer oauth-my-token' }
      const oauthMatch = registry.findMatch(oauthHeaders)
      
      expect(oauthMatch).toBe(oauthAdapter)
      
      const oauthInfo = oauthMatch?.extract(oauthHeaders)
      expect(oauthInfo).toEqual({
        provider: 'mock-oauth',
        type: 'oauth',
        credentials: { token: 'oauth-my-token' }
      })

      // Test API key flow
      const keyHeaders = { authorization: 'Bearer key-my-key' }
      const keyMatch = registry.findMatch(keyHeaders)
      
      expect(keyMatch).toBe(keyAdapter)
      
      const keyInfo = keyMatch?.extract(keyHeaders)
      expect(keyInfo).toEqual({
        provider: 'mock-key',
        type: 'api-key',
        credentials: { key: 'key-my-key' }
      })
    })

    it('should handle priority-based adapter selection', () => {
      // Register adapters in specific order
      registry.register(keyAdapter)    // First
      registry.register(oauthAdapter)  // Second
      
      const enabledAdapters = registry.getEnabled(['mock-oauth', 'mock-key'])
      
      // Should return in requested order, not registration order
      expect(enabledAdapters[0]).toBe(oauthAdapter)
      expect(enabledAdapters[1]).toBe(keyAdapter)
    })
  })
})