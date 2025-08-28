/**
 * Canary Rollout System - Milestone 6
 * 
 * Implements progressive traffic splitting and A/B testing:
 * - Traffic splitting: 5% → 25% → 50% → 100%
 * - A/B testing framework for new models/artifacts
 * - Automated rollback on performance degradation
 * - Quality gates between rollout phases
 */

export interface CanaryConfig {
  rollout_stages: {
    stage_1_percentage: number; // Initial canary
    stage_2_percentage: number; // First expansion
    stage_3_percentage: number; // Second expansion
    stage_4_percentage: number; // Full rollout
  };
  progression_criteria: {
    min_samples_per_stage: number;
    min_duration_minutes: number;
    max_error_rate: number;
    min_win_rate_vs_baseline: number;
    max_cost_increase_percentage: number;
    max_latency_increase_percentage: number;
  };
  rollback_triggers: {
    error_rate_spike_threshold: number;
    latency_spike_threshold: number;
    cost_spike_threshold: number;
    win_rate_drop_threshold: number;
    consecutive_failures_threshold: number;
  };
  monitoring: {
    evaluation_interval_minutes: number;
    metrics_collection_enabled: boolean;
    alert_webhook_url?: string;
  };
}

export interface CanaryStage {
  stage_number: 1 | 2 | 3 | 4;
  stage_name: 'initial' | 'expand_1' | 'expand_2' | 'full';
  traffic_percentage: number;
  start_time: string;
  end_time?: string;
  status: 'running' | 'completed' | 'failed' | 'rolled_back';
  metrics: {
    total_requests: number;
    success_rate: number;
    error_rate: number;
    avg_latency_ms: number;
    cost_per_request: number;
    win_rate_vs_baseline: number;
  };
  quality_checks: {
    passed: boolean;
    failures: string[];
  };
}

export interface CanaryRollout {
  rollout_id: string;
  artifact_version: string;
  start_time: string;
  end_time?: string;
  status: 'planning' | 'running' | 'completed' | 'failed' | 'rolling_back' | 'rolled_back';
  
  current_stage: number;
  stages: CanaryStage[];
  
  baseline_metrics: {
    success_rate: number;
    avg_latency_ms: number;
    cost_per_request: number;
    win_rate: number;
  };
  
  overall_results?: {
    total_duration_minutes: number;
    total_requests_processed: number;
    success_rate: number;
    performance_improvement: number;
    cost_impact: number;
    rollout_success: boolean;
  };
  
  rollback_info?: {
    reason: string;
    triggered_at: string;
    rollback_completed_at?: string;
    rollback_artifact_version: string;
  };
}

export interface RolloutStatus {
  active_rollouts: CanaryRollout[];
  recent_completions: CanaryRollout[];
  current_traffic_split: {
    baseline_percentage: number;
    canary_percentage: number;
    canary_artifact_version?: string;
  };
  system_health: {
    rollout_success_rate: number;
    avg_rollout_duration_hours: number;
    last_rollback_time?: string;
    rollback_frequency: number;
  };
}

export class CanaryRolloutSystem {
  private config: CanaryConfig;
  private activeRollouts: Map<string, CanaryRollout> = new Map();
  private completedRollouts: CanaryRollout[] = [];
  private evaluationTimer?: NodeJS.Timeout;
  private isRunning = false;
  
  constructor(config: Partial<CanaryConfig> = {}) {
    this.config = this.mergeDefaultConfig(config);
  }
  
  /**
   * Start the canary rollout system
   */
  start(): void {
    if (this.isRunning) {
      console.warn('Canary rollout system already running');
      return;
    }
    
    console.log('🚦 Starting Canary Rollout System...');
    
    // Start continuous evaluation loop
    this.startEvaluationLoop();
    
    this.isRunning = true;
    console.log('✅ Canary Rollout System started');
  }
  
  /**
   * Stop the canary rollout system
   */
  stop(): void {
    if (!this.isRunning) return;
    
    if (this.evaluationTimer) {
      clearInterval(this.evaluationTimer);
      this.evaluationTimer = undefined;
    }
    
    // Emergency rollback any active rollouts
    for (const [rolloutId, rollout] of this.activeRollouts) {
      if (rollout.status === 'running') {
        console.warn(`🚨 Emergency rollback for active rollout: ${rolloutId}`);
        this.initiateRollback(rolloutId, 'system_shutdown').catch(error => {
          console.error(`Failed to rollback ${rolloutId}:`, error);
        });
      }
    }
    
    this.isRunning = false;
    console.log('🛑 Canary Rollout System stopped');
  }
  
