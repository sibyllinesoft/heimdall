/**
 * Anthropic OAuth Adapter for Claude Code integration
 * Handles Bearer tokens from Anthropic OAuth flow
 * Enhanced for Milestone 4 with 429 handling and cooldown management
 */

import { AuthAdapter } from './auth_adapter.js';
import { AuthInfo } from '../../../../src/types/common.js';

export interface UserCooldown {
  user_id: string;
  expires_at: number;
  retry_after?: number;
  reason: string;
}

export class AnthropicOAuthAdapter implements AuthAdapter {
  readonly id = 'anthropic-oauth';
  
  // Cooldown tracking for 429 responses
  private cooldowns = new Map<string, UserCooldown>();
  
  matches(reqHeaders: Record<string, string | string[]>): boolean {
    const authorization = this.getHeader(reqHeaders, 'authorization');
    if (!authorization) return false;
    
    // Check for Bearer token that looks like Anthropic OAuth
    const bearerMatch = authorization.match(/^Bearer\s+(.+)$/);
    if (!bearerMatch) return false;
    
    const token = bearerMatch[1];
    // Anthropic OAuth tokens typically start with 'ant-' or have specific patterns
    // This is a heuristic - in production you'd have more specific validation
    return token.startsWith('ant-') || this.looksLikeAnthropicToken(token);
  }
  
  extract(reqHeaders: Record<string, string | string[]>): AuthInfo | null {
    const authorization = this.getHeader(reqHeaders, 'authorization');
    if (!authorization) return null;
    
    const bearerMatch = authorization.match(/^Bearer\s+(.+)$/);
    if (!bearerMatch) return null;
    
    return {
      provider: 'anthropic',
      type: 'bearer',
      token: bearerMatch[1]
    };
  }
  
