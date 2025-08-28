package main

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"
)

// TestCircuitBreaker tests the CircuitBreaker functionality
func TestCircuitBreaker(t *testing.T) {
	t.Run("should start in closed state", func(t *testing.T) {
		cb := NewCircuitBreaker(3, time.Minute)
		
		if cb.GetState() != CircuitBreakerClosed {
			t.Errorf("Expected state to be closed, got %s", cb.GetState())
		}
	})
	
	t.Run("should execute operation successfully when closed", func(t *testing.T) {
		cb := NewCircuitBreaker(3, time.Minute)
		ctx := context.Background()
		
		callCount := 0
		operation := func() error {
			callCount++
			return nil
		}
		
		err := cb.Execute(ctx, operation)
		
		if err != nil {
			t.Errorf("Expected no error, got %v", err)
		}
		if callCount != 1 {
			t.Errorf("Expected operation to be called once, got %d", callCount)
		}
		if cb.GetState() != CircuitBreakerClosed {
			t.Errorf("Expected state to remain closed, got %s", cb.GetState())
		}
	})
	
	t.Run("should open circuit after threshold failures", func(t *testing.T) {
		cb := NewCircuitBreaker(3, time.Minute)
		ctx := context.Background()
		
		callCount := 0
		operation := func() error {
			callCount++
			return fmt.Errorf("operation failed")
		}
		
		// Fail 3 times to reach threshold
		for i := 0; i < 3; i++ {
			err := cb.Execute(ctx, operation)
			if err == nil {
				t.Errorf("Expected error on attempt %d", i+1)
			}
		}
		
		if cb.GetState() != CircuitBreakerOpen {
			t.Errorf("Expected state to be open, got %s", cb.GetState())
		}
		if callCount != 3 {
			t.Errorf("Expected 3 operation calls, got %d", callCount)
		}
	})
	
	t.Run("should reject immediately when open", func(t *testing.T) {
		cb := NewCircuitBreaker(3, time.Minute)
		ctx := context.Background()
		
		callCount := 0
		operation := func() error {
			callCount++
			return fmt.Errorf("operation failed")
		}
		
		// Open the circuit
		for i := 0; i < 3; i++ {
			cb.Execute(ctx, operation)
		}
		
		if cb.GetState() != CircuitBreakerOpen {
			t.Errorf("Expected state to be open")
		}
		
		// Next call should be rejected immediately
		err := cb.Execute(ctx, operation)
		if err == nil {
			t.Errorf("Expected error for open circuit")
		}
		if err.Error() != "circuit breaker is open" {
			t.Errorf("Expected 'circuit breaker is open', got %s", err.Error())
		}
		if callCount != 3 {
			t.Errorf("Expected no additional calls, got %d total calls", callCount)
		}
	})
	
	t.Run("should transition to half-open after timeout", func(t *testing.T) {
		cb := NewCircuitBreaker(3, 100*time.Millisecond) // Short timeout for test
		ctx := context.Background()
		
		// Open the circuit
		operation := func() error {
			return fmt.Errorf("operation failed")
		}
		
		for i := 0; i < 3; i++ {
			cb.Execute(ctx, operation)
		}
		
		if cb.GetState() != CircuitBreakerOpen {
			t.Errorf("Expected state to be open")
		}
		
		// Wait for reset timeout
		time.Sleep(150 * time.Millisecond)
		
		// Next successful call should close the circuit
		successOperation := func() error {
			return nil
		}
		
		err := cb.Execute(ctx, successOperation)
		if err != nil {
			t.Errorf("Expected successful operation after timeout, got %v", err)
		}
		if cb.GetState() != CircuitBreakerClosed {
			t.Errorf("Expected state to be closed after successful operation, got %s", cb.GetState())
		}
	})
	
	t.Run("should reset to closed on successful execution in half-open state", func(t *testing.T) {
		cb := NewCircuitBreaker(3, 100*time.Millisecond)
		ctx := context.Background()
		
		// Open circuit
		failOperation := func() error {
			return fmt.Errorf("operation failed")
		}
		
		for i := 0; i < 3; i++ {
			cb.Execute(ctx, failOperation)
		}
		
		// Wait for timeout to transition to half-open
		time.Sleep(150 * time.Millisecond)
		
		// Successful operation should close circuit
		successOperation := func() error {
			return nil
		}
		
		err := cb.Execute(ctx, successOperation)
		if err != nil {
			t.Errorf("Expected success, got %v", err)
		}
		if cb.GetState() != CircuitBreakerClosed {
			t.Errorf("Expected closed state, got %s", cb.GetState())
		}
	})
}