  /**
   * Start a new canary rollout for an artifact version
   */
  async startRollout(artifactVersion: string): Promise<string> {
    const rolloutId = `canary_${artifactVersion}_${Date.now()}`;
    
    // Check for existing active rollouts
    const activeRollout = Array.from(this.activeRollouts.values())
      .find(rollout => rollout.status === 'running');
    
    if (activeRollout) {
      throw new Error(`Cannot start new rollout - active rollout in progress: ${activeRollout.rollout_id}`);
    }
    
    console.log(`🚀 Starting canary rollout: ${rolloutId} for artifact ${artifactVersion}`);
    
    // Collect baseline metrics
    const baselineMetrics = await this.collectBaselineMetrics();
    
    // Initialize rollout
    const rollout: CanaryRollout = {
      rollout_id: rolloutId,
      artifact_version: artifactVersion,
      start_time: new Date().toISOString(),
      status: 'planning',
      current_stage: 0,
      stages: [],
      baseline_metrics: baselineMetrics
    };
    
    this.activeRollouts.set(rolloutId, rollout);
    
    // Start with stage 1
    await this.progressToNextStage(rolloutId);
    
    console.log(`✅ Canary rollout started: ${rolloutId}`);
    console.log(`📊 Baseline metrics: success=${(baselineMetrics.success_rate*100).toFixed(1)}%, ` + 
               `latency=${baselineMetrics.avg_latency_ms.toFixed(0)}ms, ` +
               `cost=${baselineMetrics.cost_per_request.toFixed(4)}, ` +
               `win_rate=${(baselineMetrics.win_rate*100).toFixed(1)}%`);
    
    return rolloutId;
  }
  
  /**
   * Force rollback of an active rollout
   */
  async forceRollback(rolloutId: string, reason: string): Promise<void> {
    const rollout = this.activeRollouts.get(rolloutId);
    if (!rollout || rollout.status !== 'running') {
      throw new Error(`Cannot rollback - rollout not active: ${rolloutId}`);
    }
    
    console.log(`🚨 Forcing rollback of rollout: ${rolloutId} (reason: ${reason})`);
    await this.initiateRollback(rolloutId, reason);
  }
  
  /**
   * Get current rollout status
   */
  getRolloutStatus(): RolloutStatus {
    const activeRollouts = Array.from(this.activeRollouts.values());
    const recentCompletions = this.completedRollouts.slice(-10);
    
    // Calculate system health metrics
    const allRollouts = [...activeRollouts, ...this.completedRollouts];
    const successfulRollouts = allRollouts.filter(r => r.status === 'completed').length;
    const rolloutSuccessRate = allRollouts.length > 0 ? successfulRollouts / allRollouts.length : 1.0;
    
    const completedRollouts = allRollouts.filter(r => r.overall_results);
    const avgDuration = completedRollouts.length > 0 ? 
      completedRollouts.reduce((sum, r) => sum + (r.overall_results!.total_duration_minutes), 0) / completedRollouts.length / 60 : 0;
    
    const rollbacks = allRollouts.filter(r => r.status === 'rolled_back');
    const lastRollback = rollbacks.length > 0 ? rollbacks[rollbacks.length - 1].rollback_info?.triggered_at : undefined;
    
    // Current traffic split
    const activeRollout = activeRollouts.find(r => r.status === 'running');
    const currentSplit = {
      baseline_percentage: activeRollout ? (100 - (activeRollout.stages[activeRollout.current_stage - 1]?.traffic_percentage || 0)) : 100,
      canary_percentage: activeRollout ? (activeRollout.stages[activeRollout.current_stage - 1]?.traffic_percentage || 0) : 0,
      canary_artifact_version: activeRollout?.artifact_version
    };
    
    return {
      active_rollouts: activeRollouts,
      recent_completions: recentCompletions,
      current_traffic_split: currentSplit,
      system_health: {
        rollout_success_rate: rolloutSuccessRate,
        avg_rollout_duration_hours: avgDuration,
        last_rollback_time: lastRollback,
        rollback_frequency: rollbacks.length / Math.max(allRollouts.length, 1)
      }
    };
  }
  
