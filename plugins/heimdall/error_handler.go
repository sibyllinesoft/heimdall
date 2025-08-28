package main

import (
	"context"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ErrorContext represents the context for error handling
type ErrorContext struct {
	Component string                 `json:"component"`
	Operation string                 `json:"operation"`
	Metadata  map[string]interface{} `json:"metadata,omitempty"`
}

// FallbackOptions represents options for fallback operations
type FallbackOptions struct {
	MaxRetries     int                    `json:"max_retries,omitempty"`
	RetryDelay     time.Duration          `json:"retry_delay,omitempty"`
	Timeout        time.Duration          `json:"timeout,omitempty"`
	FallbackValues []interface{}          `json:"fallback_values,omitempty"`
}

// CircuitBreakerState represents the state of a circuit breaker
type CircuitBreakerState string

const (
	CircuitBreakerClosed   CircuitBreakerState = "closed"
	CircuitBreakerOpen     CircuitBreakerState = "open"
	CircuitBreakerHalfOpen CircuitBreakerState = "half-open"
)

// CircuitBreaker implements circuit breaker pattern for external services
type CircuitBreaker struct {
	mutex           sync.RWMutex
	failures        int
	lastFailureTime time.Time
	state           CircuitBreakerState
	threshold       int
	resetTimeout    time.Duration
}

// NewCircuitBreaker creates a new circuit breaker
func NewCircuitBreaker(threshold int, resetTimeout time.Duration) *CircuitBreaker {
	if threshold <= 0 {
		threshold = 5
	}
	if resetTimeout <= 0 {
		resetTimeout = time.Minute
	}
	
	return &CircuitBreaker{
		threshold:    threshold,
		resetTimeout: resetTimeout,
		state:        CircuitBreakerClosed,
	}
}

// Execute runs an operation through the circuit breaker
func (cb *CircuitBreaker) Execute(ctx context.Context, operation func() error) error {
	cb.mutex.Lock()
	
	if cb.state == CircuitBreakerOpen {
		if time.Since(cb.lastFailureTime) > cb.resetTimeout {
			cb.state = CircuitBreakerHalfOpen
		} else {
			cb.mutex.Unlock()
			return fmt.Errorf("circuit breaker is open")
		}
	}
	
	cb.mutex.Unlock()
	
	// Execute the operation
	err := operation()
	
	cb.mutex.Lock()
	defer cb.mutex.Unlock()
	
	if err != nil {
		cb.onFailure()
		return err
	}
	
	cb.onSuccess()
	return nil
}

// GetState returns the current state of the circuit breaker
func (cb *CircuitBreaker) GetState() CircuitBreakerState {
	cb.mutex.RLock()
	defer cb.mutex.RUnlock()
	return cb.state
}

// onSuccess resets the circuit breaker on successful operation
func (cb *CircuitBreaker) onSuccess() {
	cb.failures = 0
	cb.state = CircuitBreakerClosed
}

// onFailure handles operation failures
func (cb *CircuitBreaker) onFailure() {
	cb.failures++
	cb.lastFailureTime = time.Now()
	
	if cb.failures >= cb.threshold {
		cb.state = CircuitBreakerOpen
	}
}

// ErrorHandler provides centralized error handling and fallback mechanisms
type ErrorHandler struct {
	circuitBreakers sync.Map // map[string]*CircuitBreaker
}

// NewErrorHandler creates a new error handler
func NewErrorHandler() *ErrorHandler {
	return &ErrorHandler{}
}

// GlobalErrorHandler is the default instance
var GlobalErrorHandler = NewErrorHandler()

// WithFallback executes operations with fallback chain
func (eh *ErrorHandler) WithFallback(
	ctx context.Context,
	operations []func() error,
	errorContext ErrorContext,
	options FallbackOptions,
) error {
	// Set defaults
	if options.MaxRetries == 0 {
		options.MaxRetries = 2
	}
	if options.RetryDelay == 0 {
		options.RetryDelay = 100 * time.Millisecond
	}
	if options.Timeout == 0 {
		options.Timeout = 30 * time.Second
	}
	
	var lastError error
	
	for i, operation := range operations {
		if operation == nil {
			continue
		}
		
		for retry := 0; retry <= options.MaxRetries; retry++ {
			// Create a timeout context
			operationCtx, cancel := context.WithTimeout(ctx, options.Timeout)
			
			err := eh.executeWithTimeout(operationCtx, operation)
			cancel()
			
			if err == nil {
				if i > 0 {
					fmt.Printf("%s.%s: Succeeded with fallback #%d\n", 
						errorContext.Component, errorContext.Operation, i)
				}
				return nil
			}
			
			lastError = err
			
			fmt.Printf("%s.%s: Attempt %d/%d failed: %v\n",
				errorContext.Component, errorContext.Operation, retry+1, options.MaxRetries+1, err)
			
			// Wait before retry (unless it's the last retry)
			if retry < options.MaxRetries {
				delay := time.Duration(float64(options.RetryDelay) * math.Pow(2, float64(retry)))
				select {
				case <-time.After(delay):
				case <-ctx.Done():
					return ctx.Err()
				}
			}
		}
		
		// All retries for this operation failed, try next fallback
		fmt.Printf("%s.%s: Operation %d failed after %d attempts\n",
			errorContext.Component, errorContext.Operation, i+1, options.MaxRetries+1)
	}
	
	// All operations failed
	err := fmt.Errorf("all fallback operations failed for %s.%s. Last error: %v",
		errorContext.Component, errorContext.Operation, lastError)
	
	eh.logError(err, errorContext)
	return err
}

// WithCircuitBreaker executes operation with circuit breaker protection
func (eh *ErrorHandler) WithCircuitBreaker(
	ctx context.Context,
	operation func() error,
	errorContext ErrorContext,
) error {
	key := fmt.Sprintf("%s.%s", errorContext.Component, errorContext.Operation)
	
	// Get or create circuit breaker
	breakerInterface, _ := eh.circuitBreakers.LoadOrStore(key, NewCircuitBreaker(5, time.Minute))
	breaker := breakerInterface.(*CircuitBreaker)
	
	return breaker.Execute(ctx, operation)
}

// executeWithTimeout executes operation with timeout
func (eh *ErrorHandler) executeWithTimeout(ctx context.Context, operation func() error) error {
	errChan := make(chan error, 1)
	
	go func() {
		errChan <- operation()
	}()
	
	select {
	case err := <-errChan:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// logError logs error with context
func (eh *ErrorHandler) logError(err error, errorContext ErrorContext) {
	fmt.Println("=== ERROR REPORT ===")
	fmt.Printf("Component: %s\n", errorContext.Component)
	fmt.Printf("Operation: %s\n", errorContext.Operation)
	fmt.Printf("Error: %s\n", err.Error())
	if errorContext.Metadata != nil && len(errorContext.Metadata) > 0 {
		fmt.Printf("Metadata: %+v\n", errorContext.Metadata)
	}
	fmt.Println("==================")
}

// GetCircuitBreakerStates returns states of all circuit breakers
func (eh *ErrorHandler) GetCircuitBreakerStates() map[string]string {
	states := make(map[string]string)
	
	eh.circuitBreakers.Range(func(key, value interface{}) bool {
		keyStr := key.(string)
		breaker := value.(*CircuitBreaker)
		states[keyStr] = string(breaker.GetState())
		return true
	})
	
	return states
}

// ClearCircuitBreakers clears all circuit breakers (for testing)
func (eh *ErrorHandler) ClearCircuitBreakers() {
	eh.circuitBreakers = sync.Map{}
}

// Static methods for global error handler
func WithFallback(
	ctx context.Context,
	operations []func() error,
	errorContext ErrorContext,
	options FallbackOptions,
) error {
	return GlobalErrorHandler.WithFallback(ctx, operations, errorContext, options)
}

func WithCircuitBreaker(
	ctx context.Context,
	operation func() error,
	errorContext ErrorContext,
) error {
	return GlobalErrorHandler.WithCircuitBreaker(ctx, operation, errorContext)
}

func GetCircuitBreakerStates() map[string]string {
	return GlobalErrorHandler.GetCircuitBreakerStates()
}

func ClearCircuitBreakers() {
	GlobalErrorHandler.ClearCircuitBreakers()
}

// Specific error types for better handling
type EmbeddingServiceError struct {
	Message string
	Cause   error
}

func (e EmbeddingServiceError) Error() string {
	if e.Cause != nil {
		return fmt.Sprintf("EmbeddingServiceError: %s (caused by: %v)", e.Message, e.Cause)
	}
	return fmt.Sprintf("EmbeddingServiceError: %s", e.Message)
}

func (e EmbeddingServiceError) Unwrap() error {
	return e.Cause
}

func NewEmbeddingServiceError(message string, cause error) *EmbeddingServiceError {
	return &EmbeddingServiceError{
		Message: message,
		Cause:   cause,
	}
}

type FAISSError struct {
	Message string
	Cause   error
}

func (e FAISSError) Error() string {
	if e.Cause != nil {
		return fmt.Sprintf("FAISSError: %s (caused by: %v)", e.Message, e.Cause)
	}
	return fmt.Sprintf("FAISSError: %s", e.Message)
}

func (e FAISSError) Unwrap() error {
	return e.Cause
}

func NewFAISSError(message string, cause error) *FAISSError {
	return &FAISSError{
		Message: message,
		Cause:   cause,
	}
}

type OpenRouterError struct {
	Message    string
	StatusCode int
	Cause      error
}

func (e OpenRouterError) Error() string {
	if e.Cause != nil {
		return fmt.Sprintf("OpenRouterError: %s (status: %d, caused by: %v)", e.Message, e.StatusCode, e.Cause)
	}
	return fmt.Sprintf("OpenRouterError: %s (status: %d)", e.Message, e.StatusCode)
}

func (e OpenRouterError) Unwrap() error {
	return e.Cause
}

func NewOpenRouterError(message string, statusCode int, cause error) *OpenRouterError {
	return &OpenRouterError{
		Message:    message,
		StatusCode: statusCode,
		Cause:      cause,
	}
}

type ArtifactLoadError struct {
	Message string
	Cause   error
}

func (e ArtifactLoadError) Error() string {
	if e.Cause != nil {
		return fmt.Sprintf("ArtifactLoadError: %s (caused by: %v)", e.Message, e.Cause)
	}
	return fmt.Sprintf("ArtifactLoadError: %s", e.Message)
}

func (e ArtifactLoadError) Unwrap() error {
	return e.Cause
}

func NewArtifactLoadError(message string, cause error) *ArtifactLoadError {
	return &ArtifactLoadError{
		Message: message,
		Cause:   cause,
	}
}

// ErrorUtils provides utility functions for common error scenarios
type ErrorUtils struct{}

// IsRetryable checks if an error is retryable
func (ErrorUtils) IsRetryable(err error) bool {
	if err == nil {
		return false
	}
	
	message := err.Error()
	
	retryablePatterns := []*regexp.Regexp{
		regexp.MustCompile(`(?i)timeout`),
		regexp.MustCompile(`(?i)network`),
		regexp.MustCompile(`(?i)connection`),
		regexp.MustCompile(`\b503\b`),
		regexp.MustCompile(`\b502\b`),
		regexp.MustCompile(`\b500\b`),
		regexp.MustCompile(`\b429\b`), // Rate limit - can retry with backoff
	}
	
	for _, pattern := range retryablePatterns {
		if pattern.MatchString(message) {
			return true
		}
	}
	
	return false
}

// GetStatusCode extracts status code from error message
func (ErrorUtils) GetStatusCode(err error) *int {
	if err == nil {
		return nil
	}
	
	// Check if it's an OpenRouterError with status code
	if openRouterErr, ok := err.(*OpenRouterError); ok {
		return &openRouterErr.StatusCode
	}
	
	// Try to extract from error message
	statusRegex := regexp.MustCompile(`\b(\d{3})\b`)
	matches := statusRegex.FindStringSubmatch(err.Error())
	
	if len(matches) > 1 {
		if statusCode, parseErr := strconv.Atoi(matches[1]); parseErr == nil {
			return &statusCode
		}
	}
	
	return nil
}

// CreateDegradedResponse creates a degraded service response
func (ErrorUtils) CreateDegradedResponse(fallbackValue interface{}, reason string) interface{} {
	fmt.Printf("Using degraded response: %s\n", reason)
	return fallbackValue
}

// IsNetworkError checks if error is network-related
func (ErrorUtils) IsNetworkError(err error) bool {
	if err == nil {
		return false
	}
	
	message := strings.ToLower(err.Error())
	networkPatterns := []string{
		"connection refused",
		"no such host",
		"network unreachable",
		"connection reset",
		"connection timeout",
		"dial tcp",
		"i/o timeout",
	}
	
	for _, pattern := range networkPatterns {
		if strings.Contains(message, pattern) {
			return true
		}
	}
	
	return false
}

// IsTemporaryError checks if error is temporary
func (ErrorUtils) IsTemporaryError(err error) bool {
	if err == nil {
		return false
	}
	
	// Check if error implements temporary interface
	type temporary interface {
		Temporary() bool
	}
	
	if tempErr, ok := err.(temporary); ok {
		return tempErr.Temporary()
	}
	
	// Fall back to checking if it's retryable
	return ErrorUtils{}.IsRetryable(err)
}

// WrapWithContext wraps an error with additional context
func (ErrorUtils) WrapWithContext(err error, errorContext ErrorContext) error {
	if err == nil {
		return nil
	}
	
	return fmt.Errorf("error in %s.%s: %w", errorContext.Component, errorContext.Operation, err)
}

// ChainErrors combines multiple errors into a single error
func (ErrorUtils) ChainErrors(errors []error) error {
	var validErrors []error
	
	for _, err := range errors {
		if err != nil {
			validErrors = append(validErrors, err)
		}
	}
	
	if len(validErrors) == 0 {
		return nil
	}
	
	if len(validErrors) == 1 {
		return validErrors[0]
	}
	
	var messages []string
	for i, err := range validErrors {
		messages = append(messages, fmt.Sprintf("[%d] %s", i+1, err.Error()))
	}
	
	return fmt.Errorf("multiple errors occurred: %s", strings.Join(messages, "; "))
}