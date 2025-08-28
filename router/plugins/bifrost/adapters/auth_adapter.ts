/**
 * AuthAdapter interface for modular authentication handling
 */

import { AuthInfo } from '../../../../src/types/common.js';

export interface AuthAdapter {
  readonly id: string;
  
  /**
   * Check if this adapter can handle the given request headers
   */
  matches(reqHeaders: Record<string, string | string[]>): boolean;
  
  /**
   * Extract authentication info from request headers
   */
  extract(reqHeaders: Record<string, string | string[]>): AuthInfo | null;
  
  /**
   * Apply authentication to outgoing request
   */
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
  };
  
  /**
   * Optional token validation for health checks
   */
  validate?(token: string): Promise<boolean>;
}

/**
 * Registry for managing auth adapters
 */
export class AuthAdapterRegistry {
  private adapters = new Map<string, AuthAdapter>();
  
  register(adapter: AuthAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }
  
  get(id: string): AuthAdapter | undefined {
    return this.adapters.get(id);
  }
  
  /**
   * Find the first adapter that matches the request headers
   */
  findMatch(headers: Record<string, string | string[]>): AuthAdapter | null {
    for (const adapter of this.adapters.values()) {
      if (adapter.matches(headers)) {
        return adapter;
      }
    }
    return null;
  }
  
  getEnabled(enabledIds: string[]): AuthAdapter[] {
    return enabledIds
      .map(id => this.adapters.get(id))
      .filter((adapter): adapter is AuthAdapter => adapter !== undefined);
  }
}