  /**
   * Get detailed rollout information
   */
  getRolloutDetails(rolloutId: string): CanaryRollout | undefined {
    return this.activeRollouts.get(rolloutId) || 
           this.completedRollouts.find(r => r.rollout_id === rolloutId);
  }
  
  // Private methods
  
  private startEvaluationLoop(): void {
    const intervalMs = this.config.monitoring.evaluation_interval_minutes * 60 * 1000;
    
    this.evaluationTimer = setInterval(() => {
      this.evaluateActiveRollouts().catch(error => {
        console.error('❌ Rollout evaluation failed:', error);
      });
    }, intervalMs);
    
    console.log(`🔍 Rollout evaluation loop started (${this.config.monitoring.evaluation_interval_minutes}min intervals)`);
  }
  
  private async evaluateActiveRollouts(): Promise<void> {
    for (const [rolloutId, rollout] of this.activeRollouts) {
      if (rollout.status !== 'running') continue;
      
      try {
        console.log(`🔍 Evaluating rollout: ${rolloutId} (stage ${rollout.current_stage})`);
        await this.evaluateRolloutStage(rolloutId);
      } catch (error) {
        console.error(`❌ Failed to evaluate rollout ${rolloutId}:`, error);
        await this.initiateRollback(rolloutId, `evaluation_error: ${error}`);
      }
    }
  }
  
  private async evaluateRolloutStage(rolloutId: string): Promise<void> {
    const rollout = this.activeRollouts.get(rolloutId)!;
    const currentStage = rollout.stages[rollout.current_stage - 1];
    
    if (!currentStage) {
      console.error(`❌ No current stage found for rollout ${rolloutId}`);
      return;
    }
    
    // Collect current metrics for the stage
    const currentMetrics = await this.collectStageMetrics(rolloutId, currentStage);
    currentStage.metrics = currentMetrics;
    
    console.log(`📊 Stage ${currentStage.stage_number} metrics: ` +
               `success=${(currentMetrics.success_rate*100).toFixed(1)}%, ` +
               `latency=${currentMetrics.avg_latency_ms.toFixed(0)}ms, ` +
               `cost=${currentMetrics.cost_per_request.toFixed(4)}, ` +
               `win_rate=${(currentMetrics.win_rate_vs_baseline*100).toFixed(1)}%`);
    
    // Check for rollback triggers
    const rollbackReason = this.checkRollbackTriggers(rollout, currentMetrics);
    if (rollbackReason) {
      console.log(`🚨 Rollback triggered: ${rollbackReason}`);
      await this.initiateRollback(rolloutId, rollbackReason);
      return;
    }
    
    // Check if stage can progress
    const canProgress = await this.checkStageProgressionCriteria(rollout, currentStage);
    if (canProgress) {
      console.log(`✅ Stage ${currentStage.stage_number} passed - progressing to next stage`);
      
      // Mark current stage as completed
      currentStage.status = 'completed';
      currentStage.end_time = new Date().toISOString();
      currentStage.quality_checks = { passed: true, failures: [] };
      
      // Progress to next stage or complete rollout
      if (rollout.current_stage < 4) {
        await this.progressToNextStage(rolloutId);
      } else {
        await this.completeRollout(rolloutId);
      }
    } else {
      console.log(`⏳ Stage ${currentStage.stage_number} still evaluating...`);
    }
  }
  
  private async progressToNextStage(rolloutId: string): Promise<void> {
    const rollout = this.activeRollouts.get(rolloutId)!;
    rollout.current_stage++;
    rollout.status = 'running';
    
    const stageConfig = {
      1: { name: 'initial' as const, percentage: this.config.rollout_stages.stage_1_percentage },
      2: { name: 'expand_1' as const, percentage: this.config.rollout_stages.stage_2_percentage },
      3: { name: 'expand_2' as const, percentage: this.config.rollout_stages.stage_3_percentage },
      4: { name: 'full' as const, percentage: this.config.rollout_stages.stage_4_percentage }
    };
    
    const config = stageConfig[rollout.current_stage as keyof typeof stageConfig];
    
    const stage: CanaryStage = {
      stage_number: rollout.current_stage as 1 | 2 | 3 | 4,
      stage_name: config.name,
      traffic_percentage: config.percentage,
      start_time: new Date().toISOString(),
      status: 'running',
      metrics: {
        total_requests: 0,
        success_rate: 0,
        error_rate: 0,
        avg_latency_ms: 0,
        cost_per_request: 0,
        win_rate_vs_baseline: 0
      },
      quality_checks: { passed: false, failures: [] }
    };
    
    rollout.stages.push(stage);
    
    // Apply traffic split
    await this.applyTrafficSplit(rolloutId, config.percentage);
    
    console.log(`🎯 Progressed to stage ${rollout.current_stage}: ${config.percentage}% traffic`);
    
    // Send notification
    if (this.config.monitoring.alert_webhook_url) {
      await this.sendStageNotification(rolloutId, stage, 'started');
    }
  }
  
