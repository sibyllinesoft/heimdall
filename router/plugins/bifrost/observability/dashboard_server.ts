/**
 * Real-time Dashboard Server for Bifrost Router Observability
 * Provides HTTP endpoints for metrics, SLO monitoring, and deployment guardrails
 */

import { MetricsCollector, DashboardMetrics } from './metrics_collector.js';

export interface DashboardConfig {
  port: number;
  enableCORS: boolean;
  refreshIntervalMs: number;
  historyRetentionDays: number;
  alertThresholds: {
    p95LatencyMs: number;
    failoverMisfireRate: number;
    costPerTaskThreshold: number;
    minWinRate: number;
  };
}

export interface AlertRule {
  id: string;
  name: string;
  condition: (metrics: DashboardMetrics) => boolean;
  message: (metrics: DashboardMetrics) => string;
  severity: 'info' | 'warning' | 'critical';
  cooldownMs: number;
  lastTriggered?: number;
}

/**
 * HTTP Dashboard Server for real-time metrics and monitoring
 */
export class DashboardServer {
  private server: any;
  private metricsCollector: MetricsCollector;
  private config: DashboardConfig;
  private alertRules: AlertRule[] = [];
  private isRunning = false;
  
  constructor(
    metricsCollector: MetricsCollector,
    config: Partial<DashboardConfig> = {}
  ) {
    this.metricsCollector = metricsCollector;
    this.config = {
      port: 8090,
      enableCORS: true,
      refreshIntervalMs: 30000, // 30 seconds
      historyRetentionDays: 7,
      alertThresholds: {
        p95LatencyMs: 2500,
        failoverMisfireRate: 0.05,
        costPerTaskThreshold: 0.10,
        minWinRate: 0.85
      },
      ...config
    };
    
    this.initializeAlertRules();
  }
  