// TestErrorHandler tests the ErrorHandler functionality
func TestErrorHandler(t *testing.T) {
	t.Run("should execute operation successfully on first attempt", func(t *testing.T) {
		eh := NewErrorHandler()
		ctx := context.Background()
		
		callCount := 0
		operations := []func() error{
			func() error {
				callCount++
				return nil
			},
		}
		
		context := ErrorContext{
			Component: "test",
			Operation: "test_op",
		}
		
		options := FallbackOptions{
			MaxRetries: 2,
			RetryDelay: 10 * time.Millisecond,
			Timeout:    time.Second,
		}
		
		err := eh.WithFallback(ctx, operations, context, options)
		
		if err != nil {
			t.Errorf("Expected no error, got %v", err)
		}
		if callCount != 1 {
			t.Errorf("Expected 1 call, got %d", callCount)
		}
	})
	
	t.Run("should retry failed operations", func(t *testing.T) {
		eh := NewErrorHandler()
		ctx := context.Background()
		
		callCount := 0
		operations := []func() error{
			func() error {
				callCount++
				if callCount < 3 {
					return fmt.Errorf("operation failed")
				}
				return nil
			},
		}
		
		context := ErrorContext{
			Component: "test",
			Operation: "test_retry",
		}
		
		options := FallbackOptions{
			MaxRetries: 3,
			RetryDelay: 1 * time.Millisecond,
			Timeout:    time.Second,
		}
		
		err := eh.WithFallback(ctx, operations, context, options)
		
		if err != nil {
			t.Errorf("Expected eventual success, got %v", err)
		}
		if callCount != 3 {
			t.Errorf("Expected 3 calls, got %d", callCount)
		}
	})
	
	t.Run("should try fallback operations when primary fails", func(t *testing.T) {
		eh := NewErrorHandler()
		ctx := context.Background()
		
		var callSequence []string
		operations := []func() error{
			func() error {
				callSequence = append(callSequence, "primary")
				return fmt.Errorf("primary failed")
			},
			func() error {
				callSequence = append(callSequence, "fallback1")
				return fmt.Errorf("fallback1 failed")
			},
			func() error {
				callSequence = append(callSequence, "fallback2")
				return nil // Success
			},
		}
		
		context := ErrorContext{
			Component: "test",
			Operation: "test_fallback",
		}
		
		options := FallbackOptions{
			MaxRetries: 1,
			RetryDelay: 1 * time.Millisecond,
		}
		
		err := eh.WithFallback(ctx, operations, context, options)
		
		if err != nil {
			t.Errorf("Expected eventual success, got %v", err)
		}
		
		expected := []string{"primary", "primary", "fallback1", "fallback1", "fallback2"}
		if len(callSequence) != len(expected) {
			t.Errorf("Expected %d calls, got %d: %v", len(expected), len(callSequence), callSequence)
		}
	})
	
	t.Run("should fail when all operations and retries exhausted", func(t *testing.T) {
		eh := NewErrorHandler()
		ctx := context.Background()
		
		callCount := 0
		operations := []func() error{
			func() error {
				callCount++
				return fmt.Errorf("primary failed")
			},
			func() error {
				callCount++
				return fmt.Errorf("fallback failed")
			},
		}
		
		context := ErrorContext{
			Component: "test",
			Operation: "test_all_fail",
		}
		
		options := FallbackOptions{
			MaxRetries: 1,
			RetryDelay: 1 * time.Millisecond,
		}
		
		err := eh.WithFallback(ctx, operations, context, options)
		
		if err == nil {
			t.Errorf("Expected error when all operations fail")
		}
		if callCount != 4 { // 2 operations × 2 attempts each
			t.Errorf("Expected 4 calls, got %d", callCount)
		}
		
		expectedMsg := "all fallback operations failed for test.test_all_fail"
		if err.Error()[:len(expectedMsg)] != expectedMsg {
			t.Errorf("Expected error message to start with '%s', got '%s'", expectedMsg, err.Error())
		}
	})
	
	t.Run("should handle timeout", func(t *testing.T) {
		eh := NewErrorHandler()
		ctx := context.Background()
		
		operations := []func() error{
			func() error {
				time.Sleep(200 * time.Millisecond)
				return nil
			},
		}
		
		context := ErrorContext{
			Component: "test",
			Operation: "test_timeout",
		}
		
		options := FallbackOptions{
			MaxRetries: 0,
			Timeout:    50 * time.Millisecond,
		}
		
		err := eh.WithFallback(ctx, operations, context, options)
		
		if err == nil {
			t.Errorf("Expected timeout error")
		}
		if !strings.Contains(err.Error(), "context deadline exceeded") {
			t.Errorf("Expected timeout error, got %v", err)
		}
	})
	
	t.Run("should use exponential backoff for retries", func(t *testing.T) {
		eh := NewErrorHandler()
		ctx := context.Background()
		
		var retryTimes []time.Time
		start := time.Now()
		
		operations := []func() error{
			func() error {
				retryTimes = append(retryTimes, time.Now())
				return fmt.Errorf("always fails")
			},
		}
		
		context := ErrorContext{
			Component: "test",
			Operation: "test_backoff",
		}
		
		options := FallbackOptions{
			MaxRetries: 3,
			RetryDelay: 20 * time.Millisecond,
		}
		
		eh.WithFallback(ctx, operations, context, options)
		
		if len(retryTimes) != 4 { // Initial + 3 retries
			t.Errorf("Expected 4 attempts, got %d", len(retryTimes))
		}
		
		// Check exponential backoff - delays should be approximately 20ms, 40ms, 80ms
		if len(retryTimes) >= 2 {
			delay1 := retryTimes[1].Sub(retryTimes[0])
			if delay1 < 15*time.Millisecond || delay1 > 35*time.Millisecond {
				t.Errorf("First retry delay should be ~20ms, got %v", delay1)
			}
		}
		
		if len(retryTimes) >= 3 {
			delay2 := retryTimes[2].Sub(retryTimes[1])
			if delay2 < 35*time.Millisecond || delay2 > 55*time.Millisecond {
				t.Errorf("Second retry delay should be ~40ms, got %v", delay2)
			}
		}
		
		totalTime := time.Since(start)
		if totalTime < 140*time.Millisecond { // 20+40+80 = 140ms minimum
			t.Errorf("Total time too short for exponential backoff: %v", totalTime)
		}
	})
	
	t.Run("should work with circuit breaker", func(t *testing.T) {
		eh := NewErrorHandler()
		ctx := context.Background()
		
		callCount := 0
		operation := func() error {
			callCount++
			return fmt.Errorf("operation failed")
		}
		
		context := ErrorContext{
			Component: "test",
			Operation: "test_circuit",
		}
		
		// First few calls should execute and fail
		for i := 0; i < 5; i++ {
			err := eh.WithCircuitBreaker(ctx, operation, context)
			if err == nil {
				t.Errorf("Expected error on call %d", i+1)
			}
		}
		
		// After threshold is reached, circuit should be open
		err := eh.WithCircuitBreaker(ctx, operation, context)
		if err == nil {
			t.Errorf("Expected circuit breaker to be open")
		}
		if err.Error() != "circuit breaker is open" {
			t.Errorf("Expected 'circuit breaker is open', got %s", err.Error())
		}
		
		// Should not make additional operation calls when circuit is open
		if callCount != 5 {
			t.Errorf("Expected exactly 5 calls (threshold), got %d", callCount)
		}
	})
	
	t.Run("should manage circuit breaker states", func(t *testing.T) {
		eh := NewErrorHandler()
		ctx := context.Background()
		
		// Start with no circuit breakers
		states := eh.GetCircuitBreakerStates()
		if len(states) != 0 {
			t.Errorf("Expected no circuit breakers initially, got %d", len(states))
		}
		
		// Execute operation to create circuit breaker
		context := ErrorContext{
			Component: "test",
			Operation: "state_test",
		}
		
		operation := func() error {
			return nil
		}
		
		eh.WithCircuitBreaker(ctx, operation, context)
		
		// Check circuit breaker state
		states = eh.GetCircuitBreakerStates()
		if len(states) != 1 {
			t.Errorf("Expected 1 circuit breaker, got %d", len(states))
		}
		
		key := "test.state_test"
		if states[key] != "closed" {
			t.Errorf("Expected closed state, got %s", states[key])
		}
		
		// Clear circuit breakers
		eh.ClearCircuitBreakers()
		
		states = eh.GetCircuitBreakerStates()
		if len(states) != 0 {
			t.Errorf("Expected no circuit breakers after clearing, got %d", len(states))
		}
	})
	
	t.Run("should handle context cancellation", func(t *testing.T) {
		eh := NewErrorHandler()
		ctx, cancel := context.WithCancel(context.Background())
		
		// Cancel context immediately
		cancel()
		
		operations := []func() error{
			func() error {
				time.Sleep(100 * time.Millisecond)
				return nil
			},
		}
		
		context := ErrorContext{
			Component: "test",
			Operation: "test_cancel",
		}
		
		options := FallbackOptions{
			MaxRetries: 2,
		}
		
		err := eh.WithFallback(ctx, operations, context, options)
		
		if err == nil {
			t.Errorf("Expected error due to context cancellation")
		}
		if err.Error() != "context canceled" {
			t.Errorf("Expected context canceled error, got %v", err)
		}
	})
}

