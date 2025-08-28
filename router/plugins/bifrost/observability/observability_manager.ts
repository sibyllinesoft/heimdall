/**
 * Observability Manager - Central coordinator for Milestone 5 observability features
 * Integrates metrics collection, dashboard server, SLO guardrails, and operational tooling
 */

import { EnhancedPostHook, EnhancedPostHookConfig } from './enhanced_posthook.js';
import { DashboardServer, DashboardConfig } from './dashboard_server.js';
import { MetricsCollector } from './metrics_collector.js';
import { SLOGuardrails } from './slo_guardrails.js';

export interface ObservabilityConfig {
  dashboard: Partial<DashboardConfig>;
  posthook: Partial<EnhancedPostHookConfig>;
  metrics: {
    retentionDays: number;
    sampleRate: number;
    enableWarehouseEmission: boolean;
  };
  slo: {
    p95LatencyMs: number;
    maxFailoverMisfireRate: number;
    minUptimePercentage: number;
    maxCostPerTask: number;
    minWinRate: number;
  };
  alerts: {
    enabled: boolean;
    webhookUrl?: string;
    slackChannel?: string;
    emailRecipients?: string[];
  };
}

export interface OperationalStatus {
  components: {
    metrics_collector: 'healthy' | 'degraded' | 'unhealthy';
    dashboard_server: 'running' | 'stopped' | 'error';
    slo_guardrails: 'compliant' | 'violation' | 'unknown';
    warehouse_connection: 'connected' | 'disconnected' | 'error';
  };
  uptime_seconds: number;
  total_requests_processed: number;
  current_slo_status: 'GREEN' | 'YELLOW' | 'RED';
  deployment_readiness: 'READY' | 'CAUTION' | 'BLOCKED';
  last_health_check: string;
}

/**
 * Central manager for all observability components
 */
export class ObservabilityManager {
  private enhancedPostHook: EnhancedPostHook;
  private dashboardServer: DashboardServer;
  private metricsCollector: MetricsCollector;
  private sloGuardrails: SLOGuardrails;
  private config: ObservabilityConfig;
  private startTime: Date;
  private isInitialized = false;
  
  constructor(config: Partial<ObservabilityConfig> = {}) {
    this.startTime = new Date();
    this.config = this.mergeConfig(config);
    
    // Initialize components
    this.enhancedPostHook = new EnhancedPostHook(this.config.posthook);
    this.metricsCollector = this.enhancedPostHook.getMetricsCollector();
    this.sloGuardrails = this.enhancedPostHook.getSLOGuardrails();
    this.dashboardServer = new DashboardServer(this.metricsCollector, this.config.dashboard);
    
    // Update SLO thresholds
    this.metricsCollector.updateSLOThresholds({
      p95_latency_ms: this.config.slo.p95LatencyMs,
      max_failover_misfire_rate: this.config.slo.maxFailoverMisfireRate,
      min_uptime_percentage: this.config.slo.minUptimePercentage,
      max_cost_per_task: this.config.slo.maxCostPerTask,
      min_win_rate: this.config.slo.minWinRate
    });
  }
  
  /**
   * Initialize all observability components
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      console.warn('Observability manager already initialized');
      return;
    }
    
    try {
      console.log('🚀 Initializing Bifrost Router Observability...');
      
      // Start dashboard server
      await this.dashboardServer.start();
      console.log('✅ Dashboard server started');
      
      // Test warehouse connection if configured
      if (this.config.posthook.warehouseEndpoint) {
        await this.testWarehouseConnection();
      }
      
      // Run initial SLO validation
      const sloStatus = await this.sloGuardrails.validateDeployment();
      console.log(`🏥 Initial SLO status: ${sloStatus.deployment_allowed ? 'COMPLIANT' : 'VIOLATION'}`);
      
      // Set up periodic health checks
      this.startHealthCheckLoop();
      
      this.isInitialized = true;
      console.log('✅ Observability manager initialized successfully');
      
    } catch (error) {
      console.error('❌ Observability initialization failed:', error);
      throw error;
    }
  }
  
  /**
   * Shutdown all observability components
   */
  async shutdown(): Promise<void> {
    if (!this.isInitialized) return;
    
    try {
      console.log('🛡️ Shutting down observability components...');
      
      await this.dashboardServer.stop();
      console.log('✅ Dashboard server stopped');
      
      this.isInitialized = false;
      console.log('✅ Observability manager shutdown complete');
      
    } catch (error) {
      console.error('❌ Observability shutdown failed:', error);
      throw error;
    }
  }
  
  /**
   * Get enhanced PostHook for request processing
   */
  getEnhancedPostHook(): EnhancedPostHook {
    return this.enhancedPostHook;
  }
  
