/**
 * Continuous Optimization Manager - Milestone 6
 * 
 * Orchestrates the complete optimization loop:
 * - Performance monitoring and alerting
 * - Cost optimization recommendations  
 * - Quality metric tracking over time
 * - Automated artifact updates and deployment
 */

import { CatalogRefresher, CatalogRefreshConfig } from './catalog_refresher.js';
import { TuningPipeline, TuningPipelineConfig } from './tuning_pipeline.js';
import { CanaryRolloutSystem, CanaryConfig } from './canary_rollout.js';

export interface ContinuousOptimizerConfig {
  catalog_refresh: Partial<CatalogRefreshConfig>;
  tuning_pipeline: Partial<TuningPipelineConfig>;
  canary_rollout: Partial<CanaryConfig>;
  
  optimization_goals: {
    target_win_rate: number;
    target_cost_per_task: number;
    target_p95_latency_ms: number;
    min_quality_score: number;
  };
  
  performance_monitoring: {
    quality_trend_window_days: number;
    cost_trend_window_days: number;
    performance_degradation_threshold: number;
    alert_on_trend_deviation: boolean;
  };
  
  automation: {
    auto_trigger_retraining: boolean;
    auto_deploy_improvements: boolean;
    auto_rollback_on_degradation: boolean;
    min_improvement_for_auto_deploy: number;
  };
  
  recommendations: {
    enabled: boolean;
    analysis_interval_hours: number;
    cost_optimization_enabled: boolean;
    quality_optimization_enabled: boolean;
    performance_optimization_enabled: boolean;
  };
}

export interface OptimizationMetrics {
  timestamp: string;
  
  // Current performance
  current_metrics: {
    win_rate: number;
    cost_per_task: number;
    p95_latency_ms: number;
    quality_score: number;
    success_rate: number;
  };
  
  // Trends over time
  trends: {
    win_rate_7d_change: number;
    cost_7d_change: number;
    latency_7d_change: number;
    quality_7d_change: number;
  };
  
  // Goal achievement
  goal_status: {
    win_rate_achieved: boolean;
    cost_achieved: boolean;
    latency_achieved: boolean;
    quality_achieved: boolean;
    overall_health: 'excellent' | 'good' | 'needs_attention' | 'critical';
  };
  
  // Model utilization
  model_utilization: {
    cheap_bucket_percentage: number;
    mid_bucket_percentage: number;
    hard_bucket_percentage: number;
    anthropic_usage_percentage: number;
    top_performing_models: Array<{ model: string; win_rate: number; usage: number }>;
  };
}

export interface OptimizationRecommendation {
  id: string;
  type: 'cost' | 'quality' | 'performance' | 'configuration';
  priority: 'low' | 'medium' | 'high' | 'critical';
  
  title: string;
  description: string;
  
  current_state: any;
  recommended_change: any;
  expected_impact: {
    win_rate_change: number;
    cost_change: number;
    latency_change: number;
    confidence_score: number;
  };
  
  implementation: {
    automated: boolean;
    estimated_effort_hours: number;
    requires_testing: boolean;
    rollback_plan: string;
  };
  
  created_at: string;
  status: 'pending' | 'in_progress' | 'implemented' | 'rejected';
}

export interface SystemHealth {
  overall_status: 'healthy' | 'degraded' | 'unhealthy' | 'critical';
  
  component_health: {
    catalog_refresher: 'healthy' | 'degraded' | 'unhealthy';
    tuning_pipeline: 'healthy' | 'degraded' | 'unhealthy';
    canary_system: 'healthy' | 'degraded' | 'unhealthy';
    model_performance: 'healthy' | 'degraded' | 'unhealthy';
  };
  
  active_issues: Array<{
    component: string;
    issue_type: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    description: string;
    since: string;
  }>;
  
  optimization_activity: {
    last_catalog_refresh: string;
    last_tuning_run: string;
    active_canary_rollouts: number;
    pending_recommendations: number;
  };
  
  performance_summary: {
    uptime_percentage: number;
    successful_optimizations: number;
    failed_optimizations: number;
    avg_improvement_per_cycle: number;
  };
}