// TestErrorTypes tests specific error types
func TestErrorTypes(t *testing.T) {
	t.Run("EmbeddingServiceError", func(t *testing.T) {
		cause := fmt.Errorf("network timeout")
		err := NewEmbeddingServiceError("Failed to get embeddings", cause)
		
		expected := "EmbeddingServiceError: Failed to get embeddings (caused by: network timeout)"
		if err.Error() != expected {
			t.Errorf("Expected %s, got %s", expected, err.Error())
		}
		
		if err.Unwrap() != cause {
			t.Errorf("Expected unwrapped error to be cause")
		}
	})
	
	t.Run("EmbeddingServiceError without cause", func(t *testing.T) {
		err := NewEmbeddingServiceError("Service unavailable", nil)
		
		expected := "EmbeddingServiceError: Service unavailable"
		if err.Error() != expected {
			t.Errorf("Expected %s, got %s", expected, err.Error())
		}
		
		if err.Unwrap() != nil {
			t.Errorf("Expected unwrapped error to be nil")
		}
	})
	
	t.Run("FAISSError", func(t *testing.T) {
		cause := fmt.Errorf("index not found")
		err := NewFAISSError("FAISS operation failed", cause)
		
		expected := "FAISSError: FAISS operation failed (caused by: index not found)"
		if err.Error() != expected {
			t.Errorf("Expected %s, got %s", expected, err.Error())
		}
		
		if err.Unwrap() != cause {
			t.Errorf("Expected unwrapped error to be cause")
		}
	})
	
	t.Run("OpenRouterError", func(t *testing.T) {
		cause := fmt.Errorf("HTTP request failed")
		err := NewOpenRouterError("Request failed", 429, cause)
		
		expected := "OpenRouterError: Request failed (status: 429, caused by: HTTP request failed)"
		if err.Error() != expected {
			t.Errorf("Expected %s, got %s", expected, err.Error())
		}
		
		if err.StatusCode != 429 {
			t.Errorf("Expected status code 429, got %d", err.StatusCode)
		}
		
		if err.Unwrap() != cause {
			t.Errorf("Expected unwrapped error to be cause")
		}
	})
	
	t.Run("OpenRouterError without cause", func(t *testing.T) {
		err := NewOpenRouterError("Rate limited", 429, nil)
		
		expected := "OpenRouterError: Rate limited (status: 429)"
		if err.Error() != expected {
			t.Errorf("Expected %s, got %s", expected, err.Error())
		}
	})
	
	t.Run("ArtifactLoadError", func(t *testing.T) {
		cause := fmt.Errorf("file not found")
		err := NewArtifactLoadError("Failed to load model", cause)
		
		expected := "ArtifactLoadError: Failed to load model (caused by: file not found)"
		if err.Error() != expected {
			t.Errorf("Expected %s, got %s", expected, err.Error())
		}
		
		if err.Unwrap() != cause {
			t.Errorf("Expected unwrapped error to be cause")
		}
	})
}

