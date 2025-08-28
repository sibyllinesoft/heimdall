/**
 * Automated Catalog Refresh System - Milestone 6
 * 
 * Handles nightly scheduled refresh of model catalog with:
 * - OpenRouter, OpenAI GPT-5, Gemini model updates
 * - Price and capability change detection
 * - Automatic artifact invalidation on drift
 */

export interface CatalogRefreshConfig {
  schedule: {
    nightly_refresh_hour: number;  // UTC hour for nightly refresh
    drift_check_interval_hours: number; // How often to check for drift
  };
  thresholds: {
    price_change_percentage: number; // % change to trigger invalidation
    capability_change_threshold: number; // Significant capability change
    context_limit_change_threshold: number; // Context window change threshold
  };
  endpoints: {
    catalog_service_url: string;
    artifact_store_url: string;
    notification_webhook?: string;
  };
  artifact_invalidation: {
    enabled: boolean;
    backup_count: number; // Number of backup artifacts to keep
  };
}

export interface ModelChange {
  model_slug: string;
  provider: string;
  change_type: 'price' | 'capability' | 'context' | 'availability';
  old_value: any;
  new_value: any;
  change_magnitude: number; // 0-1 severity score
  timestamp: string;
}

export interface RefreshResult {
  timestamp: string;
  duration_ms: number;
  models_checked: number;
  changes_detected: ModelChange[];
  artifacts_invalidated: string[];
  next_scheduled_refresh: string;
  status: 'success' | 'partial_failure' | 'failure';
  errors?: string[];
}

export class CatalogRefresher {
  private config: CatalogRefreshConfig;
  private refreshTimer?: NodeJS.Timeout;
  private driftCheckTimer?: NodeJS.Timeout;
  private isRunning = false;
  
  constructor(config: Partial<CatalogRefreshConfig> = {}) {
    this.config = this.mergeDefaultConfig(config);
  }
  
  /**
   * Start the automated catalog refresh system
   */
  start(): void {
    if (this.isRunning) {
      console.warn('Catalog refresher already running');
      return;
    }
    
    console.log('🔄 Starting Catalog Refresher...');
    
    // Schedule nightly refreshes
    this.scheduleNightlyRefresh();
    
    // Schedule drift checks
    this.scheduleDriftChecks();
    
    this.isRunning = true;
    console.log('✅ Catalog Refresher started successfully');
  }
  
  /**
   * Stop the automated catalog refresh system
   */
  stop(): void {
    if (!this.isRunning) return;
    
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    
    if (this.driftCheckTimer) {
      clearInterval(this.driftCheckTimer);
      this.driftCheckTimer = undefined;
    }
    
    this.isRunning = false;
    console.log('🛑 Catalog Refresher stopped');
  }
  
