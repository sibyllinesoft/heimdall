/**
 * Enhanced Metrics Collector for Bifrost Router
 * Implements comprehensive observability for Milestone 5
 */

export interface MetricsData {
  timestamp: string;
  request_id: string;
  bucket: string;
  provider: string;
  model: string;
  success: boolean;
  execution_time_ms: number;
  cost: number;
  tokens: {
    prompt: number;
    completion: number;
    total: number;
  };
  fallback_used: boolean;
  fallback_reason?: string;
  error_type?: string;
  user_id?: string;
  anthropic_429?: boolean;
  win_rate_vs_baseline?: number;
}

export interface DashboardMetrics {
  route_share_by_bucket: Record<string, number>;
  cost_per_task: {
    mean: number;
    p95: number;
    by_bucket: Record<string, number>;
  };
  latency_metrics: {
    mean: number;
    p95: number;
    p99: number;
    by_provider: Record<string, number>;
  };
  anthropic_429_rate: {
    rate: number;
    escalations_last_hour: number;
    cooldown_users: number;
  };
  win_rate_vs_baseline: {
    overall: number;
    by_bucket: Record<string, number>;
    trend_24h: number[];
  };
  provider_health: Record<string, {
    availability: number;
    avg_latency: number;
    error_rate: number;
    last_success: string;
  }>;
  slo_status: {
    p95_latency_target: number;
    p95_latency_actual: number;
    target_met: boolean;
    failover_misfire_rate: number;
    uptime_percentage: number;
  };
}

export interface SLOThresholds {
  p95_latency_ms: number;
  max_failover_misfire_rate: number;
  min_uptime_percentage: number;
  max_cost_per_task: number;
  min_win_rate: number;
}

/**
 * Comprehensive metrics collection and analysis
 */
export class MetricsCollector {
  private metrics: MetricsData[] = [];
  private readonly maxMetricsHistory = 50000;
  private readonly timeWindows = {
    realtime: 5 * 60 * 1000,      // 5 minutes
    short: 60 * 60 * 1000,       // 1 hour
    medium: 24 * 60 * 60 * 1000, // 24 hours
    long: 7 * 24 * 60 * 60 * 1000 // 7 days
  };
  
  private sloThresholds: SLOThresholds = {
    p95_latency_ms: 2500,
    max_failover_misfire_rate: 0.05, // 5%
    min_uptime_percentage: 99.5,
    max_cost_per_task: 0.10, // $0.10
    min_win_rate: 0.85 // 85%
  };
  
  constructor(
    private emitToDataWarehouse = true,
    private warehouseEndpoint = process.env.METRICS_WAREHOUSE_URL
  ) {}
  
  /**
   * Record a new metric data point
   */
  recordMetric(data: MetricsData): void {
    this.metrics.push({
      ...data,
      timestamp: data.timestamp || new Date().toISOString()
    });
    
    // Maintain bounded history
    if (this.metrics.length > this.maxMetricsHistory) {
      this.metrics = this.metrics.slice(-this.maxMetricsHistory);
    }
    
    // Emit to warehouse if configured
    if (this.emitToDataWarehouse && this.warehouseEndpoint) {
      this.emitToWarehouse(data).catch(error => 
        console.warn('Failed to emit metric to warehouse:', error)
      );
    }
  }
  
  /**
   * Generate comprehensive dashboard metrics
   */
  getDashboardMetrics(timeWindow = this.timeWindows.medium): DashboardMetrics {
    const cutoff = Date.now() - timeWindow;
    const recentMetrics = this.getMetricsInWindow(cutoff);
    
    if (recentMetrics.length === 0) {
      return this.getEmptyDashboardMetrics();
    }
    
    return {
      route_share_by_bucket: this.calculateRouteShare(recentMetrics),
      cost_per_task: this.calculateCostMetrics(recentMetrics),
      latency_metrics: this.calculateLatencyMetrics(recentMetrics),
      anthropic_429_rate: this.calculate429Metrics(recentMetrics),
      win_rate_vs_baseline: this.calculateWinRateMetrics(recentMetrics),
      provider_health: this.calculateProviderHealth(recentMetrics),
      slo_status: this.calculateSLOStatus(recentMetrics)
    };
  }
  
