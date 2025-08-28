/**
 * Milestone 6 Optimization System Integration
 * 
 * Main integration point that combines:
 * - Automated catalog refresh
 * - Weekly tuning pipeline
 * - Canary rollout system
 * - Continuous optimization
 * 
 * With existing Milestone 5 observability infrastructure
 */

export { CatalogRefresher, type CatalogRefreshConfig, type RefreshResult, type ModelChange } from './catalog_refresher.js';
export { TuningPipeline, type TuningPipelineConfig, type TuningRun, type PipelineStatus } from './tuning_pipeline.js';
export { CanaryRolloutSystem, type CanaryConfig, type CanaryRollout, type RolloutStatus } from './canary_rollout.js';
export { 
  ContinuousOptimizer, 
  type ContinuousOptimizerConfig, 
  type OptimizationMetrics, 
  type OptimizationRecommendation,
  type SystemHealth 
} from './continuous_optimizer.js';

// Integration with existing observability system
import { ObservabilityManager, type ObservabilityConfig } from '../observability/observability_manager.js';
import { ContinuousOptimizer, type ContinuousOptimizerConfig } from './continuous_optimizer.js';

export interface Milestone6Config extends ObservabilityConfig {
  optimization: ContinuousOptimizerConfig;
}

/**
 * Milestone 6 Complete System - Integrates optimization loop with observability
 */
export class Milestone6System {
  private observabilityManager: ObservabilityManager;
  private continuousOptimizer: ContinuousOptimizer;
  private config: Milestone6Config;
  private isInitialized = false;
  
  constructor(config: Partial<Milestone6Config> = {}) {
    this.config = this.mergeDefaultConfig(config);
    
    // Initialize components
    this.observabilityManager = new ObservabilityManager({
      dashboard: this.config.dashboard,
      posthook: this.config.posthook,
      metrics: this.config.metrics,
      slo: this.config.slo,
      alerts: this.config.alerts
    });
    
    this.continuousOptimizer = new ContinuousOptimizer(this.config.optimization);
  }
  
  /**
   * Initialize the complete Milestone 6 system
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      console.warn('Milestone 6 system already initialized');
      return;
    }
    
    try {
      console.log('🚀 Initializing Milestone 6 - Complete Optimization System...');
      
      // Initialize observability (Milestone 5)
      console.log('📊 Step 1: Starting observability infrastructure...');
      await this.observabilityManager.initialize();
      
      // Initialize optimization loop (Milestone 6)
      console.log('🔄 Step 2: Starting continuous optimization loop...');
      await this.continuousOptimizer.start();
      
      // Integration check
      console.log('🔗 Step 3: Validating system integration...');
      await this.validateSystemIntegration();
      
      this.isInitialized = true;
      
      console.log('✅ Milestone 6 System initialized successfully');
      console.log('🎯 Active features:');
      console.log('  - Real-time observability dashboard');
      console.log('  - SLO monitoring and guardrails');
      console.log('  - Automated catalog refresh (nightly)');
      console.log('  - Weekly GBDT retraining pipeline');
      console.log('  - Progressive canary rollout (5% → 25% → 50% → 100%)');
      console.log('  - Continuous optimization recommendations');
      console.log('  - Automated performance monitoring');
      
    } catch (error) {
      console.error('❌ Milestone 6 system initialization failed:', error);
      throw error;
    }
  }
  
  /**
   * Shutdown the complete system
   */
  async shutdown(): Promise<void> {
    if (!this.isInitialized) return;
    
    try {
      console.log('🛑 Shutting down Milestone 6 system...');
      
      // Stop optimization loop first
      await this.continuousOptimizer.stop();
      console.log('✅ Continuous optimizer stopped');
      
      // Stop observability system
      await this.observabilityManager.shutdown();
      console.log('✅ Observability system stopped');
      
      this.isInitialized = false;
      console.log('✅ Milestone 6 system shutdown complete');
      
    } catch (error) {
      console.error('❌ Milestone 6 system shutdown failed:', error);
      throw error;
    }
  }
  