  /**
   * Perform complete catalog refresh with change detection
   */
  async performFullRefresh(): Promise<RefreshResult> {
    const startTime = Date.now();
    const timestamp = new Date().toISOString();
    
    console.log('🔄 Starting full catalog refresh...');
    
    const result: RefreshResult = {
      timestamp,
      duration_ms: 0,
      models_checked: 0,
      changes_detected: [],
      artifacts_invalidated: [],
      next_scheduled_refresh: this.getNextScheduledRefreshTime(),
      status: 'success',
      errors: []
    };
    
    try {
      // 1. Fetch current catalog state
      console.log('📊 Fetching current catalog state...');
      const currentCatalog = await this.fetchCurrentCatalog();
      
      // 2. Refresh each provider
      console.log('🔄 Refreshing provider data...');
      const providerResults = await Promise.allSettled([
        this.refreshOpenRouterModels(),
        this.refreshOpenAIModels(), 
        this.refreshGeminiModels()
      ]);
      
      // Process results and detect changes
      let updatedCatalog: any = {};
      let allChanges: ModelChange[] = [];
      
      providerResults.forEach((resultWrapper, index) => {
        const providers = ['openrouter', 'openai', 'gemini'];
        const provider = providers[index];
        
        if (resultWrapper.status === 'fulfilled') {
          const providerResult = resultWrapper.value;
          updatedCatalog[provider] = providerResult.models;
          
          // Detect changes for this provider
          const changes = this.detectChanges(
            currentCatalog[provider] || [],
            providerResult.models,
            provider
          );
          allChanges.push(...changes);
          
        } else {
          console.error(`❌ Failed to refresh ${provider}:`, resultWrapper.reason);
          result.errors?.push(`Failed to refresh ${provider}: ${resultWrapper.reason}`);
          result.status = result.status === 'success' ? 'partial_failure' : 'failure';
        }
      });
      
      // 3. Update catalog if changes detected
      if (allChanges.length > 0) {
        console.log(`📝 Detected ${allChanges.length} model changes`);
        await this.updateCatalogService(updatedCatalog);
        result.changes_detected = allChanges;
        
        // 4. Check if artifacts need invalidation
        const significantChanges = allChanges.filter(
          change => change.change_magnitude >= 0.3
        );
        
        if (significantChanges.length > 0 && this.config.artifact_invalidation.enabled) {
          console.log('🚨 Significant changes detected - invalidating artifacts...');
          const invalidatedArtifacts = await this.invalidateArtifacts(significantChanges);
          result.artifacts_invalidated = invalidatedArtifacts;
        }
      }
      
      // 5. Send notifications if configured
      if (allChanges.length > 0 && this.config.endpoints.notification_webhook) {
        await this.sendNotification(result);
      }
      
      result.models_checked = this.countTotalModels(updatedCatalog);
      result.duration_ms = Date.now() - startTime;
      
      console.log(`✅ Catalog refresh complete (${result.duration_ms}ms)`);
      console.log(`📊 Models checked: ${result.models_checked}`);
      console.log(`📝 Changes detected: ${result.changes_detected.length}`);
      console.log(`🗑️ Artifacts invalidated: ${result.artifacts_invalidated.length}`);
      
    } catch (error) {
      result.status = 'failure';
      result.duration_ms = Date.now() - startTime;
      result.errors?.push(`Refresh failed: ${error}`);
      
      console.error('❌ Catalog refresh failed:', error);
      throw error;
    }
    
    return result;
  }
  
  /**
   * Perform drift check (lighter weight than full refresh)
   */
  async performDriftCheck(): Promise<ModelChange[]> {
    console.log('🔍 Performing catalog drift check...');
    
    try {
      // Quick check on key models and pricing
      const keyModels = [
        'deepseek/deepseek-r1',
        'qwen/qwen3-coder',
        'openai/gpt-5',
        'google/gemini-2.5-pro',
        'anthropic/claude-3.5-sonnet'
      ];
      
      const driftResults = await Promise.allSettled(
        keyModels.map(model => this.checkModelDrift(model))
      );
      
      const allDrift: ModelChange[] = [];
      driftResults.forEach((result, index) => {
        if (result.status === 'fulfilled' && result.value.length > 0) {
          allDrift.push(...result.value);
          console.log(`📊 Drift detected for ${keyModels[index]}: ${result.value.length} changes`);
        }
      });
      
      // If significant drift detected, schedule immediate full refresh
      const significantDrift = allDrift.filter(change => change.change_magnitude >= 0.5);
      if (significantDrift.length > 0) {
        console.log('🚨 Significant drift detected - scheduling immediate full refresh');
        setTimeout(() => this.performFullRefresh(), 1000);
      }
      
      return allDrift;
      
    } catch (error) {
      console.error('❌ Drift check failed:', error);
      return [];
    }
  }
  
  private scheduleNightlyRefresh(): void {
    const now = new Date();
    const scheduleTime = new Date();
    scheduleTime.setUTCHours(this.config.schedule.nightly_refresh_hour, 0, 0, 0);
    
    // If scheduled time has passed today, schedule for tomorrow
    if (scheduleTime <= now) {
      scheduleTime.setUTCDate(scheduleTime.getUTCDate() + 1);
    }
    
    const timeUntilRefresh = scheduleTime.getTime() - now.getTime();
    
    console.log(`⏰ Nightly catalog refresh scheduled for ${scheduleTime.toISOString()}`);
    
    this.refreshTimer = setTimeout(() => {
      this.performFullRefresh().catch(error => {
        console.error('❌ Scheduled catalog refresh failed:', error);
      });
      
      // Reschedule for next night
      this.scheduleNightlyRefresh();
    }, timeUntilRefresh);
  }
  