// TestErrorUtils tests the ErrorUtils functionality
func TestErrorUtils(t *testing.T) {
	utils := ErrorUtils{}
	
	t.Run("IsRetryable should identify retryable errors", func(t *testing.T) {
		testCases := []struct {
			error    error
			expected bool
		}{
			{fmt.Errorf("connection timeout"), true},
			{fmt.Errorf("network unreachable"), true},
			{fmt.Errorf("HTTP 503 Service Unavailable"), true},
			{fmt.Errorf("HTTP 500 Internal Server Error"), true},
			{fmt.Errorf("HTTP 429 Too Many Requests"), true},
			{fmt.Errorf("HTTP 400 Bad Request"), false},
			{fmt.Errorf("invalid input"), false},
			{nil, false},
		}
		
		for _, tc := range testCases {
			result := utils.IsRetryable(tc.error)
			if result != tc.expected {
				t.Errorf("IsRetryable(%v) = %t, expected %t", tc.error, result, tc.expected)
			}
		}
	})
	
	t.Run("GetStatusCode should extract status codes", func(t *testing.T) {
		testCases := []struct {
			error    error
			expected *int
		}{
			{fmt.Errorf("HTTP 404 Not Found"), intPtr(404)},
			{fmt.Errorf("received 500 from server"), intPtr(500)},
			{NewOpenRouterError("Test", 429, nil), intPtr(429)},
			{fmt.Errorf("no status code here"), nil},
			{nil, nil},
		}
		
		for _, tc := range testCases {
			result := utils.GetStatusCode(tc.error)
			if (result == nil) != (tc.expected == nil) {
				t.Errorf("GetStatusCode(%v) = %v, expected %v", tc.error, result, tc.expected)
			}
			if result != nil && tc.expected != nil && *result != *tc.expected {
				t.Errorf("GetStatusCode(%v) = %d, expected %d", tc.error, *result, *tc.expected)
			}
		}
	})
	
	t.Run("CreateDegradedResponse should return fallback value", func(t *testing.T) {
		fallback := "default_response"
		reason := "primary service unavailable"
		
		result := utils.CreateDegradedResponse(fallback, reason)
		
		if result != fallback {
			t.Errorf("Expected %v, got %v", fallback, result)
		}
	})
	
	t.Run("IsNetworkError should identify network errors", func(t *testing.T) {
		testCases := []struct {
			error    error
			expected bool
		}{
			{fmt.Errorf("connection refused"), true},
			{fmt.Errorf("no such host"), true},
			{fmt.Errorf("dial tcp: timeout"), true},
			{fmt.Errorf("i/o timeout"), true},
			{fmt.Errorf("invalid input"), false},
			{nil, false},
		}
		
		for _, tc := range testCases {
			result := utils.IsNetworkError(tc.error)
			if result != tc.expected {
				t.Errorf("IsNetworkError(%v) = %t, expected %t", tc.error, result, tc.expected)
			}
		}
	})
	
	t.Run("IsTemporaryError should check temporary errors", func(t *testing.T) {
		testCases := []struct {
			error    error
			expected bool
		}{
			{fmt.Errorf("timeout occurred"), true},
			{fmt.Errorf("HTTP 503 error"), true},
			{fmt.Errorf("invalid syntax"), false},
			{nil, false},
		}
		
		for _, tc := range testCases {
			result := utils.IsTemporaryError(tc.error)
			if result != tc.expected {
				t.Errorf("IsTemporaryError(%v) = %t, expected %t", tc.error, result, tc.expected)
			}
		}
	})
	
	t.Run("WrapWithContext should add context to errors", func(t *testing.T) {
		originalErr := fmt.Errorf("original error")
		context := ErrorContext{
			Component: "test_component",
			Operation: "test_operation",
		}
		
		wrappedErr := utils.WrapWithContext(originalErr, context)
		
		expected := "error in test_component.test_operation: original error"
		if wrappedErr.Error() != expected {
			t.Errorf("Expected %s, got %s", expected, wrappedErr.Error())
		}
		
		// Test with nil error
		nilWrapped := utils.WrapWithContext(nil, context)
		if nilWrapped != nil {
			t.Errorf("Expected nil when wrapping nil error, got %v", nilWrapped)
		}
	})
	
	t.Run("ChainErrors should combine multiple errors", func(t *testing.T) {
		errors := []error{
			fmt.Errorf("first error"),
			fmt.Errorf("second error"),
			nil, // Should be ignored
			fmt.Errorf("third error"),
		}
		
		chained := utils.ChainErrors(errors)
		
		if chained == nil {
			t.Errorf("Expected chained error, got nil")
		}
		
		expected := "multiple errors occurred: [1] first error; [2] second error; [3] third error"
		if chained.Error() != expected {
			t.Errorf("Expected %s, got %s", expected, chained.Error())
		}
		
		// Test with single error
		singleError := utils.ChainErrors([]error{fmt.Errorf("single error")})
		if singleError.Error() != "single error" {
			t.Errorf("Expected single error, got %s", singleError.Error())
		}
		
		// Test with no errors
		noErrors := utils.ChainErrors([]error{nil, nil})
		if noErrors != nil {
			t.Errorf("Expected nil for no valid errors, got %v", noErrors)
		}
	})
}