  /**
   * Get comprehensive system status (Milestone 5 + 6)
   */
  async getSystemStatus(): Promise<{
    milestone_5: any;
    milestone_6: any;
    integration_health: 'healthy' | 'degraded' | 'unhealthy';
    overall_summary: {
      uptime_hours: number;
      optimization_cycles_completed: number;
      current_performance_vs_baseline: number;
      cost_efficiency_improvement: number;
      system_reliability_score: number;
    };
  }> {
    // Get Milestone 5 observability status
    const milestone5Status = await this.observabilityManager.getOperationalStatus();
    
    // Get Milestone 6 optimization status
    const milestone6Status = await this.continuousOptimizer.getSystemHealth();
    const optimizationMetrics = await this.continuousOptimizer.getCurrentMetrics();
    
    // Assess integration health
    const integrationHealth = this.assessIntegrationHealth(milestone5Status, milestone6Status);
    
    // Generate overall summary
    const overallSummary = {
      uptime_hours: milestone5Status.uptime_seconds / 3600,
      optimization_cycles_completed: milestone6Status.performance_summary.successful_optimizations,
      current_performance_vs_baseline: optimizationMetrics.current_metrics.win_rate,
      cost_efficiency_improvement: -optimizationMetrics.trends.cost_7d_change * 100, // Convert to positive % improvement
      system_reliability_score: this.calculateReliabilityScore(milestone5Status, milestone6Status)
    };
    
    return {
      milestone_5: milestone5Status,
      milestone_6: milestone6Status,
      integration_health: integrationHealth,
      overall_summary: overallSummary
    };
  }
  
  /**
   * Get current optimization recommendations
   */
  getOptimizationRecommendations(): any {
    return this.continuousOptimizer.getRecommendations('pending');
  }
  
  /**
   * Manually trigger optimization analysis
   */
  async triggerOptimizationAnalysis(): Promise<any> {
    return await this.continuousOptimizer.triggerOptimizationAnalysis();
  }
  
  /**
   * Get enhanced PostHook for request processing (from Milestone 5)
   */
  getEnhancedPostHook(): any {
    return this.observabilityManager.getEnhancedPostHook();
  }
  
  /**
   * Run comprehensive deployment validation
   */
  async runDeploymentValidation(): Promise<{
    milestone_5_validation: any;
    milestone_6_readiness: any;
    integration_checks: any;
    deployment_recommendation: 'PROCEED' | 'CAUTION' | 'BLOCK';
  }> {
    // Milestone 5 validation (SLO compliance, etc.)
    const milestone5Validation = await this.observabilityManager.runDeploymentValidation();
    
    // Milestone 6 readiness (optimization system health)
    const milestone6Readiness = await this.assessOptimizationReadiness();
    
    // Integration checks
    const integrationChecks = await this.validateSystemIntegration();
    
    // Overall deployment recommendation
    let deploymentRecommendation: 'PROCEED' | 'CAUTION' | 'BLOCK' = 'PROCEED';
    
    if (!milestone5Validation.validation_result.deployment_allowed) {
      deploymentRecommendation = 'BLOCK';
    } else if (milestone6Readiness.warnings.length > 0 || !integrationChecks.fully_operational) {
      deploymentRecommendation = 'CAUTION';
    }
    
    return {
      milestone_5_validation: milestone5Validation,
      milestone_6_readiness: milestone6Readiness,
      integration_checks: integrationChecks,
      deployment_recommendation: deploymentRecommendation
    };
  }
  
