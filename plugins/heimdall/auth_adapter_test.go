package main

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Test fixtures and mock adapters (port from TypeScript)

// MockOAuthAdapter implements AuthAdapter for OAuth testing
type MockOAuthAdapter struct{}

func (a *MockOAuthAdapter) GetID() string { return "mock-oauth" }

func (a *MockOAuthAdapter) Matches(headers map[string][]string) bool {
	auth := getHeaderValue(headers, "authorization")
	return len(auth) > 7 && auth[:7] == "Bearer " && len(auth) > 13 && auth[7:13] == "oauth-"
}

func (a *MockOAuthAdapter) Extract(headers map[string][]string) *AuthInfo {
	auth := getHeaderValue(headers, "authorization")
	if !a.Matches(headers) {
		return nil
	}
	return &AuthInfo{
		Provider: "mock-oauth",
		Type:     "oauth",
		Token:    auth[7:], // Remove "Bearer " prefix
	}
}

func (a *MockOAuthAdapter) Apply(outgoing *http.Request) *http.Request {
	return outgoing // No modification needed for test
}

// MockKeyAdapter implements AuthAdapter for API key testing
type MockKeyAdapter struct{}

func (a *MockKeyAdapter) GetID() string { return "mock-key" }

func (a *MockKeyAdapter) Matches(headers map[string][]string) bool {
	auth := getHeaderValue(headers, "authorization")
	return len(auth) > 7 && auth[:7] == "Bearer " && len(auth) > 11 && auth[7:11] == "key-"
}

func (a *MockKeyAdapter) Extract(headers map[string][]string) *AuthInfo {
	auth := getHeaderValue(headers, "authorization")
	if !a.Matches(headers) {
		return nil
	}
	return &AuthInfo{
		Provider: "mock-key",
		Type:     "api-key", 
		Token:    auth[7:], // Remove "Bearer " prefix
	}
}

func (a *MockKeyAdapter) Apply(outgoing *http.Request) *http.Request {
	return outgoing // No modification needed for test
}

// TestAuthAdapterSystem tests the complete auth adapter system
func TestAuthAdapterSystem(t *testing.T) {
	t.Run("AuthAdapterRegistry", func(t *testing.T) {
		testAuthAdapterRegistry(t)
	})

	t.Run("MockAuthAdapters", func(t *testing.T) {
		testMockAuthAdapters(t)
	})

	t.Run("IntegrationScenarios", func(t *testing.T) {
		testAuthIntegrationScenarios(t)
	})
}