  private scheduleDriftChecks(): void {
    const intervalMs = this.config.schedule.drift_check_interval_hours * 60 * 60 * 1000;
    
    console.log(`🔍 Drift checks scheduled every ${this.config.schedule.drift_check_interval_hours} hours`);
    
    this.driftCheckTimer = setInterval(() => {
      this.performDriftCheck().catch(error => {
        console.error('❌ Drift check failed:', error);
      });
    }, intervalMs);
  }
  
  private async fetchCurrentCatalog(): Promise<any> {
    const response = await fetch(`${this.config.endpoints.catalog_service_url}/v1/models/all`);
    if (!response.ok) {
      throw new Error(`Failed to fetch current catalog: ${response.statusText}`);
    }
    return await response.json();
  }
  
  private async refreshOpenRouterModels(): Promise<{ models: any[] }> {
    const response = await fetch(`${this.config.endpoints.catalog_service_url}/v1/refresh/openrouter`, {
      method: 'POST'
    });
    
    if (!response.ok) {
      throw new Error(`OpenRouter refresh failed: ${response.statusText}`);
    }
    
    return await response.json();
  }
  
  private async refreshOpenAIModels(): Promise<{ models: any[] }> {
    const response = await fetch(`${this.config.endpoints.catalog_service_url}/v1/refresh/openai`, {
      method: 'POST'
    });
    
    if (!response.ok) {
      throw new Error(`OpenAI refresh failed: ${response.statusText}`);
    }
    
    return await response.json();
  }
  
  private async refreshGeminiModels(): Promise<{ models: any[] }> {
    const response = await fetch(`${this.config.endpoints.catalog_service_url}/v1/refresh/gemini`, {
      method: 'POST'
    });
    
    if (!response.ok) {
      throw new Error(`Gemini refresh failed: ${response.statusText}`);
    }
    
    return await response.json();
  }
  
  private detectChanges(oldModels: any[], newModels: any[], provider: string): ModelChange[] {
    const changes: ModelChange[] = [];
    
    // Create lookup maps
    const oldMap = new Map(oldModels.map(m => [m.slug, m]));
    const newMap = new Map(newModels.map(m => [m.slug, m]));
    
    // Check for changes in existing models
    for (const [slug, newModel] of newMap) {
      const oldModel = oldMap.get(slug);
      if (!oldModel) continue; // New model - not a change
      
      // Price changes
      if (oldModel.pricing && newModel.pricing) {
        const oldPrice = oldModel.pricing.in + oldModel.pricing.out;
        const newPrice = newModel.pricing.in + newModel.pricing.out;
        const priceChangePct = Math.abs(newPrice - oldPrice) / oldPrice;
        
        if (priceChangePct >= this.config.thresholds.price_change_percentage) {
          changes.push({
            model_slug: slug,
            provider,
            change_type: 'price',
            old_value: oldModel.pricing,
            new_value: newModel.pricing,
            change_magnitude: Math.min(priceChangePct, 1.0),
            timestamp: new Date().toISOString()
          });
        }
      }
      
      // Context limit changes
      if (oldModel.ctx_in !== newModel.ctx_in) {
        const contextChangePct = Math.abs(newModel.ctx_in - oldModel.ctx_in) / oldModel.ctx_in;
        
        if (contextChangePct >= this.config.thresholds.context_limit_change_threshold) {
          changes.push({
            model_slug: slug,
            provider,
            change_type: 'context',
            old_value: oldModel.ctx_in,
            new_value: newModel.ctx_in,
            change_magnitude: Math.min(contextChangePct, 1.0),
            timestamp: new Date().toISOString()
          });
        }
      }
      
      // Capability changes (thinking support, JSON mode, etc.)
      if (this.hasCapabilityChanges(oldModel.params || {}, newModel.params || {})) {
        changes.push({
          model_slug: slug,
          provider,
          change_type: 'capability',
          old_value: oldModel.params,
          new_value: newModel.params,
          change_magnitude: 0.5, // Medium severity for capability changes
          timestamp: new Date().toISOString()
        });
      }
    }
    
    return changes;
  }
  