  /**
   * Get comprehensive operational status
   */
  async getOperationalStatus(): Promise<OperationalStatus> {
    const dashboardMetrics = this.metricsCollector.getDashboardMetrics();
    const sloStatus = this.metricsCollector.checkSLOCompliance();
    const deploymentReadiness = this.metricsCollector.getDeploymentReadiness();
    
    // Test warehouse connection
    let warehouseStatus: 'connected' | 'disconnected' | 'error' = 'disconnected';
    if (this.config.posthook.warehouseEndpoint) {
      try {
        await this.testWarehouseConnection();
        warehouseStatus = 'connected';
      } catch (error) {
        warehouseStatus = 'error';
      }
    }
    
    // Determine overall SLO status
    let currentSloStatus: 'GREEN' | 'YELLOW' | 'RED' = 'GREEN';
    if (!sloStatus.compliant) {
      currentSloStatus = sloStatus.violations.some(v => 
        v.includes('P95 latency') || v.includes('uptime')
      ) ? 'RED' : 'YELLOW';
    }
    
    // Determine deployment readiness
    let deploymentStatus: 'READY' | 'CAUTION' | 'BLOCKED' = 'READY';
    if (!deploymentReadiness.ready) {
      deploymentStatus = 'BLOCKED';
    } else if (deploymentReadiness.warnings.length > 0) {
      deploymentStatus = 'CAUTION';
    }
    
    return {
      components: {
        metrics_collector: this.assessMetricsCollectorHealth(),
        dashboard_server: 'running', // Simplified - would check actual server status
        slo_guardrails: sloStatus.compliant ? 'compliant' : 'violation',
        warehouse_connection: warehouseStatus
      },
      uptime_seconds: Math.floor((Date.now() - this.startTime.getTime()) / 1000),
      total_requests_processed: this.metricsCollector.exportMetrics().length,
      current_slo_status: currentSloStatus,
      deployment_readiness: deploymentStatus,
      last_health_check: new Date().toISOString()
    };
  }
  
  /**
   * Run deployment validation and return detailed report
   */
  async runDeploymentValidation(): Promise<{
    validation_result: any;
    deployment_report: any;
    emergency_rollback_check: any;
    recommendations: string[];
  }> {
    const validationResult = await this.sloGuardrails.validateDeployment();
    const deploymentReport = this.sloGuardrails.generateDeploymentReport();
    const emergencyCheck = this.sloGuardrails.checkEmergencyRollback();
    
    const recommendations: string[] = [];
    
    if (!validationResult.deployment_allowed) {
      recommendations.push('🚫 DEPLOYMENT BLOCKED - Address SLO violations before proceeding');
      validationResult.blocking_failures.forEach(failure => {
        recommendations.push(`  - ${failure.message}`);
      });
    }
    
    if (emergencyCheck.rollback_required) {
      recommendations.push(`🚨 EMERGENCY ROLLBACK REQUIRED: ${emergencyCheck.reason}`);
    }
    
    if (deploymentReport.optimization_opportunities.length > 0) {
      recommendations.push('💡 Optimization opportunities:');
      deploymentReport.optimization_opportunities.forEach(opt => {
        recommendations.push(`  - ${opt}`);
      });
    }
    
    return {
      validation_result: validationResult,
      deployment_report: deploymentReport,
      emergency_rollback_check: emergencyCheck,
      recommendations
    };
  }
  