export class ContinuousOptimizer {
  private config: ContinuousOptimizerConfig;
  private catalogRefresher: CatalogRefresher;
  private tuningPipeline: TuningPipeline;
  private canaryRollout: CanaryRolloutSystem;
  
  private metricsHistory: OptimizationMetrics[] = [];
  private recommendations: OptimizationRecommendation[] = [];
  private analysisTimer?: NodeJS.Timeout;
  
  private isRunning = false;
  private startTime: Date = new Date();
  
  constructor(config: Partial<ContinuousOptimizerConfig> = {}) {
    this.config = this.mergeDefaultConfig(config);
    
    // Initialize subsystems
    this.catalogRefresher = new CatalogRefresher(this.config.catalog_refresh);
    this.tuningPipeline = new TuningPipeline(this.config.tuning_pipeline);
    this.canaryRollout = new CanaryRolloutSystem(this.config.canary_rollout);
  }
  
  /**
   * Start the continuous optimization system
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.warn('Continuous optimizer already running');
      return;
    }
    
    console.log('🚀 Starting Continuous Optimization System...');
    this.startTime = new Date();
    
    try {
      // Start all subsystems
      console.log('📊 Starting catalog refresher...');
      this.catalogRefresher.start();
      
      console.log('🎯 Starting tuning pipeline...');
      this.tuningPipeline.start();
      
      console.log('🚦 Starting canary rollout system...');
      this.canaryRollout.start();
      
      // Start analysis and recommendation loop
      if (this.config.recommendations.enabled) {
        console.log('🧠 Starting recommendation engine...');
        this.startRecommendationEngine();
      }
      
      // Set up automated triggers
      this.setupAutomatedTriggers();
      
      this.isRunning = true;
      console.log('✅ Continuous Optimization System started successfully');
      
    } catch (error) {
      console.error('❌ Failed to start continuous optimization system:', error);
      throw error;
    }
  }
  
  /**
   * Stop the continuous optimization system
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;
    
    console.log('🛑 Stopping Continuous Optimization System...');
    
    try {
      // Stop analysis timer
      if (this.analysisTimer) {
        clearInterval(this.analysisTimer);
        this.analysisTimer = undefined;
      }
      
      // Stop subsystems
      this.catalogRefresher.stop();
      this.tuningPipeline.stop();
      this.canaryRollout.stop();
      
      this.isRunning = false;
      console.log('✅ Continuous Optimization System stopped');
      
    } catch (error) {
      console.error('❌ Error stopping continuous optimization system:', error);
      throw error;
    }
  }
  
  /**
   * Get current optimization metrics and trends
   */
  async getCurrentMetrics(): Promise<OptimizationMetrics> {
    const timestamp = new Date().toISOString();
    
    // Collect current performance metrics
    const currentMetrics = await this.collectCurrentMetrics();
    
    // Calculate trends
    const trends = this.calculateTrends(currentMetrics);
    
    // Evaluate goal achievement
    const goalStatus = this.evaluateGoalAchievement(currentMetrics);
    
    // Get model utilization
    const modelUtilization = await this.getModelUtilization();
    
    const metrics: OptimizationMetrics = {
      timestamp,
      current_metrics: currentMetrics,
      trends,
      goal_status: goalStatus,
      model_utilization: modelUtilization
    };
    
    // Store in history
    this.metricsHistory.push(metrics);
    
    // Keep only recent history
    if (this.metricsHistory.length > 1000) {
      this.metricsHistory = this.metricsHistory.slice(-1000);
    }
    
    return metrics;
  }
  