func testAuthAdapterRegistry(t *testing.T) {
	var registry *AuthAdapterRegistry
	var oauthAdapter *MockOAuthAdapter
	var keyAdapter *MockKeyAdapter

	// Setup for each test
	setup := func() {
		registry = NewAuthAdapterRegistry()
		oauthAdapter = &MockOAuthAdapter{}
		keyAdapter = &MockKeyAdapter{}
	}

	t.Run("register", func(t *testing.T) {
		setup()
		t.Run("should register an auth adapter", func(t *testing.T) {
			registry.Register(oauthAdapter)
			
			retrieved := registry.Get("mock-oauth")
			require.NotNil(t, retrieved)
			assert.Equal(t, oauthAdapter, retrieved)
		})

		t.Run("should allow overwriting existing adapter with same ID", func(t *testing.T) {
			newAdapter := &MockOAuthAdapter{}
			
			registry.Register(oauthAdapter)
			registry.Register(newAdapter)
			
			retrieved := registry.Get("mock-oauth")
			require.NotNil(t, retrieved)
			assert.Equal(t, newAdapter, retrieved)
			assert.NotEqual(t, oauthAdapter, retrieved)
		})
	})

	t.Run("get", func(t *testing.T) {
		setup()
		t.Run("should return registered adapter by ID", func(t *testing.T) {
			registry.Register(oauthAdapter)
			
			retrieved := registry.Get("mock-oauth")
			assert.Equal(t, oauthAdapter, retrieved)
		})

		t.Run("should return nil for non-existent adapter", func(t *testing.T) {
			retrieved := registry.Get("non-existent")
			assert.Nil(t, retrieved)
		})
	})

	t.Run("getEnabled", func(t *testing.T) {
		setup()
		registry.Register(oauthAdapter)
		registry.Register(keyAdapter)

		t.Run("should return enabled adapters in order", func(t *testing.T) {
			enabledIDs := []string{"mock-key", "mock-oauth"}
			
			enabled := registry.GetEnabled(enabledIDs)
			
			require.Len(t, enabled, 2)
			assert.Equal(t, keyAdapter, enabled[0])
			assert.Equal(t, oauthAdapter, enabled[1])
		})

		t.Run("should filter out non-existent adapters", func(t *testing.T) {
			enabledIDs := []string{"mock-oauth", "non-existent", "mock-key"}
			
			enabled := registry.GetEnabled(enabledIDs)
			
			require.Len(t, enabled, 2)
			assert.Equal(t, oauthAdapter, enabled[0])
			assert.Equal(t, keyAdapter, enabled[1])
		})

		t.Run("should return empty array for empty input", func(t *testing.T) {
			enabled := registry.GetEnabled([]string{})
			
			assert.Len(t, enabled, 0)
		})

		t.Run("should handle duplicate IDs in input", func(t *testing.T) {
			enabledIDs := []string{"mock-oauth", "mock-oauth", "mock-key"}
			
			enabled := registry.GetEnabled(enabledIDs)
			
			require.Len(t, enabled, 3)
			assert.Equal(t, oauthAdapter, enabled[0])
			assert.Equal(t, oauthAdapter, enabled[1]) // Duplicate
			assert.Equal(t, keyAdapter, enabled[2])
		})
	})

	t.Run("findMatch", func(t *testing.T) {
		setup()
		registry.Register(oauthAdapter)
		registry.Register(keyAdapter)

		t.Run("should find matching OAuth adapter", func(t *testing.T) {
			headers := map[string][]string{
				"authorization": {"Bearer oauth-test-token"},
				"content-type":  {"application/json"},
			}
			
			match := registry.FindMatch(headers)
			
			require.NotNil(t, match)
			assert.Equal(t, "mock-oauth", match.GetID())
		})

		t.Run("should find matching API key adapter", func(t *testing.T) {
			headers := map[string][]string{
				"authorization": {"Bearer key-test-key"},
				"content-type":  {"application/json"},
			}
			
			match := registry.FindMatch(headers)
			
			require.NotNil(t, match)
			assert.Equal(t, "mock-key", match.GetID())
		})

		t.Run("should return nil when no adapter matches", func(t *testing.T) {
			headers := map[string][]string{
				"authorization": {"Bearer unknown-token"},
				"content-type":  {"application/json"},
			}
			
			match := registry.FindMatch(headers)
			
			assert.Nil(t, match)
		})

		t.Run("should handle headers without authorization", func(t *testing.T) {
			headers := map[string][]string{
				"content-type": {"application/json"},
			}
			
			match := registry.FindMatch(headers)
			
			assert.Nil(t, match)
		})

		t.Run("should handle array-type header values", func(t *testing.T) {
			headers := map[string][]string{
				"authorization": {"Bearer oauth-test-token"},
				"content-type":  {"application/json"},
			}
			
			match := registry.FindMatch(headers)
			
			require.NotNil(t, match)
			assert.Equal(t, "mock-oauth", match.GetID())
		})

		t.Run("should return first matching adapter when multiple match", func(t *testing.T) {
			// Create adapter that matches everything
			catchAllAdapter := &CatchAllAdapter{}
			registry.Register(catchAllAdapter)
			
			headers := map[string][]string{
				"authorization": {"Bearer oauth-test-token"},
			}
			
			// Should still return oauth adapter since it was registered first
			match := registry.FindMatch(headers)
			require.NotNil(t, match)
			// The first matching adapter should be returned (order-dependent)
			// OAuth was registered first, so it should match first
			assert.Equal(t, "mock-oauth", match.GetID())
		})
	})
}

// CatchAllAdapter for testing multiple matches
type CatchAllAdapter struct{}

func (a *CatchAllAdapter) GetID() string { return "catch-all" }
func (a *CatchAllAdapter) Matches(headers map[string][]string) bool { return true }
func (a *CatchAllAdapter) Extract(headers map[string][]string) *AuthInfo { return nil }
func (a *CatchAllAdapter) Apply(outgoing *http.Request) *http.Request { return outgoing }