  private hasCapabilityChanges(oldParams: any, newParams: any): boolean {
    const significantKeys = ['thinking', 'json', 'tools', 'reasoning_effort'];
    
    return significantKeys.some(key => oldParams[key] !== newParams[key]);
  }
  
  private async checkModelDrift(modelSlug: string): Promise<ModelChange[]> {
    try {
      const response = await fetch(`${this.config.endpoints.catalog_service_url}/v1/models/${modelSlug}/drift-check`);
      if (!response.ok) {
        return [];
      }
      
      const driftData = await response.json();
      return driftData.changes || [];
      
    } catch (error) {
      console.warn(`Failed to check drift for ${modelSlug}:`, error);
      return [];
    }
  }
  
  private async updateCatalogService(updatedCatalog: any): Promise<void> {
    const response = await fetch(`${this.config.endpoints.catalog_service_url}/v1/models/bulk-update`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(updatedCatalog)
    });
    
    if (!response.ok) {
      throw new Error(`Failed to update catalog: ${response.statusText}`);
    }
  }
  
  private async invalidateArtifacts(significantChanges: ModelChange[]): Promise<string[]> {
    const affectedModels = significantChanges.map(change => change.model_slug);
    
    const response = await fetch(`${this.config.endpoints.artifact_store_url}/v1/artifacts/invalidate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        reason: 'catalog_drift',
        affected_models: affectedModels,
        backup_count: this.config.artifact_invalidation.backup_count
      })
    });
    
    if (!response.ok) {
      throw new Error(`Failed to invalidate artifacts: ${response.statusText}`);
    }
    
    const result = await response.json();
    return result.invalidated_artifacts || [];
  }
  
  private async sendNotification(result: RefreshResult): Promise<void> {
    if (!this.config.endpoints.notification_webhook) return;
    
    const notification = {
      type: 'catalog_refresh_complete',
      timestamp: result.timestamp,
      status: result.status,
      summary: {
        models_checked: result.models_checked,
        changes_detected: result.changes_detected.length,
        artifacts_invalidated: result.artifacts_invalidated.length,
        duration_ms: result.duration_ms
      },
      changes: result.changes_detected,
      next_refresh: result.next_scheduled_refresh
    };
    
    try {
      await fetch(this.config.endpoints.notification_webhook, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(notification)
      });
    } catch (error) {
      console.warn('Failed to send notification:', error);
    }
  }
  
  private countTotalModels(catalog: any): number {
    return Object.values(catalog).reduce((count: number, providerModels: any) => {
      return count + (Array.isArray(providerModels) ? providerModels.length : 0);
    }, 0);
  }
  
  private getNextScheduledRefreshTime(): string {
    const next = new Date();
    next.setUTCDate(next.getUTCDate() + 1);
    next.setUTCHours(this.config.schedule.nightly_refresh_hour, 0, 0, 0);
    return next.toISOString();
  }
  
  private mergeDefaultConfig(config: Partial<CatalogRefreshConfig>): CatalogRefreshConfig {
    return {
      schedule: {
        nightly_refresh_hour: 2, // 2 AM UTC
        drift_check_interval_hours: 6,
        ...config.schedule
      },
      thresholds: {
        price_change_percentage: 0.10, // 10% price change
        capability_change_threshold: 0.30,
        context_limit_change_threshold: 0.20, // 20% context change
        ...config.thresholds
      },
      endpoints: {
        catalog_service_url: process.env.CATALOG_SERVICE_URL || 'http://localhost:8080',
        artifact_store_url: process.env.ARTIFACT_STORE_URL || 'http://localhost:8081',
        notification_webhook: process.env.CATALOG_NOTIFICATION_WEBHOOK,
        ...config.endpoints
      },
      artifact_invalidation: {
        enabled: true,
        backup_count: 3,
        ...config.artifact_invalidation
      }
    };
  }
}