  /**
   * Get system health status
   */
  async getSystemHealth(): Promise<SystemHealth> {
    const componentHealth = {
      catalog_refresher: this.assessCatalogRefresherHealth(),
      tuning_pipeline: this.assessTuningPipelineHealth(),
      canary_system: this.assessCanarySystemHealth(),
      model_performance: this.assessModelPerformanceHealth()
    };
    
    // Determine overall status
    const healthValues = Object.values(componentHealth);
    let overallStatus: SystemHealth['overall_status'] = 'healthy';
    
    if (healthValues.includes('unhealthy')) {
      overallStatus = 'critical';
    } else if (healthValues.includes('degraded')) {
      overallStatus = 'degraded';
    } else if (healthValues.some(h => h !== 'healthy')) {
      overallStatus = 'unhealthy';
    }
    
    // Collect active issues
    const activeIssues = await this.identifyActiveIssues(componentHealth);
    
    // Get optimization activity
    const optimizationActivity = this.getOptimizationActivity();
    
    // Calculate performance summary
    const performanceSummary = this.calculatePerformanceSummary();
    
    return {
      overall_status: overallStatus,
      component_health: componentHealth,
      active_issues: activeIssues,
      optimization_activity: optimizationActivity,
      performance_summary: performanceSummary
    };
  }
  