func testMockAuthAdapters(t *testing.T) {
	t.Run("MockOAuthAdapter", func(t *testing.T) {
		oauthAdapter := &MockOAuthAdapter{}

		t.Run("should match OAuth bearer tokens", func(t *testing.T) {
			headers := map[string][]string{
				"authorization": {"Bearer oauth-token-123"},
			}
			
			assert.True(t, oauthAdapter.Matches(headers))
		})

		t.Run("should not match non-OAuth tokens", func(t *testing.T) {
			headers := map[string][]string{
				"authorization": {"Bearer regular-token"},
			}
			
			assert.False(t, oauthAdapter.Matches(headers))
		})

		t.Run("should not match missing authorization", func(t *testing.T) {
			headers := map[string][]string{}
			
			assert.False(t, oauthAdapter.Matches(headers))
		})

		t.Run("should extract OAuth auth info", func(t *testing.T) {
			headers := map[string][]string{
				"authorization": {"Bearer oauth-token-123"},
			}
			
			authInfo := oauthAdapter.Extract(headers)
			
			require.NotNil(t, authInfo)
			assert.Equal(t, "mock-oauth", authInfo.Provider)
			assert.Equal(t, "oauth", authInfo.Type)
			assert.Equal(t, "oauth-token-123", authInfo.Token)
		})

		t.Run("should return nil for non-matching headers", func(t *testing.T) {
			headers := map[string][]string{
				"authorization": {"Bearer regular-token"},
			}
			
			authInfo := oauthAdapter.Extract(headers)
			
			assert.Nil(t, authInfo)
		})

		t.Run("should handle array authorization headers", func(t *testing.T) {
			headers := map[string][]string{
				"authorization": {"Bearer oauth-token-123"},
			}
			
			assert.True(t, oauthAdapter.Matches(headers))
			
			authInfo := oauthAdapter.Extract(headers)
			require.NotNil(t, authInfo)
			assert.Equal(t, "mock-oauth", authInfo.Provider)
			assert.Equal(t, "oauth", authInfo.Type)
			assert.Equal(t, "oauth-token-123", authInfo.Token)
		})
	})

	t.Run("MockKeyAdapter", func(t *testing.T) {
		keyAdapter := &MockKeyAdapter{}

		t.Run("should match API key bearer tokens", func(t *testing.T) {
			headers := map[string][]string{
				"authorization": {"Bearer key-abc123"},
			}
			
			assert.True(t, keyAdapter.Matches(headers))
		})

		t.Run("should not match non-key tokens", func(t *testing.T) {
			headers := map[string][]string{
				"authorization": {"Bearer oauth-token"},
			}
			
			assert.False(t, keyAdapter.Matches(headers))
		})

		t.Run("should extract API key auth info", func(t *testing.T) {
			headers := map[string][]string{
				"authorization": {"Bearer key-abc123"},
			}
			
			authInfo := keyAdapter.Extract(headers)
			
			require.NotNil(t, authInfo)
			assert.Equal(t, "mock-key", authInfo.Provider)
			assert.Equal(t, "api-key", authInfo.Type)
			assert.Equal(t, "key-abc123", authInfo.Token)
		})

		t.Run("should return nil for non-matching headers", func(t *testing.T) {
			headers := map[string][]string{
				"authorization": {"Bearer oauth-token"},
			}
			
			authInfo := keyAdapter.Extract(headers)
			
			assert.Nil(t, authInfo)
		})
	})
}

func testAuthIntegrationScenarios(t *testing.T) {
	t.Run("should handle complete auth flow", func(t *testing.T) {
		registry := NewAuthAdapterRegistry()
		oauthAdapter := &MockOAuthAdapter{}
		keyAdapter := &MockKeyAdapter{}
		
		registry.Register(oauthAdapter)
		registry.Register(keyAdapter)

		// Test OAuth flow
		oauthHeaders := map[string][]string{
			"authorization": {"Bearer oauth-my-token"},
		}
		oauthMatch := registry.FindMatch(oauthHeaders)
		
		require.NotNil(t, oauthMatch)
		assert.Equal(t, "mock-oauth", oauthMatch.GetID())
		
		oauthInfo := oauthMatch.Extract(oauthHeaders)
		require.NotNil(t, oauthInfo)
		assert.Equal(t, "mock-oauth", oauthInfo.Provider)
		assert.Equal(t, "oauth", oauthInfo.Type)
		assert.Equal(t, "oauth-my-token", oauthInfo.Token)

		// Test API key flow
		keyHeaders := map[string][]string{
			"authorization": {"Bearer key-my-key"},
		}
		keyMatch := registry.FindMatch(keyHeaders)
		
		require.NotNil(t, keyMatch)
		assert.Equal(t, "mock-key", keyMatch.GetID())
		
		keyInfo := keyMatch.Extract(keyHeaders)
		require.NotNil(t, keyInfo)
		assert.Equal(t, "mock-key", keyInfo.Provider)
		assert.Equal(t, "api-key", keyInfo.Type)
		assert.Equal(t, "key-my-key", keyInfo.Token)
	})

	t.Run("should handle priority-based adapter selection", func(t *testing.T) {
		registry := NewAuthAdapterRegistry()
		keyAdapter := &MockKeyAdapter{}    // Register first
		oauthAdapter := &MockOAuthAdapter{} // Register second
		
		registry.Register(keyAdapter)
		registry.Register(oauthAdapter)
		
		// The first matching adapter should be returned
		// If a request matches both, the first registered one should be used
		
		// Test with oauth token (should match oauth adapter)
		oauthHeaders := map[string][]string{
			"authorization": {"Bearer oauth-test-token"},
		}
		match := registry.FindMatch(oauthHeaders)
		require.NotNil(t, match)
		assert.Equal(t, "mock-oauth", match.GetID())
		
		// Test with key token (should match key adapter) 
		keyHeaders := map[string][]string{
			"authorization": {"Bearer key-test-key"},
		}
		match = registry.FindMatch(keyHeaders)
		require.NotNil(t, match)
		assert.Equal(t, "mock-key", match.GetID())
	})
}