// TestGlobalErrorHandlerFunctions tests the global convenience functions
func TestGlobalErrorHandlerFunctions(t *testing.T) {
	// Clear any existing state
	ClearCircuitBreakers()
	
	t.Run("WithFallback should work with global handler", func(t *testing.T) {
		ctx := context.Background()
		
		callCount := 0
		operations := []func() error{
			func() error {
				callCount++
				return nil
			},
		}
		
		context := ErrorContext{
			Component: "global_test",
			Operation: "test_fallback",
		}
		
		options := FallbackOptions{
			MaxRetries: 1,
		}
		
		err := WithFallback(ctx, operations, context, options)
		
		if err != nil {
			t.Errorf("Expected no error, got %v", err)
		}
		if callCount != 1 {
			t.Errorf("Expected 1 call, got %d", callCount)
		}
	})
	
	t.Run("WithCircuitBreaker should work with global handler", func(t *testing.T) {
		ctx := context.Background()
		
		callCount := 0
		operation := func() error {
			callCount++
			return nil
		}
		
		context := ErrorContext{
			Component: "global_test",
			Operation: "test_circuit",
		}
		
		err := WithCircuitBreaker(ctx, operation, context)
		
		if err != nil {
			t.Errorf("Expected no error, got %v", err)
		}
		if callCount != 1 {
			t.Errorf("Expected 1 call, got %d", callCount)
		}
		
		// Check that circuit breaker was created
		states := GetCircuitBreakerStates()
		if len(states) != 1 {
			t.Errorf("Expected 1 circuit breaker, got %d", len(states))
		}
		
		if states["global_test.test_circuit"] != "closed" {
			t.Errorf("Expected closed state, got %s", states["global_test.test_circuit"])
		}
		
		// Clear and verify
		ClearCircuitBreakers()
		states = GetCircuitBreakerStates()
		if len(states) != 0 {
			t.Errorf("Expected 0 circuit breakers after clear, got %d", len(states))
		}
	})
}

// Helper function for tests
func intPtr(i int) *int {
	return &i
}