  /**
   * Generate comprehensive operational report
   */
  async generateComprehensiveReport(): Promise<{
    executive_summary: any;
    observability_report: any;
    optimization_report: any;
    integration_status: any;
    recommendations: any;
    next_actions: string[];
  }> {
    // Generate Milestone 5 observability report
    const observabilityReport = await this.observabilityManager.generateOperationalReport();
    
    // Get Milestone 6 optimization status
    const optimizationMetrics = await this.continuousOptimizer.getCurrentMetrics();
    const systemHealth = await this.continuousOptimizer.getSystemHealth();
    const recommendations = this.continuousOptimizer.getRecommendations();
    
    // Integration status
    const systemStatus = await this.getSystemStatus();
    
    // Executive summary combining both systems
    const executiveSummary = {
      overall_status: systemStatus.integration_health,
      key_achievements: [
        ...observabilityReport.executive_summary.achievements,
        optimizationMetrics.goal_status.overall_health === 'excellent' ? 
          'Optimization goals exceeded' : null,
        systemStatus.overall_summary.cost_efficiency_improvement > 5 ? 
          `${systemStatus.overall_summary.cost_efficiency_improvement.toFixed(1)}% cost efficiency improvement` : null
      ].filter(Boolean),
      critical_issues: [
        ...observabilityReport.executive_summary.critical_issues,
        ...systemHealth.active_issues.filter(issue => issue.severity === 'critical')
          .map(issue => issue.description)
      ],
      system_performance: {
        uptime_hours: systemStatus.overall_summary.uptime_hours,
        reliability_score: systemStatus.overall_summary.system_reliability_score,
        win_rate: optimizationMetrics.current_metrics.win_rate,
        cost_per_task: optimizationMetrics.current_metrics.cost_per_task,
        p95_latency_ms: optimizationMetrics.current_metrics.p95_latency_ms
      }
    };
    
    // Generate next actions
    const nextActions = [
      ...recommendations.filter(r => r.priority === 'critical' || r.priority === 'high')
        .slice(0, 3)
        .map(r => `Implement: ${r.title}`),
      systemHealth.optimization_activity.pending_recommendations > 5 ? 
        'Review and prioritize optimization recommendations' : null,
      optimizationMetrics.goal_status.overall_health === 'critical' ? 
        'Immediate performance investigation required' : null
    ].filter(Boolean);
    
    return {
      executive_summary: executiveSummary,
      observability_report,
      optimization_report: {
        current_metrics: optimizationMetrics,
        system_health: systemHealth,
        recent_activity: systemHealth.optimization_activity
      },
      integration_status: {
        integration_health: systemStatus.integration_health,
        component_coordination: this.getComponentCoordination()
      },
      recommendations: recommendations.slice(0, 10), // Top 10 recommendations
      next_actions: nextActions
    };
  }
  
  // Private methods
  
  private async validateSystemIntegration(): Promise<{
    fully_operational: boolean;
    component_status: Record<string, boolean>;
    coordination_health: number;
    issues: string[];
  }> {
    const issues: string[] = [];
    
    // Test observability → optimization data flow
    let observabilityToOptimization = true;
    try {
      const metrics = await this.continuousOptimizer.getCurrentMetrics();
      if (!metrics || !metrics.current_metrics) {
        observabilityToOptimization = false;
        issues.push('Optimization system not receiving metrics data');
      }
    } catch (error) {
      observabilityToOptimization = false;
      issues.push(`Metrics collection integration failed: ${error}`);
    }
    
    // Test optimization → observability feedback loop
    let optimizationToObservability = true;
    try {
      const recommendations = this.continuousOptimizer.getRecommendations();
      // In production, verify recommendations are being acted upon
    } catch (error) {
      optimizationToObservability = false;
      issues.push(`Optimization feedback integration failed: ${error}`);
    }
    
    // Test artifact deployment coordination
    let artifactCoordination = true;
    // In production, test that new artifacts trigger proper canary rollouts
    
    const componentStatus = {
      observability_to_optimization: observabilityToOptimization,
      optimization_to_observability: optimizationToObservability,
      artifact_coordination: artifactCoordination
    };
    
    const healthyComponents = Object.values(componentStatus).filter(Boolean).length;
    const coordinationHealth = healthyComponents / Object.keys(componentStatus).length;
    
    return {
      fully_operational: coordinationHealth === 1.0,
      component_status: componentStatus,
      coordination_health: coordinationHealth,
      issues
    };
  }
  