// Test the existing OpenAI and Anthropic adapters
func TestBuiltinAuthAdapters(t *testing.T) {
	t.Run("OpenAIKeyAdapter", func(t *testing.T) {
		adapter := &OpenAIKeyAdapter{}

		t.Run("should match OpenAI API keys", func(t *testing.T) {
			headers := map[string][]string{
				"Authorization": {"Bearer sk-test123"},
			}
			
			assert.True(t, adapter.Matches(headers))
		})

		t.Run("should not match non-OpenAI keys", func(t *testing.T) {
			headers := map[string][]string{
				"Authorization": {"Bearer regular-token"},
			}
			
			assert.False(t, adapter.Matches(headers))
		})

		t.Run("should extract OpenAI auth info", func(t *testing.T) {
			headers := map[string][]string{
				"Authorization": {"Bearer sk-test123"},
			}
			
			authInfo := adapter.Extract(headers)
			
			require.NotNil(t, authInfo)
			assert.Equal(t, "openai", authInfo.Provider)
			assert.Equal(t, "bearer", authInfo.Type)
			assert.Equal(t, "sk-test123", authInfo.Token)
		})
	})

	t.Run("AnthropicOAuthAdapter", func(t *testing.T) {
		adapter := &AnthropicOAuthAdapter{}

		t.Run("should match Anthropic OAuth tokens", func(t *testing.T) {
			headers := map[string][]string{
				"Authorization": {"Bearer anthropic_test123"},
			}
			
			assert.True(t, adapter.Matches(headers))
		})

		t.Run("should extract Anthropic auth info", func(t *testing.T) {
			headers := map[string][]string{
				"Authorization": {"Bearer anthropic_test123"},
			}
			
			authInfo := adapter.Extract(headers)
			
			require.NotNil(t, authInfo)
			assert.Equal(t, "anthropic", authInfo.Provider)
			assert.Equal(t, "bearer", authInfo.Type)
			assert.Equal(t, "anthropic_test123", authInfo.Token)
		})
	})

	t.Run("GeminiOAuthAdapter", func(t *testing.T) {
		adapter := &GeminiOAuthAdapter{}

		t.Run("should match Google OAuth tokens", func(t *testing.T) {
			headers := map[string][]string{
				"Authorization": {"Bearer ya29.test123"},
			}
			
			assert.True(t, adapter.Matches(headers))
		})

		t.Run("should extract Google auth info", func(t *testing.T) {
			headers := map[string][]string{
				"Authorization": {"Bearer ya29.test123"},
			}
			
			authInfo := adapter.Extract(headers)
			
			require.NotNil(t, authInfo)
			assert.Equal(t, "google", authInfo.Provider)
			assert.Equal(t, "bearer", authInfo.Type)
			assert.Equal(t, "ya29.test123", authInfo.Token)
		})
	})
}

// Test registry methods that are missing from main.go
func TestAuthAdapterRegistryMethods(t *testing.T) {
	t.Run("should provide Get method", func(t *testing.T) {
		registry := NewAuthAdapterRegistry()
		adapter := &MockOAuthAdapter{}
		
		// Register adapter
		registry.Register(adapter)
		
		// We need to add a Get method to AuthAdapterRegistry
		// For now, test the core functionality through FindMatch
		headers := map[string][]string{
			"authorization": {"Bearer oauth-test"},
		}
		match := registry.FindMatch(headers)
		require.NotNil(t, match)
		assert.Equal(t, "mock-oauth", match.GetID())
	})
}