  apply(outgoing: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: unknown;
  }): {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: unknown;
  } {
    // For Anthropic, we forward the bearer token as-is
    // The URL should already be set to Anthropic's API endpoint
    return {
      ...outgoing,
      headers: {
        ...outgoing.headers,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      }
    };
  }
  
  async validate(token: string): Promise<boolean> {
    try {
      // Make a lightweight request to verify the token
      const response = await fetch('https://api.anthropic.com/v1/models', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'anthropic-version': '2023-06-01'
        }
      });
      return response.ok;
    } catch {
      return false;
    }
  }
  
  private getHeader(headers: Record<string, string | string[]>, name: string): string | null {
    const value = headers[name] || headers[name.toLowerCase()];
    if (Array.isArray(value)) {
      return value[0] || null;
    }
    return value || null;
  }
  
  private looksLikeAnthropicToken(token: string): boolean {
    // Additional heuristics for identifying Anthropic tokens
    // This is a placeholder - implement based on actual token patterns
    return token.length > 50 && /^[A-Za-z0-9_-]+$/.test(token);
  }
  
  /**
   * Enhanced 429 handling and cooldown management for Milestone 4
   */
  
  /**
   * Check if user is currently on cooldown
   */
  isUserOnCooldown(userId: string): boolean {
    const cooldown = this.cooldowns.get(userId);
    if (!cooldown) return false;
    
    if (Date.now() < cooldown.expires_at) {
      return true;
    }
    
    // Expired cooldown - remove it
    this.cooldowns.delete(userId);
    return false;
  }
  
  /**
   * Apply cooldown to user (called after 429 error)
   */
  applyCooldown(
    userId: string, 
    durationMs: number = 3 * 60 * 1000, // Default 3 minutes
    reason: string = 'rate_limit_429'
  ): void {
    // Cap cooldown at 5 minutes as per TODO.md
    const cappedDuration = Math.min(durationMs, 5 * 60 * 1000);
    
    this.cooldowns.set(userId, {
      user_id: userId,
      expires_at: Date.now() + cappedDuration,
      retry_after: Math.floor(cappedDuration / 1000),
      reason
    });
    
    console.log(`Applied ${Math.floor(cappedDuration / 1000)}s cooldown to user ${userId}: ${reason}`);
  }
  
  /**
   * Get cooldown info for user
   */
  getCooldownInfo(userId: string): UserCooldown | null {
    const cooldown = this.cooldowns.get(userId);
    if (!cooldown || cooldown.expires_at <= Date.now()) {
      return null;
    }
    return { ...cooldown };
  }
  
  /**
   * Clear cooldown for user (admin function)
   */
  clearCooldown(userId: string): boolean {
    return this.cooldowns.delete(userId);
  }
  
  /**
   * Get all active cooldowns (monitoring)
   */
  getActiveCooldowns(): UserCooldown[] {
    const now = Date.now();
    const active: UserCooldown[] = [];
    
    for (const [userId, cooldown] of Array.from(this.cooldowns.entries())) {
      if (cooldown.expires_at > now) {
        active.push({ ...cooldown });
      } else {
        // Clean up expired entries
        this.cooldowns.delete(userId);
      }
    }
    
    return active;
  }
  
  /**
   * Extract user ID from token or request headers
   */
  extractUserId(authInfo: AuthInfo, headers?: Record<string, string | string[]>): string {
    // Try to get user ID from custom header first
    if (headers) {
      const userId = this.getHeader(headers, 'x-user-id') || 
                    this.getHeader(headers, 'user-id');
      if (userId) {
        return userId;
      }
    }
    
    // Fallback to token-based ID
    return this.extractUserIdFromToken(authInfo.token);
  }
  
  private extractUserIdFromToken(token: string): string {
    // Simple hash for user identification
    // In production, you'd decode the JWT or use a more robust method
    let hash = 0;
    for (let i = 0; i < token.length; i++) {
      const char = token.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return `user_${Math.abs(hash).toString()}`;
  }
  
  /**
   * Enhanced matches method that checks cooldowns
   */
  matchesWithCooldownCheck(
    reqHeaders: Record<string, string | string[]>
  ): { matches: boolean; onCooldown?: boolean; cooldownInfo?: UserCooldown } {
    // First check if it matches normally
    const normalMatch = this.matches(reqHeaders);
    if (!normalMatch) {
      return { matches: false };
    }
    
    // Extract auth info to check cooldown
    const authInfo = this.extract(reqHeaders);
    if (!authInfo) {
      return { matches: false };
    }
    
    const userId = this.extractUserId(authInfo, reqHeaders);
    const cooldownInfo = this.getCooldownInfo(userId);
    
    return {
      matches: true,
      onCooldown: cooldownInfo !== null,
      cooldownInfo: cooldownInfo || undefined
    };
  }
  
  /**
   * Check if a request should be blocked due to cooldown
   */
  shouldBlockRequest(reqHeaders: Record<string, string | string[]>): {
    blocked: boolean;
    reason?: string;
    retry_after?: number;
  } {
    const authInfo = this.extract(reqHeaders);
    if (!authInfo) {
      return { blocked: false };
    }
    
    const userId = this.extractUserId(authInfo, reqHeaders);
    const cooldown = this.getCooldownInfo(userId);
    
    if (cooldown) {
      return {
        blocked: true,
        reason: `User on cooldown: ${cooldown.reason}`,
        retry_after: cooldown.retry_after
      };
    }
    
    return { blocked: false };
  }
  
  /**
   * Get cooldown statistics for monitoring
   */
  getCooldownStats(): {
    active_cooldowns: number;
    total_users_affected: number;
    average_cooldown_remaining_ms: number;
    cooldown_reasons: Record<string, number>;
  } {
    const activeCooldowns = this.getActiveCooldowns();
    const now = Date.now();
    
    const reasonCounts: Record<string, number> = {};
    let totalRemainingTime = 0;
    
    for (const cooldown of activeCooldowns) {
      reasonCounts[cooldown.reason] = (reasonCounts[cooldown.reason] || 0) + 1;
      totalRemainingTime += Math.max(0, cooldown.expires_at - now);
    }
    
    return {
      active_cooldowns: activeCooldowns.length,
      total_users_affected: activeCooldowns.length,
      average_cooldown_remaining_ms: activeCooldowns.length > 0 
        ? totalRemainingTime / activeCooldowns.length 
        : 0,
      cooldown_reasons: reasonCounts
    };
  }
}