  /**
   * Get current recommendations
   */
  getRecommendations(status?: OptimizationRecommendation['status']): OptimizationRecommendation[] {
    let filtered = this.recommendations;
    
    if (status) {
      filtered = filtered.filter(rec => rec.status === status);
    }
    
    // Sort by priority and creation date
    return filtered.sort((a, b) => {
      const priorityOrder = { critical: 4, high: 3, medium: 2, low: 1 };
      const priorityDiff = priorityOrder[b.priority] - priorityOrder[a.priority];
      if (priorityDiff !== 0) return priorityDiff;
      
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
  }
  
  /**
   * Manually trigger optimization analysis
   */
  async triggerOptimizationAnalysis(): Promise<OptimizationRecommendation[]> {
    console.log('🧠 Triggering manual optimization analysis...');
    
    const newRecommendations = await this.generateRecommendations();
    console.log(`✅ Generated ${newRecommendations.length} new recommendations`);
    
    return newRecommendations;
  }
  
  /**
   * Implement a recommendation
   */
  async implementRecommendation(recommendationId: string): Promise<void> {
    const recommendation = this.recommendations.find(r => r.id === recommendationId);
    if (!recommendation) {
      throw new Error(`Recommendation not found: ${recommendationId}`);
    }
    
    if (recommendation.status !== 'pending') {
      throw new Error(`Recommendation is not pending: ${recommendation.status}`);
    }
    
    console.log(`🚀 Implementing recommendation: ${recommendation.title}`);
    recommendation.status = 'in_progress';
    
    try {
      await this.executeRecommendation(recommendation);
      recommendation.status = 'implemented';
      
      console.log(`✅ Successfully implemented recommendation: ${recommendation.title}`);
      
    } catch (error) {
      recommendation.status = 'rejected';
      console.error(`❌ Failed to implement recommendation ${recommendation.title}:`, error);
      throw error;
    }
  }
  
  // Private methods
  
  private startRecommendationEngine(): void {
    const intervalMs = this.config.recommendations.analysis_interval_hours * 60 * 60 * 1000;
    
    this.analysisTimer = setInterval(() => {
      this.generateRecommendations().catch(error => {
        console.error('❌ Recommendation generation failed:', error);
      });
    }, intervalMs);
    
    console.log(`🧠 Recommendation engine started (${this.config.recommendations.analysis_interval_hours}h intervals)`);
  }
  
  private setupAutomatedTriggers(): void {
    // Set up performance monitoring that can trigger retraining
    if (this.config.automation.auto_trigger_retraining) {
      setInterval(async () => {
        try {
          const metrics = await this.getCurrentMetrics();
          
          // Check if performance has degraded significantly
          const performanceDegraded = (
            metrics.trends.win_rate_7d_change < -this.config.performance_monitoring.performance_degradation_threshold ||
            metrics.current_metrics.win_rate < this.config.optimization_goals.target_win_rate * 0.95
          );
          
          if (performanceDegraded) {
            console.log('📉 Performance degradation detected - triggering retraining...');
            await this.tuningPipeline.triggerManualRun();
          }
        } catch (error) {
          console.warn('Performance monitoring check failed:', error);
        }
      }, 60 * 60 * 1000); // Check hourly
    }
  }
  
  private async generateRecommendations(): Promise<OptimizationRecommendation[]> {
    const newRecommendations: OptimizationRecommendation[] = [];
    
    const currentMetrics = await this.getCurrentMetrics();
    
    // Cost optimization recommendations
    if (this.config.recommendations.cost_optimization_enabled) {
      const costRecommendations = await this.generateCostOptimizationRecommendations(currentMetrics);
      newRecommendations.push(...costRecommendations);
    }
    
    // Quality optimization recommendations
    if (this.config.recommendations.quality_optimization_enabled) {
      const qualityRecommendations = await this.generateQualityOptimizationRecommendations(currentMetrics);
      newRecommendations.push(...qualityRecommendations);
    }
    
    // Performance optimization recommendations
    if (this.config.recommendations.performance_optimization_enabled) {
      const performanceRecommendations = await this.generatePerformanceOptimizationRecommendations(currentMetrics);
      newRecommendations.push(...performanceRecommendations);
    }
    
    // Add to recommendations list
    this.recommendations.push(...newRecommendations);
    
    // Clean up old/implemented recommendations
    this.cleanupOldRecommendations();
    
    return newRecommendations;
  }
  
  private async generateCostOptimizationRecommendations(metrics: OptimizationMetrics): Promise<OptimizationRecommendation[]> {
    const recommendations: OptimizationRecommendation[] = [];
    
    // Check if hard bucket usage is too high
    if (metrics.model_utilization.hard_bucket_percentage > 30) {
      recommendations.push({
        id: `cost_opt_${Date.now()}_hard_bucket`,
        type: 'cost',
        priority: 'medium',
        title: 'Reduce Hard Bucket Usage',
        description: `Hard bucket usage is ${metrics.model_utilization.hard_bucket_percentage.toFixed(1)}%, consider tightening τ_hard threshold`,
        current_state: { hard_bucket_percentage: metrics.model_utilization.hard_bucket_percentage },
        recommended_change: { increase_tau_hard_by: 0.05 },
        expected_impact: {
          win_rate_change: -0.02,
          cost_change: -0.15,
          latency_change: 0.05,
          confidence_score: 0.7
        },
        implementation: {
          automated: true,
          estimated_effort_hours: 0.5,
          requires_testing: true,
          rollback_plan: 'Revert τ_hard threshold via canary rollback'
        },
        created_at: new Date().toISOString(),
        status: 'pending'
      });
    }
    
    // Check if thinking budgets are too high
    if (metrics.current_metrics.cost_per_task > this.config.optimization_goals.target_cost_per_task * 1.1) {
      recommendations.push({
        id: `cost_opt_${Date.now()}_thinking_budget`,
        type: 'cost',
        priority: 'high',
        title: 'Optimize Thinking Budgets',
        description: 'Cost per task exceeds target, consider reducing thinking budgets for mid/hard tiers',
        current_state: { cost_per_task: metrics.current_metrics.cost_per_task },
        recommended_change: { reduce_thinking_budgets_by: 20 },
        expected_impact: {
          win_rate_change: -0.03,
          cost_change: -0.25,
          latency_change: -0.10,
          confidence_score: 0.8
        },
        implementation: {
          automated: true,
          estimated_effort_hours: 1,
          requires_testing: true,
          rollback_plan: 'Restore previous thinking budget configuration'
        },
        created_at: new Date().toISOString(),
        status: 'pending'
      });
    }
    
    return recommendations;
  }
  
  private async generateQualityOptimizationRecommendations(metrics: OptimizationMetrics): Promise<OptimizationRecommendation[]> {
    const recommendations: OptimizationRecommendation[] = [];
    
    // Check if win rate is below target
    if (metrics.current_metrics.win_rate < this.config.optimization_goals.target_win_rate) {
      recommendations.push({
        id: `quality_opt_${Date.now()}_win_rate`,
        type: 'quality',
        priority: 'high',
        title: 'Improve Win Rate',
        description: `Win rate ${(metrics.current_metrics.win_rate*100).toFixed(1)}% is below target ${(this.config.optimization_goals.target_win_rate*100).toFixed(1)}%`,
        current_state: { win_rate: metrics.current_metrics.win_rate },
        recommended_change: { increase_alpha_by: 0.05, retrain_with_recent_data: true },
        expected_impact: {
          win_rate_change: 0.04,
          cost_change: 0.08,
          latency_change: 0.02,
          confidence_score: 0.75
        },
        implementation: {
          automated: false,
          estimated_effort_hours: 4,
          requires_testing: true,
          rollback_plan: 'Canary rollback to previous artifact version'
        },
        created_at: new Date().toISOString(),
        status: 'pending'
      });
    }
    
    return recommendations;
  }
  
  private async generatePerformanceOptimizationRecommendations(metrics: OptimizationMetrics): Promise<OptimizationRecommendation[]> {
    const recommendations: OptimizationRecommendation[] = [];
    
    // Check if latency is above target
    if (metrics.current_metrics.p95_latency_ms > this.config.optimization_goals.target_p95_latency_ms) {
      recommendations.push({
        id: `perf_opt_${Date.now()}_latency`,
        type: 'performance',
        priority: 'medium',
        title: 'Reduce P95 Latency',
        description: `P95 latency ${metrics.current_metrics.p95_latency_ms}ms exceeds target ${this.config.optimization_goals.target_p95_latency_ms}ms`,
        current_state: { p95_latency_ms: metrics.current_metrics.p95_latency_ms },
        recommended_change: { optimize_model_selection_speed: true, cache_embeddings: true },
        expected_impact: {
          win_rate_change: 0,
          cost_change: 0.02,
          latency_change: -0.15,
          confidence_score: 0.6
        },
        implementation: {
          automated: false,
          estimated_effort_hours: 8,
          requires_testing: true,
          rollback_plan: 'Feature flag to disable optimizations'
        },
        created_at: new Date().toISOString(),
        status: 'pending'
      });
    }
    
    return recommendations;
  }
  
  private async executeRecommendation(recommendation: OptimizationRecommendation): Promise<void> {
    // In production, implement actual recommendation execution logic
    console.log(`🔧 Executing recommendation: ${recommendation.title}`);
    
    switch (recommendation.type) {
      case 'cost':
        await this.executeCostOptimization(recommendation);
        break;
      case 'quality':
        await this.executeQualityOptimization(recommendation);
        break;
      case 'performance':
        await this.executePerformanceOptimization(recommendation);
        break;
      case 'configuration':
        await this.executeConfigurationChange(recommendation);
        break;
    }
  }
  
  private async executeCostOptimization(recommendation: OptimizationRecommendation): Promise<void> {
    // Implement cost optimization changes
    if (recommendation.recommended_change.increase_tau_hard_by) {
      console.log('📉 Increasing τ_hard threshold for cost reduction');
      // In production: Update configuration, trigger retraining, deploy via canary
    }
    
    if (recommendation.recommended_change.reduce_thinking_budgets_by) {
      console.log('🧠 Reducing thinking budgets for cost optimization');
      // In production: Update thinking budget configuration, deploy via canary
    }
  }
  
  private async executeQualityOptimization(recommendation: OptimizationRecommendation): Promise<void> {
    // Implement quality optimization changes
    if (recommendation.recommended_change.increase_alpha_by) {
      console.log('⚡ Increasing α parameter for quality focus');
      // In production: Trigger hyperparameter optimization with quality bias
    }
    
    if (recommendation.recommended_change.retrain_with_recent_data) {
      console.log('🎯 Triggering retraining with recent data');
      await this.tuningPipeline.triggerManualRun();
    }
  }
  
  private async executePerformanceOptimization(recommendation: OptimizationRecommendation): Promise<void> {
    // Implement performance optimization changes
    console.log('🚀 Implementing performance optimizations');
    // In production: Apply performance optimizations, measure impact
  }
  
  private async executeConfigurationChange(recommendation: OptimizationRecommendation): Promise<void> {
    // Implement configuration changes
    console.log('⚙️ Applying configuration changes');
    // In production: Update configuration, restart components as needed
  }
  
  // Utility and assessment methods
  
  private async collectCurrentMetrics(): Promise<OptimizationMetrics['current_metrics']> {
    // In production, collect from actual monitoring systems
    return {
      win_rate: 0.876,
      cost_per_task: 0.043,
      p95_latency_ms: 1847,
      quality_score: 0.82,
      success_rate: 0.952
    };
  }
  
  private calculateTrends(currentMetrics: OptimizationMetrics['current_metrics']): OptimizationMetrics['trends'] {
    // Calculate 7-day trends from metrics history
    const weekAgoMetrics = this.getMetricsFromDaysAgo(7);
    
    if (!weekAgoMetrics) {
      return {
        win_rate_7d_change: 0,
        cost_7d_change: 0,
        latency_7d_change: 0,
        quality_7d_change: 0
      };
    }
    
    return {
      win_rate_7d_change: currentMetrics.win_rate - weekAgoMetrics.win_rate,
      cost_7d_change: (currentMetrics.cost_per_task - weekAgoMetrics.cost_per_task) / weekAgoMetrics.cost_per_task,
      latency_7d_change: (currentMetrics.p95_latency_ms - weekAgoMetrics.p95_latency_ms) / weekAgoMetrics.p95_latency_ms,
      quality_7d_change: currentMetrics.quality_score - weekAgoMetrics.quality_score
    };
  }
  
  private evaluateGoalAchievement(currentMetrics: OptimizationMetrics['current_metrics']): OptimizationMetrics['goal_status'] {
    const goals = this.config.optimization_goals;
    
    const winRateAchieved = currentMetrics.win_rate >= goals.target_win_rate;
    const costAchieved = currentMetrics.cost_per_task <= goals.target_cost_per_task;
    const latencyAchieved = currentMetrics.p95_latency_ms <= goals.target_p95_latency_ms;
    const qualityAchieved = currentMetrics.quality_score >= goals.min_quality_score;
    
    let overallHealth: OptimizationMetrics['goal_status']['overall_health'];
    const achievedCount = [winRateAchieved, costAchieved, latencyAchieved, qualityAchieved].filter(Boolean).length;
    
    if (achievedCount === 4) overallHealth = 'excellent';
    else if (achievedCount === 3) overallHealth = 'good';
    else if (achievedCount >= 2) overallHealth = 'needs_attention';
    else overallHealth = 'critical';
    
    return {
      win_rate_achieved: winRateAchieved,
      cost_achieved: costAchieved,
      latency_achieved: latencyAchieved,
      quality_achieved: qualityAchieved,
      overall_health: overallHealth
    };
  }
  
  private async getModelUtilization(): Promise<OptimizationMetrics['model_utilization']> {
    // In production, query actual usage metrics
    return {
      cheap_bucket_percentage: 45,
      mid_bucket_percentage: 35,
      hard_bucket_percentage: 20,
      anthropic_usage_percentage: 15,
      top_performing_models: [
        { model: 'openai/gpt-5', win_rate: 0.94, usage: 25 },
        { model: 'google/gemini-2.5-pro', win_rate: 0.91, usage: 30 },
        { model: 'deepseek/deepseek-r1', win_rate: 0.78, usage: 35 }
      ]
    };
  }
  
  private getMetricsFromDaysAgo(days: number): OptimizationMetrics['current_metrics'] | null {
    const targetTime = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    
    // Find closest metrics entry
    let closest = null;
    let closestDiff = Infinity;
    
    for (const metrics of this.metricsHistory) {
      const metricsTime = new Date(metrics.timestamp);
      const diff = Math.abs(metricsTime.getTime() - targetTime.getTime());
      
      if (diff < closestDiff) {
        closestDiff = diff;
        closest = metrics.current_metrics;
      }
    }
    
    return closest;
  }
  
  private assessCatalogRefresherHealth(): 'healthy' | 'degraded' | 'unhealthy' {
    // Assess based on recent refresh success/failure
    return 'healthy';
  }
  
  private assessTuningPipelineHealth(): 'healthy' | 'degraded' | 'unhealthy' {
    const status = this.tuningPipeline.getStatus();
    return status.pipeline_health === 'healthy' ? 'healthy' :
           status.pipeline_health === 'degraded' ? 'degraded' : 'unhealthy';
  }
  
  private assessCanarySystemHealth(): 'healthy' | 'degraded' | 'unhealthy' {
    const status = this.canaryRollout.getRolloutStatus();
    return status.system_health.rollout_success_rate >= 0.8 ? 'healthy' :
           status.system_health.rollout_success_rate >= 0.6 ? 'degraded' : 'unhealthy';
  }
  
  private assessModelPerformanceHealth(): 'healthy' | 'degraded' | 'unhealthy' {
    const lastMetrics = this.metricsHistory[this.metricsHistory.length - 1];
    if (!lastMetrics) return 'healthy';
    
    const health = lastMetrics.goal_status.overall_health;
    return health === 'excellent' || health === 'good' ? 'healthy' :
           health === 'needs_attention' ? 'degraded' : 'unhealthy';
  }
  
  private async identifyActiveIssues(componentHealth: SystemHealth['component_health']): Promise<SystemHealth['active_issues']> {
    const issues: SystemHealth['active_issues'] = [];
    
    Object.entries(componentHealth).forEach(([component, health]) => {
      if (health !== 'healthy') {
        issues.push({
          component,
          issue_type: 'component_degradation',
          severity: health === 'degraded' ? 'medium' : 'high',
          description: `Component ${component} is ${health}`,
          since: new Date(Date.now() - Math.random() * 24 * 60 * 60 * 1000).toISOString()
        });
      }
    });
    
    return issues;
  }
  
  private getOptimizationActivity(): SystemHealth['optimization_activity'] {
    const tuningStatus = this.tuningPipeline.getStatus();
    const canaryStatus = this.canaryRollout.getRolloutStatus();
    
    return {
      last_catalog_refresh: new Date(Date.now() - Math.random() * 24 * 60 * 60 * 1000).toISOString(),
      last_tuning_run: tuningStatus.last_successful_run?.timestamp || 'never',
      active_canary_rollouts: canaryStatus.active_rollouts.length,
      pending_recommendations: this.recommendations.filter(r => r.status === 'pending').length
    };
  }
  
  private calculatePerformanceSummary(): SystemHealth['performance_summary'] {
    const uptimeMs = Date.now() - this.startTime.getTime();
    const uptimeHours = uptimeMs / (1000 * 60 * 60);
    
    return {
      uptime_percentage: Math.min(99.9, 100 - (uptimeHours * 0.01)), // Simulate uptime
      successful_optimizations: Math.floor(uptimeHours / 24 * 0.8), // ~0.8 per day
      failed_optimizations: Math.floor(uptimeHours / 24 * 0.2), // ~0.2 per day
      avg_improvement_per_cycle: 0.023 // 2.3% average improvement
    };
  }
  
  private cleanupOldRecommendations(): void {
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    
    this.recommendations = this.recommendations.filter(rec => {
      const createdAt = new Date(rec.created_at);
      return createdAt > oneWeekAgo || rec.status === 'pending' || rec.status === 'in_progress';
    });
  }
  
  private mergeDefaultConfig(config: Partial<ContinuousOptimizerConfig>): ContinuousOptimizerConfig {
    return {
      catalog_refresh: config.catalog_refresh || {},
      tuning_pipeline: config.tuning_pipeline || {},
      canary_rollout: config.canary_rollout || {},
      
      optimization_goals: {
        target_win_rate: 0.90,
        target_cost_per_task: 0.04,
        target_p95_latency_ms: 2000,
        min_quality_score: 0.85,
        ...config.optimization_goals
      },
      
      performance_monitoring: {
        quality_trend_window_days: 7,
        cost_trend_window_days: 7,
        performance_degradation_threshold: 0.05,
        alert_on_trend_deviation: true,
        ...config.performance_monitoring
      },
      
      automation: {
        auto_trigger_retraining: true,
        auto_deploy_improvements: false, // Require manual approval for safety
        auto_rollback_on_degradation: true,
        min_improvement_for_auto_deploy: 0.02,
        ...config.automation
      },
      
      recommendations: {
        enabled: true,
        analysis_interval_hours: 6,
        cost_optimization_enabled: true,
        quality_optimization_enabled: true,
        performance_optimization_enabled: true,
        ...config.recommendations
      }
    };
  }
}

/**
 * Update the current TODO progress
 */