  /**
   * Generate comprehensive operational report
   */
  async generateOperationalReport(timeWindow?: number): Promise<{
    executive_summary: {
      status: 'GREEN' | 'YELLOW' | 'RED';
      key_metrics: Record<string, number>;
      critical_issues: string[];
      achievements: string[];
    };
    detailed_metrics: any;
    slo_compliance: any;
    deployment_readiness: any;
    cost_analysis: {
      current_burn_rate: number;
      projected_monthly: number;
      efficiency_score: number;
      optimization_potential: string[];
    };
    performance_analysis: {
      latency_trends: string;
      provider_rankings: Array<{ provider: string; score: number }>;
      bottlenecks: string[];
    };
  }> {
    const operationalStatus = await this.getOperationalStatus();
    const dashboardMetrics = this.metricsCollector.getDashboardMetrics(timeWindow);
    const sloCompliance = this.metricsCollector.checkSLOCompliance();
    const deploymentReadiness = this.metricsCollector.getDeploymentReadiness();
    
    // Executive summary
    const keyMetrics = {
      p95_latency_ms: dashboardMetrics.latency_metrics.p95,
      uptime_percentage: dashboardMetrics.slo_status.uptime_percentage,
      cost_per_task: dashboardMetrics.cost_per_task.mean,
      win_rate: dashboardMetrics.win_rate_vs_baseline.overall,
      anthropic_429_rate: dashboardMetrics.anthropic_429_rate.rate
    };
    
    const criticalIssues: string[] = [];
    const achievements: string[] = [];
    
    if (!sloCompliance.compliant) {
      criticalIssues.push(...sloCompliance.violations);
    } else {
      achievements.push('All SLO thresholds met');
    }
    
    if (dashboardMetrics.cost_per_task.mean < 0.05) {
      achievements.push('Cost efficiency target achieved');
    }
    
    if (dashboardMetrics.win_rate_vs_baseline.overall > 0.9) {
      achievements.push('Win rate exceeds 90% baseline');
    }
    
    // Cost analysis
    const totalRequests = Object.values(dashboardMetrics.route_share_by_bucket)
      .reduce((sum, share) => sum + share, 0) * 1000; // Estimate
    const currentBurnRate = dashboardMetrics.cost_per_task.mean * totalRequests;
    const projectedMonthly = currentBurnRate * 30;
    
    const efficiencyScore = Math.min(
      dashboardMetrics.win_rate_vs_baseline.overall / dashboardMetrics.cost_per_task.mean * 10,
      100
    );
    
    // Performance analysis
    const providerRankings = Object.entries(dashboardMetrics.provider_health)
      .map(([provider, health]) => ({
        provider,
        score: health.availability * 0.4 + (1 - health.error_rate) * 0.3 + 
               Math.max(0, (3000 - health.avg_latency) / 3000) * 0.3
      }))
      .sort((a, b) => b.score - a.score);
    
    const bottlenecks: string[] = [];
    if (dashboardMetrics.latency_metrics.p95 > 2000) {
      bottlenecks.push('High P95 latency indicating performance issues');
    }
    
    Object.entries(dashboardMetrics.latency_metrics.by_provider).forEach(([provider, latency]) => {
      if (latency > 3000) {
        bottlenecks.push(`Provider ${provider} showing high latency (${latency.toFixed(0)}ms)`);
      }
    });
    
    return {
      executive_summary: {
        status: operationalStatus.current_slo_status,
        key_metrics: keyMetrics,
        critical_issues: criticalIssues,
        achievements
      },
      detailed_metrics: dashboardMetrics,
      slo_compliance: sloCompliance,
      deployment_readiness: deploymentReadiness,
      cost_analysis: {
        current_burn_rate: currentBurnRate,
        projected_monthly: projectedMonthly,
        efficiency_score: efficiencyScore,
        optimization_potential: [
          dashboardMetrics.route_share_by_bucket.hard > 0.3 ? 
            'Consider tightening hard bucket criteria' : null,
          dashboardMetrics.cost_per_task.mean > 0.05 ? 
            'Review thinking budget allocations' : null,
          dashboardMetrics.anthropic_429_rate.rate > 0.05 ? 
            'Optimize Anthropic usage patterns' : null
        ].filter(Boolean) as string[]
      },
      performance_analysis: {
        latency_trends: dashboardMetrics.latency_metrics.p95 > 2500 ? 'CONCERNING' : 
                       dashboardMetrics.latency_metrics.p95 > 2000 ? 'ELEVATED' : 'GOOD',
        provider_rankings: providerRankings,
        bottlenecks
      }
    };
  }
  
  private mergeConfig(config: Partial<ObservabilityConfig>): ObservabilityConfig {
    return {
      dashboard: {
        port: 8090,
        enableCORS: true,
        refreshIntervalMs: 30000,
        historyRetentionDays: 7,
        alertThresholds: {
          p95LatencyMs: 2500,
          failoverMisfireRate: 0.05,
          costPerTaskThreshold: 0.10,
          minWinRate: 0.85
        },
        ...config.dashboard
      },
      posthook: {
        enableWarehouseEmission: true,
        enableRealTimeAlerting: true,
        logToFile: true,
        logToConsole: true,
        warehouseEndpoint: process.env.METRICS_WAREHOUSE_URL,
        alertWebhook: process.env.ALERT_WEBHOOK_URL,
        ...config.posthook
      },
      metrics: {
        retentionDays: 7,
        sampleRate: 1.0,
        enableWarehouseEmission: true,
        ...config.metrics
      },
      slo: {
        p95LatencyMs: 2500,
        maxFailoverMisfireRate: 0.05,
        minUptimePercentage: 99.5,
        maxCostPerTask: 0.10,
        minWinRate: 0.85,
        ...config.slo
      },
      alerts: {
        enabled: true,
        webhookUrl: process.env.ALERT_WEBHOOK_URL,
        ...config.alerts
      }
    };
  }
  
  private assessMetricsCollectorHealth(): 'healthy' | 'degraded' | 'unhealthy' {
    const metrics = this.metricsCollector.exportMetrics(5 * 60 * 1000); // Last 5 minutes
    
    if (metrics.length === 0) {
      return 'unhealthy';
    }
    
    const recentSuccessRate = metrics.filter(m => m.success).length / metrics.length;
    if (recentSuccessRate < 0.5) {
      return 'unhealthy';
    } else if (recentSuccessRate < 0.9) {
      return 'degraded';
    }
    
    return 'healthy';
  }
  
  private async testWarehouseConnection(): Promise<void> {
    if (!this.config.posthook.warehouseEndpoint) return;
    
    const response = await fetch(this.config.posthook.warehouseEndpoint, {
      method: 'GET',
      headers: { 'User-Agent': 'Bifrost-Router-HealthCheck/1.0' }
    });
    
    if (!response.ok) {
      throw new Error(`Warehouse health check failed: ${response.status}`);
    }
  }
  
  private startHealthCheckLoop(): void {
    setInterval(async () => {
      try {
        const status = await this.getOperationalStatus();
        if (status.current_slo_status === 'RED') {
          console.warn('🚨 RED SLO status detected - immediate attention required');
        }
      } catch (error) {
        console.warn('Health check loop error:', error);
      }
    }, 60000); // Every minute
  }
}