  /**
   * Start the dashboard server
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.warn('Dashboard server is already running');
      return;
    }
    
    try {
      // Use dynamic import for better compatibility
      const http = await import('http');
      const url = await import('url');
      
      this.server = http.createServer(async (req, res) => {
        await this.handleRequest(req, res, url);
      });
      
      await new Promise<void>((resolve, reject) => {
        this.server.listen(this.config.port, (err: Error) => {
          if (err) reject(err);
          else resolve();
        });
      });
      
      this.isRunning = true;
      console.log(`Dashboard server started on port ${this.config.port}`);
      console.log(`Dashboard available at: http://localhost:${this.config.port}/dashboard`);
      
    } catch (error) {
      console.error('Failed to start dashboard server:', error);
      throw error;
    }
  }
  
  /**
   * Stop the dashboard server
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;
    
    return new Promise<void>((resolve) => {
      this.server.close(() => {
        this.isRunning = false;
        console.log('Dashboard server stopped');
        resolve();
      });
    });
  }
  
  private async handleRequest(req: any, res: any, urlModule: any): Promise<void> {
    const parsedUrl = urlModule.parse(req.url, true);
    const path = parsedUrl.pathname;
    const query = parsedUrl.query;
    
    // Enable CORS if configured
    if (this.config.enableCORS) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    
    // Handle preflight requests
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    
    try {
      switch (path) {
        case '/health':
          await this.handleHealth(req, res);
          break;
        case '/metrics':
          await this.handleMetrics(req, res, query);
          break;
        case '/dashboard':
          await this.handleDashboard(req, res, query);
          break;
        case '/slo-status':
          await this.handleSLOStatus(req, res, query);
          break;
        case '/deployment-readiness':
          await this.handleDeploymentReadiness(req, res);
          break;
        case '/alerts':
          await this.handleAlerts(req, res);
          break;
        case '/provider-health':
          await this.handleProviderHealth(req, res, query);
          break;
        case '/cost-analysis':
          await this.handleCostAnalysis(req, res, query);
          break;
        case '/performance-trends':
          await this.handlePerformanceTrends(req, res, query);
          break;
        default:
          this.sendNotFound(res);
      }
    } catch (error) {
      console.error('Dashboard request error:', error);
      this.sendError(res, 'Internal server error', 500);
    }
  }
  
  private async handleHealth(req: any, res: any): Promise<void> {
    const health = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      dashboard_version: '1.0.0',
      metrics_count: this.metricsCollector.exportMetrics().length
    };
    
    this.sendJSON(res, health);
  }
  
  private async handleMetrics(req: any, res: any, query: any): Promise<void> {
    const timeWindow = query.window ? parseInt(query.window) : undefined;
    const format = query.format || 'json';
    
    const dashboardMetrics = this.metricsCollector.getDashboardMetrics(timeWindow);
    
    if (format === 'prometheus') {
      const prometheus = this.convertToPrometheus(dashboardMetrics);
      res.setHeader('Content-Type', 'text/plain');
      res.writeHead(200);
      res.end(prometheus);
    } else {
      this.sendJSON(res, dashboardMetrics);
    }
  }
  
  private async handleDashboard(req: any, res: any, query: any): Promise<void> {
    const timeWindow = query.window ? parseInt(query.window) : undefined;
    const dashboardMetrics = this.metricsCollector.getDashboardMetrics(timeWindow);
    
    const html = this.generateDashboardHTML(dashboardMetrics);
    res.setHeader('Content-Type', 'text/html');
    res.writeHead(200);
    res.end(html);
  }
  
  private async handleSLOStatus(req: any, res: any, query: any): Promise<void> {
    const timeWindow = query.window ? parseInt(query.window) : undefined;
    const sloStatus = this.metricsCollector.checkSLOCompliance(timeWindow);
    
    this.sendJSON(res, sloStatus);
  }
  
  private async handleDeploymentReadiness(req: any, res: any): Promise<void> {
    const readiness = this.metricsCollector.getDeploymentReadiness();
    
    // Add detailed deployment guidance
    const enhancedReadiness = {
      ...readiness,
      deployment_guidance: this.generateDeploymentGuidance(readiness),
      recommended_actions: this.getRecommendedActions(readiness)
    };
    
    this.sendJSON(res, enhancedReadiness);
  }
  
  private async handleAlerts(req: any, res: any): Promise<void> {
    const activeAlerts = this.evaluateAlertRules();
    
    this.sendJSON(res, {
      active_alerts: activeAlerts,
      alert_rules_count: this.alertRules.length,
      last_evaluation: new Date().toISOString()
    });
  }
  
  private async handleProviderHealth(req: any, res: any, query: any): Promise<void> {
    const timeWindow = query.window ? parseInt(query.window) : undefined;
    const dashboardMetrics = this.metricsCollector.getDashboardMetrics(timeWindow);
    
    const detailedHealth = {
      ...dashboardMetrics.provider_health,
      summary: {
        total_providers: Object.keys(dashboardMetrics.provider_health).length,
        healthy_providers: Object.values(dashboardMetrics.provider_health)
          .filter(p => p.availability >= 0.99).length,
        degraded_providers: Object.values(dashboardMetrics.provider_health)
          .filter(p => p.availability >= 0.95 && p.availability < 0.99).length,
        unhealthy_providers: Object.values(dashboardMetrics.provider_health)
          .filter(p => p.availability < 0.95).length
      }
    };
    
    this.sendJSON(res, detailedHealth);
  }
  
  private async handleCostAnalysis(req: any, res: any, query: any): Promise<void> {
    const timeWindow = query.window ? parseInt(query.window) : undefined;
    const dashboardMetrics = this.metricsCollector.getDashboardMetrics(timeWindow);
    
    const analysis = {
      cost_per_task: dashboardMetrics.cost_per_task,
      cost_optimization_opportunities: this.identifyCostOptimizations(dashboardMetrics),
      bucket_efficiency: this.calculateBucketEfficiency(dashboardMetrics),
      projected_monthly_cost: this.projectMonthlyCost(dashboardMetrics)
    };
    
    this.sendJSON(res, analysis);
  }
  
  private async handlePerformanceTrends(req: any, res: any, query: any): Promise<void> {
    const timeWindow = query.window ? parseInt(query.window) : undefined;
    const dashboardMetrics = this.metricsCollector.getDashboardMetrics(timeWindow);
    
    const trends = {
      latency_trend: dashboardMetrics.latency_metrics,
      win_rate_trend: dashboardMetrics.win_rate_vs_baseline,
      anthropic_429_trend: this.calculate429Trend(),
      performance_recommendations: this.generatePerformanceRecommendations(dashboardMetrics)
    };
    
    this.sendJSON(res, trends);
  }
  
  private initializeAlertRules(): void {
    this.alertRules = [
      {
        id: 'high_p95_latency',
        name: 'High P95 Latency',
        condition: (metrics) => metrics.latency_metrics.p95 > this.config.alertThresholds.p95LatencyMs,
        message: (metrics) => `P95 latency ${metrics.latency_metrics.p95}ms exceeds threshold ${this.config.alertThresholds.p95LatencyMs}ms`,
        severity: 'critical',
        cooldownMs: 5 * 60 * 1000 // 5 minutes
      },
      {
        id: 'high_failover_rate',
        name: 'High Failover Misfire Rate',
        condition: (metrics) => metrics.slo_status.failover_misfire_rate > this.config.alertThresholds.failoverMisfireRate,
        message: (metrics) => `Failover misfire rate ${(metrics.slo_status.failover_misfire_rate * 100).toFixed(1)}% exceeds threshold`,
        severity: 'warning',
        cooldownMs: 10 * 60 * 1000 // 10 minutes
      },
      {
        id: 'high_cost_per_task',
        name: 'High Cost Per Task',
        condition: (metrics) => metrics.cost_per_task.mean > this.config.alertThresholds.costPerTaskThreshold,
        message: (metrics) => `Average cost per task $${metrics.cost_per_task.mean.toFixed(4)} exceeds threshold`,
        severity: 'warning',
        cooldownMs: 30 * 60 * 1000 // 30 minutes
      },
      {
        id: 'low_win_rate',
        name: 'Low Win Rate vs Baseline',
        condition: (metrics) => metrics.win_rate_vs_baseline.overall < this.config.alertThresholds.minWinRate,
        message: (metrics) => `Win rate ${(metrics.win_rate_vs_baseline.overall * 100).toFixed(1)}% below threshold`,
        severity: 'critical',
        cooldownMs: 15 * 60 * 1000 // 15 minutes
      },
      {
        id: 'anthropic_429_spike',
        name: 'Anthropic 429 Rate Spike',
        condition: (metrics) => metrics.anthropic_429_rate.rate > 0.1,
        message: (metrics) => `Anthropic 429 rate ${(metrics.anthropic_429_rate.rate * 100).toFixed(1)}% indicates rate limiting issues`,
        severity: 'warning',
        cooldownMs: 5 * 60 * 1000 // 5 minutes
      }
    ];
  }
  
  private evaluateAlertRules(): Array<AlertRule & { triggered_at: string; metrics_snapshot: any }> {
    const dashboardMetrics = this.metricsCollector.getDashboardMetrics();
    const activeAlerts: Array<AlertRule & { triggered_at: string; metrics_snapshot: any }> = [];
    const now = Date.now();
    
    for (const rule of this.alertRules) {
      // Check cooldown
      if (rule.lastTriggered && (now - rule.lastTriggered) < rule.cooldownMs) {
        continue;
      }
      
      // Evaluate condition
      if (rule.condition(dashboardMetrics)) {
        rule.lastTriggered = now;
        activeAlerts.push({
          ...rule,
          triggered_at: new Date().toISOString(),
          metrics_snapshot: {
            latency_p95: dashboardMetrics.latency_metrics.p95,
            cost_per_task: dashboardMetrics.cost_per_task.mean,
            win_rate: dashboardMetrics.win_rate_vs_baseline.overall,
            anthropic_429_rate: dashboardMetrics.anthropic_429_rate.rate,
            failover_misfire_rate: dashboardMetrics.slo_status.failover_misfire_rate
          }
        });
      }
    }
    
    return activeAlerts;
  }
  
  private generateDeploymentGuidance(readiness: any): string[] {
    const guidance: string[] = [];
    
    if (!readiness.ready) {
      guidance.push('❌ DEPLOYMENT BLOCKED - Address critical issues before proceeding');
      readiness.blockers.forEach((blocker: string) => {
        guidance.push(`🚫 ${blocker}`);
      });
    } else {
      guidance.push('✅ DEPLOYMENT READY - All SLO thresholds met');
    }
    
    if (readiness.warnings.length > 0) {
      guidance.push('⚠️  Pre-deployment warnings:');
      readiness.warnings.forEach((warning: string) => {
        guidance.push(`⚠️  ${warning}`);
      });
    }
    
    return guidance;
  }
  
  private getRecommendedActions(readiness: any): string[] {
    const actions: string[] = [];
    
    if (readiness.blockers.some((b: string) => b.includes('P95 latency'))) {
      actions.push('Investigate high-latency providers and consider routing adjustments');
      actions.push('Review thinking budget allocations for GPT-5/Gemini requests');
    }
    
    if (readiness.blockers.some((b: string) => b.includes('availability'))) {
      actions.push('Check provider status and network connectivity');
      actions.push('Verify API keys and authentication credentials');
    }
    
    if (readiness.blockers.some((b: string) => b.includes('cost'))) {
      actions.push('Review bucket distribution and alpha-score tuning');
      actions.push('Consider adjusting cheap/mid/hard bucket thresholds');
    }
    
    return actions;
  }
  
  private identifyCostOptimizations(metrics: DashboardMetrics): string[] {
    const optimizations: string[] = [];
    
    // Check if expensive buckets are over-utilized
    const hardBucketShare = metrics.route_share_by_bucket.hard || 0;
    if (hardBucketShare > 0.3) {
      optimizations.push('Consider tightening hard bucket criteria - high usage detected');
    }
    
    // Check cost variance by bucket
    const bucketCosts = metrics.cost_per_task.by_bucket;
    Object.entries(bucketCosts).forEach(([bucket, cost]) => {
      if (bucket === 'cheap' && cost > 0.01) {
        optimizations.push('Cheap bucket costs higher than expected - review OpenRouter routing');
      }
      if (bucket === 'mid' && cost > 0.05) {
        optimizations.push('Mid bucket costs elevated - consider thinking budget optimization');
      }
    });
    
    return optimizations;
  }
  
  private calculateBucketEfficiency(metrics: DashboardMetrics): Record<string, number> {
    const efficiency: Record<string, number> = {};
    
    // Calculate efficiency as win_rate / cost_ratio
    Object.entries(metrics.win_rate_vs_baseline.by_bucket).forEach(([bucket, winRate]) => {
      const cost = metrics.cost_per_task.by_bucket[bucket] || 0;
      efficiency[bucket] = cost > 0 ? winRate / cost : 0;
    });
    
    return efficiency;
  }
  
  private projectMonthlyCost(metrics: DashboardMetrics): {
    current_daily: number;
    projected_monthly: number;
    by_bucket: Record<string, number>;
  } {
    const dailyCost = metrics.cost_per_task.mean * 1000; // Assume 1000 requests/day baseline
    const monthlyCost = dailyCost * 30;
    
    const byBucket: Record<string, number> = {};
    Object.entries(metrics.cost_per_task.by_bucket).forEach(([bucket, cost]) => {
      const share = metrics.route_share_by_bucket[bucket] || 0;
      byBucket[bucket] = cost * share * 1000 * 30;
    });
    
    return {
      current_daily: dailyCost,
      projected_monthly: monthlyCost,
      by_bucket: byBucket
    };
  }
  
  private calculate429Trend(): { hourly_rates: number[]; trend_direction: 'up' | 'down' | 'stable' } {
    // Simplified trend calculation
    const rates = new Array(24).fill(0.02); // Mock data for now
    
    const recent = rates.slice(-6).reduce((a, b) => a + b, 0) / 6;
    const earlier = rates.slice(-12, -6).reduce((a, b) => a + b, 0) / 6;
    
    let direction: 'up' | 'down' | 'stable' = 'stable';
    if (recent > earlier * 1.1) direction = 'up';
    else if (recent < earlier * 0.9) direction = 'down';
    
    return { hourly_rates: rates, trend_direction: direction };
  }
  
  private generatePerformanceRecommendations(metrics: DashboardMetrics): string[] {
    const recommendations: string[] = [];
    
    // Latency recommendations
    if (metrics.latency_metrics.p95 > 2000) {
      recommendations.push('P95 latency high - consider provider health and thinking budget optimization');
    }
    
    // Provider-specific recommendations
    Object.entries(metrics.latency_metrics.by_provider).forEach(([provider, latency]) => {
      if (latency > 3000) {
        recommendations.push(`Provider ${provider} showing high latency - investigate connection issues`);
      }
    });
    
    // Win rate recommendations
    if (metrics.win_rate_vs_baseline.overall < 0.9) {
      recommendations.push('Win rate below optimal - review alpha-score parameters and bucket thresholds');
    }
    
    return recommendations;
  }
  
  private generateDashboardHTML(metrics: DashboardMetrics): string {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Bifrost Router Dashboard</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
        .header { background: #2c3e50; color: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; }
        .metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
        .metric-card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .metric-title { font-size: 18px; font-weight: bold; margin-bottom: 10px; color: #2c3e50; }
        .metric-value { font-size: 24px; font-weight: bold; margin: 10px 0; }
        .status-good { color: #27ae60; }
        .status-warning { color: #f39c12; }
        .status-critical { color: #e74c3c; }
        .slo-status { margin-top: 20px; padding: 15px; border-radius: 5px; }
        .slo-compliant { background: #d5f4e6; border-left: 4px solid #27ae60; }
        .slo-violation { background: #fdf2f2; border-left: 4px solid #e74c3c; }
        .refresh-info { text-align: center; margin-top: 20px; color: #7f8c8d; }
    </style>
    <script>
        function refreshDashboard() {
            location.reload();
        }
        
        // Auto-refresh every 30 seconds
        setInterval(refreshDashboard, 30000);
    </script>
</head>
<body>
    <div class="header">
        <h1>🌈 Bifrost Router Dashboard</h1>
        <p>Real-time observability for intelligent LLM routing</p>
        <p>Last updated: ${new Date().toISOString()}</p>
    </div>
    
    <div class="slo-status ${metrics.slo_status.target_met ? 'slo-compliant' : 'slo-violation'}">
        <h2>${metrics.slo_status.target_met ? '✅' : '❌'} SLO Status: ${metrics.slo_status.target_met ? 'COMPLIANT' : 'VIOLATION'}</h2>
        <p>P95 Latency: ${metrics.slo_status.p95_latency_actual.toFixed(0)}ms (target: ${metrics.slo_status.p95_latency_target}ms)</p>
        <p>Uptime: ${metrics.slo_status.uptime_percentage.toFixed(2)}%</p>
        <p>Failover Misfire Rate: ${(metrics.slo_status.failover_misfire_rate * 100).toFixed(2)}%</p>
    </div>
    
    <div class="metrics-grid">
        <div class="metric-card">
            <div class="metric-title">Route Distribution</div>
            ${Object.entries(metrics.route_share_by_bucket).map(([bucket, share]) => 
                `<div>${bucket}: <span class="metric-value">${(share * 100).toFixed(1)}%</span></div>`
            ).join('')}
        </div>
        
        <div class="metric-card">
            <div class="metric-title">Cost Analysis</div>
            <div>Average: <span class="metric-value ${metrics.cost_per_task.mean > 0.05 ? 'status-warning' : 'status-good'}">$${metrics.cost_per_task.mean.toFixed(4)}</span></div>
            <div>P95: <span class="metric-value">$${metrics.cost_per_task.p95.toFixed(4)}</span></div>
        </div>
        
        <div class="metric-card">
            <div class="metric-title">Latency Metrics</div>
            <div>P95: <span class="metric-value ${metrics.latency_metrics.p95 > 2500 ? 'status-critical' : metrics.latency_metrics.p95 > 2000 ? 'status-warning' : 'status-good'}">${metrics.latency_metrics.p95.toFixed(0)}ms</span></div>
            <div>P99: <span class="metric-value">${metrics.latency_metrics.p99.toFixed(0)}ms</span></div>
            <div>Average: <span class="metric-value">${metrics.latency_metrics.mean.toFixed(0)}ms</span></div>
        </div>
        
        <div class="metric-card">
            <div class="metric-title">Anthropic 429 Monitoring</div>
            <div>Rate: <span class="metric-value ${metrics.anthropic_429_rate.rate > 0.1 ? 'status-critical' : metrics.anthropic_429_rate.rate > 0.05 ? 'status-warning' : 'status-good'}">${(metrics.anthropic_429_rate.rate * 100).toFixed(2)}%</span></div>
            <div>Last Hour: ${metrics.anthropic_429_rate.escalations_last_hour} escalations</div>
            <div>Cooldown Users: ${metrics.anthropic_429_rate.cooldown_users}</div>
        </div>
        
        <div class="metric-card">
            <div class="metric-title">Win Rate vs Baseline</div>
            <div>Overall: <span class="metric-value ${metrics.win_rate_vs_baseline.overall < 0.8 ? 'status-critical' : metrics.win_rate_vs_baseline.overall < 0.9 ? 'status-warning' : 'status-good'}">${(metrics.win_rate_vs_baseline.overall * 100).toFixed(1)}%</span></div>
            ${Object.entries(metrics.win_rate_vs_baseline.by_bucket).map(([bucket, rate]) => 
                `<div>${bucket}: ${(rate * 100).toFixed(1)}%</div>`
            ).join('')}
        </div>
        
        <div class="metric-card">
            <div class="metric-title">Provider Health</div>
            ${Object.entries(metrics.provider_health).map(([provider, health]) => 
                `<div>
                    <strong>${provider}</strong><br>
                    Availability: <span class="${health.availability >= 0.99 ? 'status-good' : health.availability >= 0.95 ? 'status-warning' : 'status-critical'}">${(health.availability * 100).toFixed(1)}%</span><br>
                    Avg Latency: ${health.avg_latency.toFixed(0)}ms<br>
                    Error Rate: ${(health.error_rate * 100).toFixed(2)}%
                </div><hr>`
            ).join('')}
        </div>
    </div>
    
    <div class="refresh-info">
        <p>Dashboard auto-refreshes every 30 seconds • <a href="/metrics">Raw Metrics</a> • <a href="/slo-status">SLO Status</a> • <a href="/deployment-readiness">Deployment Status</a></p>
    </div>
</body>
</html>`;
  }
  
  private convertToPrometheus(metrics: DashboardMetrics): string {
    const lines: string[] = [];
    
    // Route share metrics
    lines.push('# HELP bifrost_route_share_by_bucket Percentage of requests routed to each bucket');
    lines.push('# TYPE bifrost_route_share_by_bucket gauge');
    Object.entries(metrics.route_share_by_bucket).forEach(([bucket, share]) => {
      lines.push(`bifrost_route_share_by_bucket{bucket="${bucket}"} ${share}`);
    });
    
    // Latency metrics
    lines.push('# HELP bifrost_latency_p95_ms P95 latency in milliseconds');
    lines.push('# TYPE bifrost_latency_p95_ms gauge');
    lines.push(`bifrost_latency_p95_ms ${metrics.latency_metrics.p95}`);
    
    // Cost metrics
    lines.push('# HELP bifrost_cost_per_task_usd Average cost per task in USD');
    lines.push('# TYPE bifrost_cost_per_task_usd gauge');
    lines.push(`bifrost_cost_per_task_usd ${metrics.cost_per_task.mean}`);
    
    // Anthropic 429 rate
    lines.push('# HELP bifrost_anthropic_429_rate Rate of Anthropic 429 responses');
    lines.push('# TYPE bifrost_anthropic_429_rate gauge');
    lines.push(`bifrost_anthropic_429_rate ${metrics.anthropic_429_rate.rate}`);
    
    // Provider health
    lines.push('# HELP bifrost_provider_availability Provider availability percentage');
    lines.push('# TYPE bifrost_provider_availability gauge');
    Object.entries(metrics.provider_health).forEach(([provider, health]) => {
      lines.push(`bifrost_provider_availability{provider="${provider}"} ${health.availability}`);
    });
    
    return lines.join('\n') + '\n';
  }
  
  private sendJSON(res: any, data: any): void {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify(data, null, 2));
  }
  
  private sendNotFound(res: any): void {
    res.writeHead(404);
    res.end('Not Found');
  }
  
  private sendError(res: any, message: string, status = 500): void {
    res.writeHead(status);
    res.end(JSON.stringify({ error: message }));
  }
}