  private async completeRollout(rolloutId: string): Promise<void> {
    const rollout = this.activeRollouts.get(rolloutId)!;
    
    rollout.status = 'completed';
    rollout.end_time = new Date().toISOString();
    
    // Calculate overall results
    const startTime = new Date(rollout.start_time).getTime();
    const endTime = new Date().getTime();
    const totalDurationMinutes = (endTime - startTime) / (1000 * 60);
    
    const totalRequests = rollout.stages.reduce((sum, stage) => sum + stage.metrics.total_requests, 0);
    const avgSuccessRate = this.calculateWeightedAverage(rollout.stages, 'success_rate');
    
    // Calculate performance improvement vs baseline
    const finalMetrics = rollout.stages[rollout.stages.length - 1].metrics;
    const performanceImprovement = finalMetrics.win_rate_vs_baseline - rollout.baseline_metrics.win_rate;
    const costImpact = (finalMetrics.cost_per_request - rollout.baseline_metrics.cost_per_request) / rollout.baseline_metrics.cost_per_request;
    
    rollout.overall_results = {
      total_duration_minutes: totalDurationMinutes,
      total_requests_processed: totalRequests,
      success_rate: avgSuccessRate,
      performance_improvement: performanceImprovement,
      cost_impact: costImpact,
      rollout_success: true
    };
    
    console.log(`🎉 Rollout completed successfully: ${rolloutId}`);
    console.log(`📊 Results: ${totalRequests} requests, ${(totalDurationMinutes/60).toFixed(1)}h duration, ` +
               `${(performanceImprovement*100).toFixed(2)}% performance improvement`);
    
    // Move to completed rollouts
    this.activeRollouts.delete(rolloutId);
    this.completedRollouts.push(rollout);
    
    // Keep only recent completions
    if (this.completedRollouts.length > 100) {
      this.completedRollouts = this.completedRollouts.slice(-100);
    }
    
    // Send completion notification
    if (this.config.monitoring.alert_webhook_url) {
      await this.sendCompletionNotification(rollout);
    }
  }
  
  private async initiateRollback(rolloutId: string, reason: string): Promise<void> {
    const rollout = this.activeRollouts.get(rolloutId)!;
    
    rollout.status = 'rolling_back';
    rollout.rollback_info = {
      reason,
      triggered_at: new Date().toISOString(),
      rollback_artifact_version: 'baseline' // In production, get from current deployment
    };
    
    console.log(`🚨 Initiating rollback for ${rolloutId}: ${reason}`);
    
    try {
      // Revert traffic to baseline (0% canary)
      await this.applyTrafficSplit(rolloutId, 0);
      
      // Mark current stage as failed
      if (rollout.current_stage > 0) {
        const currentStage = rollout.stages[rollout.current_stage - 1];
        currentStage.status = 'failed';
        currentStage.end_time = new Date().toISOString();
        currentStage.quality_checks = { 
          passed: false, 
          failures: [`Rollback triggered: ${reason}`] 
        };
      }
      
      rollout.status = 'rolled_back';
      rollout.end_time = new Date().toISOString();
      rollout.rollback_info.rollback_completed_at = new Date().toISOString();
      
      console.log(`✅ Rollback completed for ${rolloutId}`);
      
      // Move to completed rollouts
      this.activeRollouts.delete(rolloutId);
      this.completedRollouts.push(rollout);
      
      // Send rollback notification
      if (this.config.monitoring.alert_webhook_url) {
        await this.sendRollbackNotification(rollout);
      }
      
    } catch (error) {
      rollout.status = 'failed';
      rollout.end_time = new Date().toISOString();
      
      console.error(`❌ Rollback failed for ${rolloutId}:`, error);
      
      // Emergency notification - rollback failed
      if (this.config.monitoring.alert_webhook_url) {
        await this.sendEmergencyNotification(rollout, `Rollback failed: ${error}`);
      }
      
      throw error;
    }
  }
  