  /**
   * Check if current metrics meet SLO thresholds
   */
  checkSLOCompliance(timeWindow = this.timeWindows.short): {
    compliant: boolean;
    violations: string[];
    metrics: DashboardMetrics;
  } {
    const metrics = this.getDashboardMetrics(timeWindow);
    const violations: string[] = [];
    
    // Check P95 latency
    if (metrics.latency_metrics.p95 > this.sloThresholds.p95_latency_ms) {
      violations.push(
        `P95 latency ${metrics.latency_metrics.p95}ms exceeds threshold ${this.sloThresholds.p95_latency_ms}ms`
      );
    }
    
    // Check failover misfire rate
    if (metrics.slo_status.failover_misfire_rate > this.sloThresholds.max_failover_misfire_rate) {
      violations.push(
        `Failover misfire rate ${(metrics.slo_status.failover_misfire_rate * 100).toFixed(2)}% exceeds threshold ${(this.sloThresholds.max_failover_misfire_rate * 100)}%`
      );
    }
    
    // Check uptime
    if (metrics.slo_status.uptime_percentage < this.sloThresholds.min_uptime_percentage) {
      violations.push(
        `Uptime ${metrics.slo_status.uptime_percentage.toFixed(2)}% below threshold ${this.sloThresholds.min_uptime_percentage}%`
      );
    }
    
    // Check cost efficiency
    if (metrics.cost_per_task.mean > this.sloThresholds.max_cost_per_task) {
      violations.push(
        `Average cost per task $${metrics.cost_per_task.mean.toFixed(4)} exceeds threshold $${this.sloThresholds.max_cost_per_task.toFixed(4)}`
      );
    }
    
    // Check win rate
    if (metrics.win_rate_vs_baseline.overall < this.sloThresholds.min_win_rate) {
      violations.push(
        `Win rate ${(metrics.win_rate_vs_baseline.overall * 100).toFixed(1)}% below threshold ${(this.sloThresholds.min_win_rate * 100)}%`
      );
    }
    
    return {
      compliant: violations.length === 0,
      violations,
      metrics
    };
  }
  
  /**
   * Generate deployment readiness report
   */
  getDeploymentReadiness(): {
    ready: boolean;
    blockers: string[];
    warnings: string[];
    metrics: DashboardMetrics;
  } {
    const sloCheck = this.checkSLOCompliance(this.timeWindows.short);
    const longTermCheck = this.checkSLOCompliance(this.timeWindows.long);
    
    const blockers: string[] = [];
    const warnings: string[] = [];
    
    // Critical blockers from recent SLO violations
    if (!sloCheck.compliant) {
      blockers.push(...sloCheck.violations.map(v => `Recent: ${v}`));
    }
    
    // Warnings from long-term trends
    if (!longTermCheck.compliant && sloCheck.compliant) {
      warnings.push('Long-term SLO trend concerning despite recent compliance');
    }
    
    // Check for provider health issues
    Object.entries(sloCheck.metrics.provider_health).forEach(([provider, health]) => {
      if (health.availability < 0.99) {
        if (health.availability < 0.95) {
          blockers.push(`Provider ${provider} availability critically low: ${(health.availability * 100).toFixed(1)}%`);
        } else {
          warnings.push(`Provider ${provider} availability concerning: ${(health.availability * 100).toFixed(1)}%`);
        }
      }
    });
    
    return {
      ready: blockers.length === 0,
      blockers,
      warnings,
      metrics: sloCheck.metrics
    };
  }
  
  private getMetricsInWindow(cutoff: number): MetricsData[] {
    return this.metrics.filter(m => new Date(m.timestamp).getTime() > cutoff);
  }
  