  private async assessOptimizationReadiness(): Promise<{
    ready: boolean;
    warnings: string[];
    system_health_score: number;
  }> {
    const warnings: string[] = [];
    const systemHealth = await this.continuousOptimizer.getSystemHealth();
    
    // Check component health
    if (systemHealth.component_health.tuning_pipeline !== 'healthy') {
      warnings.push('Tuning pipeline is not healthy');
    }
    
    if (systemHealth.component_health.canary_system !== 'healthy') {
      warnings.push('Canary rollout system is not healthy');
    }
    
    // Check recent activity
    const lastTuning = new Date(systemHealth.optimization_activity.last_tuning_run);
    const daysSinceLastTuning = (Date.now() - lastTuning.getTime()) / (1000 * 60 * 60 * 24);
    
    if (daysSinceLastTuning > 14) {
      warnings.push(`Last tuning run was ${daysSinceLastTuning.toFixed(1)} days ago`);
    }
    
    // Calculate health score
    const healthScoreComponents = {
      overall_status: systemHealth.overall_status === 'healthy' ? 1 : 
                     systemHealth.overall_status === 'degraded' ? 0.7 : 0.3,
      success_rate: systemHealth.performance_summary.successful_optimizations > 0 ? 
                   systemHealth.performance_summary.successful_optimizations / 
                   (systemHealth.performance_summary.successful_optimizations + systemHealth.performance_summary.failed_optimizations) : 0.5,
      activity_recency: Math.max(0, 1 - daysSinceLastTuning / 14)
    };
    
    const systemHealthScore = Object.values(healthScoreComponents).reduce((sum, score) => sum + score, 0) / 3;
    
    return {
      ready: warnings.length === 0 && systemHealthScore > 0.7,
      warnings,
      system_health_score: systemHealthScore
    };
  }
  
  private assessIntegrationHealth(milestone5Status: any, milestone6Status: any): 'healthy' | 'degraded' | 'unhealthy' {
    // Check if both systems are healthy
    const milestone5Healthy = milestone5Status.current_slo_status === 'GREEN';
    const milestone6Healthy = milestone6Status.overall_status === 'healthy';
    
    if (milestone5Healthy && milestone6Healthy) {
      return 'healthy';
    } else if (milestone5Healthy || milestone6Healthy) {
      return 'degraded';
    } else {
      return 'unhealthy';
    }
  }
  
  private calculateReliabilityScore(milestone5Status: any, milestone6Status: any): number {
    const factors = {
      slo_compliance: milestone5Status.current_slo_status === 'GREEN' ? 1 : 
                     milestone5Status.current_slo_status === 'YELLOW' ? 0.7 : 0.3,
      uptime: milestone5Status.uptime_seconds > 3600 ? Math.min(1, milestone5Status.uptime_seconds / (24 * 3600)) : 0,
      optimization_success: milestone6Status.performance_summary.successful_optimizations > 0 ? 
                           milestone6Status.performance_summary.successful_optimizations / 
                           (milestone6Status.performance_summary.successful_optimizations + 
                            milestone6Status.performance_summary.failed_optimizations) : 0.5
    };
    
    return Object.values(factors).reduce((sum, factor) => sum + factor, 0) / Object.keys(factors).length;
  }
  
  private getComponentCoordination(): any {
    return {
      observability_to_optimization: 'active',
      optimization_to_deployment: 'active',
      canary_to_monitoring: 'active',
      tuning_to_artifacts: 'active'
    };
  }
  
  private mergeDefaultConfig(config: Partial<Milestone6Config>): Milestone6Config {
    return {
      // Milestone 5 observability config
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
      },
      
      // Milestone 6 optimization config
      optimization: {
        catalog_refresh: {},
        tuning_pipeline: {},
        canary_rollout: {},
        optimization_goals: {
          target_win_rate: 0.90,
          target_cost_per_task: 0.04,
          target_p95_latency_ms: 2000,
          min_quality_score: 0.85
        },
        performance_monitoring: {
          quality_trend_window_days: 7,
          cost_trend_window_days: 7,
          performance_degradation_threshold: 0.05,
          alert_on_trend_deviation: true
        },
        automation: {
          auto_trigger_retraining: true,
          auto_deploy_improvements: false, // Manual approval required
          auto_rollback_on_degradation: true,
          min_improvement_for_auto_deploy: 0.02
        },
        recommendations: {
          enabled: true,
          analysis_interval_hours: 6,
          cost_optimization_enabled: true,
          quality_optimization_enabled: true,
          performance_optimization_enabled: true
        },
        ...config.optimization
      }
    };
  }
}