  private checkRollbackTriggers(rollout: CanaryRollout, metrics: any): string | null {
    const triggers = this.config.rollback_triggers;
    
    // Error rate spike
    if (metrics.error_rate > triggers.error_rate_spike_threshold) {
      return `Error rate spike: ${(metrics.error_rate*100).toFixed(1)}% > ${(triggers.error_rate_spike_threshold*100).toFixed(1)}%`;
    }
    
    // Latency spike
    const latencyIncrease = (metrics.avg_latency_ms - rollout.baseline_metrics.avg_latency_ms) / rollout.baseline_metrics.avg_latency_ms;
    if (latencyIncrease > triggers.latency_spike_threshold) {
      return `Latency spike: ${(latencyIncrease*100).toFixed(1)}% increase`;
    }
    
    // Cost spike
    const costIncrease = (metrics.cost_per_request - rollout.baseline_metrics.cost_per_request) / rollout.baseline_metrics.cost_per_request;
    if (costIncrease > triggers.cost_spike_threshold) {
      return `Cost spike: ${(costIncrease*100).toFixed(1)}% increase`;
    }
    
    // Win rate drop
    const winRateDrop = rollout.baseline_metrics.win_rate - metrics.win_rate_vs_baseline;
    if (winRateDrop > triggers.win_rate_drop_threshold) {
      return `Win rate drop: ${(winRateDrop*100).toFixed(1)}% decrease`;
    }
    
    return null; // No rollback triggers
  }
  
  private async checkStageProgressionCriteria(rollout: CanaryRollout, stage: CanaryStage): Promise<boolean> {
    const criteria = this.config.progression_criteria;
    
    // Minimum sample size
    if (stage.metrics.total_requests < criteria.min_samples_per_stage) {
      return false;
    }
    
    // Minimum duration
    const stageDuration = (Date.now() - new Date(stage.start_time).getTime()) / (1000 * 60);
    if (stageDuration < criteria.min_duration_minutes) {
      return false;
    }
    
    // Error rate check
    if (stage.metrics.error_rate > criteria.max_error_rate) {
      return false;
    }
    
    // Win rate check
    if (stage.metrics.win_rate_vs_baseline < criteria.min_win_rate_vs_baseline) {
      return false;
    }
    
    // Cost increase check
    const costIncrease = (stage.metrics.cost_per_request - rollout.baseline_metrics.cost_per_request) / rollout.baseline_metrics.cost_per_request;
    if (costIncrease > criteria.max_cost_increase_percentage) {
      return false;
    }
    
    // Latency increase check
    const latencyIncrease = (stage.metrics.avg_latency_ms - rollout.baseline_metrics.avg_latency_ms) / rollout.baseline_metrics.avg_latency_ms;
    if (latencyIncrease > criteria.max_latency_increase_percentage) {
      return false;
    }
    
    return true; // All criteria passed
  }
  
  // Utility methods (simplified for demo)
  
  private async collectBaselineMetrics(): Promise<any> {
    // In production, collect actual baseline metrics from current system
    return {
      success_rate: 0.952,
      avg_latency_ms: 1847,
      cost_per_request: 0.043,
      win_rate: 0.876
    };
  }
  
  private async collectStageMetrics(rolloutId: string, stage: CanaryStage): Promise<any> {
    // In production, collect actual metrics from monitoring systems
    const variance = (Math.random() - 0.5) * 0.1; // ±5% variance
    return {
      total_requests: Math.floor(1000 + Math.random() * 500),
      success_rate: Math.max(0.90, 0.955 + variance),
      error_rate: Math.max(0, 0.045 - variance),
      avg_latency_ms: Math.max(1000, 1820 + variance * 200),
      cost_per_request: Math.max(0.02, 0.041 + variance * 0.01),
      win_rate_vs_baseline: Math.max(0.8, 0.89 + variance * 0.05)
    };
  }
  