  private calculateRouteShare(metrics: MetricsData[]): Record<string, number> {
    const bucketCounts = metrics.reduce((acc, m) => {
      acc[m.bucket] = (acc[m.bucket] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    const total = metrics.length;
    const shares: Record<string, number> = {};
    
    Object.entries(bucketCounts).forEach(([bucket, count]) => {
      shares[bucket] = count / total;
    });
    
    return shares;
  }
  
  private calculateCostMetrics(metrics: MetricsData[]): DashboardMetrics['cost_per_task'] {
    const costs = metrics.map(m => m.cost).filter(c => c > 0);
    const mean = costs.length > 0 ? costs.reduce((a, b) => a + b, 0) / costs.length : 0;
    const p95 = this.calculatePercentile(costs, 0.95);
    
    // Calculate by bucket
    const byBucket: Record<string, number> = {};
    const bucketCosts: Record<string, number[]> = {};
    
    metrics.forEach(m => {
      if (m.cost > 0) {
        if (!bucketCosts[m.bucket]) bucketCosts[m.bucket] = [];
        bucketCosts[m.bucket].push(m.cost);
      }
    });
    
    Object.entries(bucketCosts).forEach(([bucket, costs]) => {
      byBucket[bucket] = costs.reduce((a, b) => a + b, 0) / costs.length;
    });
    
    return { mean, p95, by_bucket: byBucket };
  }
  
  private calculateLatencyMetrics(metrics: MetricsData[]): DashboardMetrics['latency_metrics'] {
    const latencies = metrics.map(m => m.execution_time_ms).filter(l => l > 0);
    const mean = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
    const p95 = this.calculatePercentile(latencies, 0.95);
    const p99 = this.calculatePercentile(latencies, 0.99);
    
    // Calculate by provider
    const byProvider: Record<string, number> = {};
    const providerLatencies: Record<string, number[]> = {};
    
    metrics.forEach(m => {
      if (m.execution_time_ms > 0) {
        if (!providerLatencies[m.provider]) providerLatencies[m.provider] = [];
        providerLatencies[m.provider].push(m.execution_time_ms);
      }
    });
    
    Object.entries(providerLatencies).forEach(([provider, latencies]) => {
      byProvider[provider] = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    });
    
    return { mean, p95, p99, by_provider: byProvider };
  }
  
  private calculate429Metrics(metrics: MetricsData[]): DashboardMetrics['anthropic_429_rate'] {
    const anthropic429s = metrics.filter(m => m.anthropic_429).length;
    const anthropicRequests = metrics.filter(m => m.provider === 'anthropic').length;
    const rate = anthropicRequests > 0 ? anthropic429s / anthropicRequests : 0;
    
    const oneHourAgo = Date.now() - this.timeWindows.short;
    const recentEscalations = metrics.filter(m => 
      m.anthropic_429 && new Date(m.timestamp).getTime() > oneHourAgo
    ).length;
    
    // Count unique users in cooldown (simplified estimation)
    const cooldownUsers = new Set(
      metrics.filter(m => m.anthropic_429 && m.user_id).map(m => m.user_id)
    ).size;
    
    return {
      rate,
      escalations_last_hour: recentEscalations,
      cooldown_users: cooldownUsers
    };
  }
  
  private calculateWinRateMetrics(metrics: MetricsData[]): DashboardMetrics['win_rate_vs_baseline'] {
    const withWinRate = metrics.filter(m => m.win_rate_vs_baseline !== undefined);
    const overall = withWinRate.length > 0 
      ? withWinRate.reduce((sum, m) => sum + (m.win_rate_vs_baseline || 0), 0) / withWinRate.length
      : 0.85; // Default assumption
    
    // Calculate by bucket
    const byBucket: Record<string, number> = {};
    const bucketWinRates: Record<string, number[]> = {};
    
    withWinRate.forEach(m => {
      if (m.win_rate_vs_baseline !== undefined) {
        if (!bucketWinRates[m.bucket]) bucketWinRates[m.bucket] = [];
        bucketWinRates[m.bucket].push(m.win_rate_vs_baseline);
      }
    });
    
    Object.entries(bucketWinRates).forEach(([bucket, rates]) => {
      byBucket[bucket] = rates.reduce((a, b) => a + b, 0) / rates.length;
    });
    
    // Generate 24-hour trend (24 points)
    const trend24h = this.generate24HourTrend(metrics);
    
    return { overall, by_bucket: byBucket, trend_24h: trend24h };
  }
  
  private calculateProviderHealth(metrics: MetricsData[]): DashboardMetrics['provider_health'] {
    const providerStats: Record<string, {
      total: number;
      successful: number;
      latencies: number[];
      lastSuccess: string;
    }> = {};
    
    metrics.forEach(m => {
      if (!providerStats[m.provider]) {
        providerStats[m.provider] = {
          total: 0,
          successful: 0,
          latencies: [],
          lastSuccess: m.timestamp
        };
      }
      
      const stat = providerStats[m.provider];
      stat.total++;
      if (m.success) {
        stat.successful++;
        stat.lastSuccess = m.timestamp;
      }
      if (m.execution_time_ms > 0) {
        stat.latencies.push(m.execution_time_ms);
      }
    });
    
    const health: DashboardMetrics['provider_health'] = {};
    Object.entries(providerStats).forEach(([provider, stats]) => {
      health[provider] = {
        availability: stats.total > 0 ? stats.successful / stats.total : 0,
        avg_latency: stats.latencies.length > 0 
          ? stats.latencies.reduce((a, b) => a + b, 0) / stats.latencies.length 
          : 0,
        error_rate: stats.total > 0 ? (stats.total - stats.successful) / stats.total : 0,
        last_success: stats.lastSuccess
      };
    });
    
    return health;
  }
  
  private calculateSLOStatus(metrics: MetricsData[]): DashboardMetrics['slo_status'] {
    const latencyMetrics = this.calculateLatencyMetrics(metrics);
    const successful = metrics.filter(m => m.success).length;
    const total = metrics.length;
    const uptime = total > 0 ? (successful / total) * 100 : 100;
    
    // Calculate failover misfire rate (fallbacks that didn't work)
    const fallbacks = metrics.filter(m => m.fallback_used);
    const failedFallbacks = fallbacks.filter(m => !m.success);
    const failoverMisfireRate = fallbacks.length > 0 ? failedFallbacks.length / fallbacks.length : 0;
    
    return {
      p95_latency_target: this.sloThresholds.p95_latency_ms,
      p95_latency_actual: latencyMetrics.p95,
      target_met: latencyMetrics.p95 <= this.sloThresholds.p95_latency_ms,
      failover_misfire_rate: failoverMisfireRate,
      uptime_percentage: uptime
    };
  }
  
  private calculatePercentile(values: number[], percentile: number): number {
    if (values.length === 0) return 0;
    
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.ceil(sorted.length * percentile) - 1;
    return sorted[index] || 0;
  }
  
  private generate24HourTrend(metrics: MetricsData[]): number[] {
    const hourlyBuckets: number[] = new Array(24).fill(0);
    const hourlyCounts: number[] = new Array(24).fill(0);
    
    const now = Date.now();
    const oneDayAgo = now - this.timeWindows.medium;
    
    metrics
      .filter(m => new Date(m.timestamp).getTime() > oneDayAgo)
      .forEach(m => {
        if (m.win_rate_vs_baseline !== undefined) {
          const hourAgo = Math.floor((now - new Date(m.timestamp).getTime()) / (60 * 60 * 1000));
          if (hourAgo >= 0 && hourAgo < 24) {
            const bucketIndex = 23 - hourAgo; // Reverse order (most recent first)
            hourlyBuckets[bucketIndex] += m.win_rate_vs_baseline;
            hourlyCounts[bucketIndex]++;
          }
        }
      });
    
    return hourlyBuckets.map((sum, i) => 
      hourlyCounts[i] > 0 ? sum / hourlyCounts[i] : 0.85
    );
  }
  
  private getEmptyDashboardMetrics(): DashboardMetrics {
    return {
      route_share_by_bucket: {},
      cost_per_task: { mean: 0, p95: 0, by_bucket: {} },
      latency_metrics: { mean: 0, p95: 0, p99: 0, by_provider: {} },
      anthropic_429_rate: { rate: 0, escalations_last_hour: 0, cooldown_users: 0 },
      win_rate_vs_baseline: { overall: 0, by_bucket: {}, trend_24h: [] },
      provider_health: {},
      slo_status: {
        p95_latency_target: this.sloThresholds.p95_latency_ms,
        p95_latency_actual: 0,
        target_met: true,
        failover_misfire_rate: 0,
        uptime_percentage: 100
      }
    };
  }
  
  private async emitToWarehouse(data: MetricsData): Promise<void> {
    if (!this.warehouseEndpoint) return;
    
    try {
      const response = await fetch(this.warehouseEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Bifrost-Router/1.0'
        },
        body: JSON.stringify({
          source: 'bifrost-router',
          timestamp: data.timestamp,
          data
        })
      });
      
      if (!response.ok) {
        throw new Error(`Warehouse responded with ${response.status}`);
      }
    } catch (error) {
      console.warn('Warehouse emission failed:', error);
      // Don't throw - warehouse issues shouldn't break routing
    }
  }
  
  /**
   * Update SLO thresholds
   */
  updateSLOThresholds(thresholds: Partial<SLOThresholds>): void {
    this.sloThresholds = { ...this.sloThresholds, ...thresholds };
  }
  
  /**
   * Export metrics for external analysis
   */
  exportMetrics(timeWindow?: number): MetricsData[] {
    if (timeWindow) {
      const cutoff = Date.now() - timeWindow;
      return this.getMetricsInWindow(cutoff);
    }
    return [...this.metrics];
  }
}