  private async applyTrafficSplit(rolloutId: string, percentage: number): Promise<void> {
    // In production, update load balancer or traffic splitting configuration
    console.log(`🚦 Applying traffic split: ${percentage}% to canary (rollout: ${rolloutId})`);
    
    // Simulate API call to traffic controller
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  private calculateWeightedAverage(stages: CanaryStage[], metric: keyof CanaryStage['metrics']): number {
    const totalRequests = stages.reduce((sum, stage) => sum + stage.metrics.total_requests, 0);
    if (totalRequests === 0) return 0;
    
    const weightedSum = stages.reduce((sum, stage) => {
      return sum + (stage.metrics[metric] as number) * stage.metrics.total_requests;
    }, 0);
    
    return weightedSum / totalRequests;
  }
  
  // Notification methods
  
  private async sendStageNotification(rolloutId: string, stage: CanaryStage, event: string): Promise<void> {
    if (!this.config.monitoring.alert_webhook_url) return;
    
    const notification = {
      type: 'canary_stage_event',
      event,
      rollout_id: rolloutId,
      stage_number: stage.stage_number,
      stage_name: stage.stage_name,
      traffic_percentage: stage.traffic_percentage,
      timestamp: new Date().toISOString()
    };
    
    try {
      await fetch(this.config.monitoring.alert_webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(notification)
      });
    } catch (error) {
      console.warn('Failed to send stage notification:', error);
    }
  }
  
  private async sendCompletionNotification(rollout: CanaryRollout): Promise<void> {
    if (!this.config.monitoring.alert_webhook_url) return;
    
    const notification = {
      type: 'canary_rollout_completed',
      rollout_id: rollout.rollout_id,
      artifact_version: rollout.artifact_version,
      duration_hours: rollout.overall_results!.total_duration_minutes / 60,
      requests_processed: rollout.overall_results!.total_requests_processed,
      performance_improvement: rollout.overall_results!.performance_improvement,
      cost_impact: rollout.overall_results!.cost_impact,
      timestamp: new Date().toISOString()
    };
    
    try {
      await fetch(this.config.monitoring.alert_webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(notification)
      });
    } catch (error) {
      console.warn('Failed to send completion notification:', error);
    }
  }
  
  private async sendRollbackNotification(rollout: CanaryRollout): Promise<void> {
    if (!this.config.monitoring.alert_webhook_url) return;
    
    const notification = {
      type: 'canary_rollout_rolled_back',
      rollout_id: rollout.rollout_id,
      artifact_version: rollout.artifact_version,
      rollback_reason: rollout.rollback_info!.reason,
      stage_reached: rollout.current_stage,
      timestamp: new Date().toISOString()
    };
    
    try {
      await fetch(this.config.monitoring.alert_webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(notification)
      });
    } catch (error) {
      console.warn('Failed to send rollback notification:', error);
    }
  }
  
  private async sendEmergencyNotification(rollout: CanaryRollout, message: string): Promise<void> {
    if (!this.config.monitoring.alert_webhook_url) return;
    
    const notification = {
      type: 'canary_emergency',
      rollout_id: rollout.rollout_id,
      message,
      timestamp: new Date().toISOString(),
      requires_immediate_attention: true
    };
    
    try {
      await fetch(this.config.monitoring.alert_webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(notification)
      });
    } catch (error) {
      console.error('Failed to send emergency notification:', error);
    }
  }
  
  private mergeDefaultConfig(config: Partial<CanaryConfig>): CanaryConfig {
    return {
      rollout_stages: {
        stage_1_percentage: 5,    // 5% initial canary
        stage_2_percentage: 25,   // 25% first expansion
        stage_3_percentage: 50,   // 50% second expansion
        stage_4_percentage: 100,  // 100% full rollout
        ...config.rollout_stages
      },
      progression_criteria: {
        min_samples_per_stage: 100,
        min_duration_minutes: 15,
        max_error_rate: 0.05,
        min_win_rate_vs_baseline: 0.85,
        max_cost_increase_percentage: 0.20,
        max_latency_increase_percentage: 0.15,
        ...config.progression_criteria
      },
      rollback_triggers: {
        error_rate_spike_threshold: 0.10,
        latency_spike_threshold: 0.50,
        cost_spike_threshold: 0.30,
        win_rate_drop_threshold: 0.10,
        consecutive_failures_threshold: 3,
        ...config.rollback_triggers
      },
      monitoring: {
        evaluation_interval_minutes: 5,
        metrics_collection_enabled: true,
        alert_webhook_url: process.env.CANARY_ALERT_WEBHOOK_URL,
        ...config.monitoring
      }
    };
  }
}