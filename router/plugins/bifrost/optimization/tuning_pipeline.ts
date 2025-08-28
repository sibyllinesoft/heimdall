/**
 * Weekly Tuning Pipeline - Milestone 6
 * 
 * Orchestrates the weekly retraining and optimization cycle:
 * - Retrain GBDT model with accumulated logs
 * - Hyperparameter search over α, thresholds τ_cheap, τ_hard
 * - Penalty weight optimization (latency, context)
 * - Export new artifacts with versioning
 */

export interface TuningPipelineConfig {
  schedule: {
    weekly_retrain_day: number; // 0=Sunday, 1=Monday, etc.
    weekly_retrain_hour: number; // UTC hour
    min_samples_for_retrain: number;
  };
  data_sources: {
    posthook_logs_path: string;
    metrics_warehouse_url?: string;
    lookback_days: number;
  };
  optimization: {
    hyperparameter_trials: number;
    threshold_trials: number;
    cross_validation_folds: number;
    performance_improvement_threshold: number; // Minimum improvement to deploy
  };
  artifact_management: {
    versioning_enabled: boolean;
    backup_count: number;
    artifact_store_url: string;
    staging_validation_required: boolean;
  };
  notifications: {
    enabled: boolean;
    webhook_url?: string;
    email_recipients?: string[];
    slack_channel?: string;
  };
}

export interface TuningRun {
  run_id: string;
  timestamp: string;
  trigger: 'scheduled' | 'manual' | 'performance_degradation';
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  
  // Data metrics
  data_quality: {
    total_samples: number;
    samples_by_bucket: { cheap: number; mid: number; hard: number };
    data_quality_score: number;
    coverage_days: number;
  };
  
  // Training results  
  training_results?: {
    gbdt_cv_score: number;
    gbdt_improvement: number;
    optimal_params: {
      alpha: number;
      tau_cheap: number;
      tau_hard: number;
    };
    penalty_weights: {
      latency_sd: number;
      ctx_over_80pct: number;
    };
    model_performance: {
      accuracy: number;
      precision_by_class: [number, number, number];
      recall_by_class: [number, number, number];
      f1_score: number;
    };
  };
  
  // Validation results
  validation_results?: {
    staging_tests_passed: boolean;
    performance_regression_check: {
      passed: boolean;
      current_win_rate: number;
      new_win_rate: number;
      improvement: number;
    };
    cost_efficiency_check: {
      passed: boolean;
      current_cost_per_task: number;
      new_cost_per_task: number;
      improvement: number;
    };
  };
  
  // Deployment info
  deployment?: {
    artifact_version: string;
    deployment_timestamp: string;
    rollout_percentage: number;
    rollback_available: boolean;
  };
  
  duration_ms: number;
  errors?: string[];
  warnings?: string[];
}

export interface PipelineStatus {
  is_running: boolean;
  current_run?: TuningRun;
  last_successful_run?: TuningRun;
  next_scheduled_run: string;
  pipeline_health: 'healthy' | 'degraded' | 'unhealthy';
  recent_runs: TuningRun[];
}

export class TuningPipeline {
  private config: TuningPipelineConfig;
  private schedulerTimer?: NodeJS.Timeout;
  private currentRun?: TuningRun;
  private recentRuns: TuningRun[] = [];
  private isRunning = false;
  
  constructor(config: Partial<TuningPipelineConfig> = {}) {
    this.config = this.mergeDefaultConfig(config);
  }
  
  /**
   * Start the weekly tuning pipeline
   */
  start(): void {
    if (this.isRunning) {
      console.warn('Tuning pipeline already running');
      return;
    }
    
    console.log('🎯 Starting Weekly Tuning Pipeline...');
    
    // Schedule weekly retraining
    this.scheduleWeeklyRuns();
    
    this.isRunning = true;
    console.log('✅ Tuning Pipeline started successfully');
  }
  
  /**
   * Stop the tuning pipeline
   */
  stop(): void {
    if (!this.isRunning) return;
    
    if (this.schedulerTimer) {
      clearTimeout(this.schedulerTimer);
      this.schedulerTimer = undefined;
    }
    
    // If a run is in progress, mark it as cancelled
    if (this.currentRun && this.currentRun.status === 'running') {
      this.currentRun.status = 'cancelled';
      this.currentRun.duration_ms = Date.now() - new Date(this.currentRun.timestamp).getTime();
    }
    
    this.isRunning = false;
    console.log('🛑 Tuning Pipeline stopped');
  }
  
  /**
   * Manually trigger a tuning run
   */
  async triggerManualRun(): Promise<TuningRun> {
    if (this.currentRun && this.currentRun.status === 'running') {
      throw new Error('Tuning run already in progress');
    }
    
    return this.executeTrainingRun('manual');
  }
  
  /**
   * Get current pipeline status
   */
  getStatus(): PipelineStatus {
    return {
      is_running: this.isRunning,
      current_run: this.currentRun,
      last_successful_run: this.getLastSuccessfulRun(),
      next_scheduled_run: this.getNextScheduledRunTime(),
      pipeline_health: this.assessPipelineHealth(),
      recent_runs: this.recentRuns.slice(-10)
    };
  }
  
  /**
   * Execute a complete training run
   */
  private async executeTrainingRun(trigger: 'scheduled' | 'manual' | 'performance_degradation'): Promise<TuningRun> {
    const runId = `tuning_run_${Date.now()}`;
    const startTime = Date.now();
    
    this.currentRun = {
      run_id: runId,
      timestamp: new Date().toISOString(),
      trigger,
      status: 'running',
      data_quality: {
        total_samples: 0,
        samples_by_bucket: { cheap: 0, mid: 0, hard: 0 },
        data_quality_score: 0,
        coverage_days: 0
      },
      duration_ms: 0
    };
    
    console.log(`🚀 Starting tuning run: ${runId} (trigger: ${trigger})`);
    
    try {
      // Step 1: Data Collection and Validation
      console.log('📊 Step 1: Collecting training data...');
      await this.collectTrainingData();
      
      // Step 2: GBDT Model Training
      console.log('🤖 Step 2: Training GBDT model...');
      await this.trainGBDTModel();
      
      // Step 3: Hyperparameter Optimization
      console.log('⚡ Step 3: Optimizing hyperparameters...');
      await this.optimizeHyperparameters();
      
      // Step 4: Validation and Testing
      console.log('🧪 Step 4: Validating new model...');
      await this.validateModel();
      
      // Step 5: Artifact Generation and Deployment
      console.log('📦 Step 5: Generating artifacts...');
      await this.generateAndDeployArtifacts();
      
      this.currentRun.status = 'completed';
      this.currentRun.duration_ms = Date.now() - startTime;
      
      console.log(`✅ Tuning run completed: ${runId} (${this.currentRun.duration_ms}ms)`);
      
      // Send success notification
      if (this.config.notifications.enabled) {
        await this.sendNotification(this.currentRun);
      }
      
    } catch (error) {
      this.currentRun.status = 'failed';
      this.currentRun.duration_ms = Date.now() - startTime;
      this.currentRun.errors = [String(error)];
      
      console.error(`❌ Tuning run failed: ${runId}`, error);
      
      // Send failure notification
      if (this.config.notifications.enabled) {
        await this.sendNotification(this.currentRun);
      }
      
      throw error;
      
    } finally {
      // Archive completed run
      this.recentRuns.push({...this.currentRun});
      this.currentRun = undefined;
      
      // Keep only recent runs
      if (this.recentRuns.length > 50) {
        this.recentRuns = this.recentRuns.slice(-50);
      }
    }
    
    return this.recentRuns[this.recentRuns.length - 1];
  }
  
  private async collectTrainingData(): Promise<void> {
    const lookbackMs = this.config.data_sources.lookback_days * 24 * 60 * 60 * 1000;
    const sinceTimestamp = new Date(Date.now() - lookbackMs).toISOString();
    
    // Collect from PostHook logs
    let totalSamples = 0;
    let samplesByBucket = { cheap: 0, mid: 0, hard: 0 };
    
    if (this.config.data_sources.posthook_logs_path) {
      const logStats = await this.analyzeLogFiles(sinceTimestamp);
      totalSamples += logStats.count;
      
      samplesByBucket.cheap += logStats.buckets.cheap || 0;
      samplesByBucket.mid += logStats.buckets.mid || 0;
      samplesByBucket.hard += logStats.buckets.hard || 0;
    }
    
    // Collect from metrics warehouse if available
    if (this.config.data_sources.metrics_warehouse_url) {
      const warehouseStats = await this.collectFromWarehouse(sinceTimestamp);
      totalSamples += warehouseStats.count;
      
      samplesByBucket.cheap += warehouseStats.buckets.cheap || 0;
      samplesByBucket.mid += warehouseStats.buckets.mid || 0;
      samplesByBucket.hard += warehouseStats.buckets.hard || 0;
    }
    
    // Check minimum sample requirements
    if (totalSamples < this.config.schedule.min_samples_for_retrain) {
      throw new Error(`Insufficient training data: ${totalSamples} samples (minimum: ${this.config.schedule.min_samples_for_retrain})`);
    }
    
    // Calculate data quality score
    const distributionBalance = this.calculateDistributionBalance(samplesByBucket);
    const coverageDays = Math.min(this.config.data_sources.lookback_days, 
                                  Math.floor((Date.now() - this.getOldestLogTimestamp()) / (24 * 60 * 60 * 1000)));
    
    const dataQualityScore = (distributionBalance + (coverageDays / this.config.data_sources.lookback_days)) / 2;
    
    this.currentRun!.data_quality = {
      total_samples: totalSamples,
      samples_by_bucket: samplesByBucket,
      data_quality_score: dataQualityScore,
      coverage_days: coverageDays
    };
    
    console.log(`📊 Data collection complete: ${totalSamples} samples, quality score: ${dataQualityScore.toFixed(3)}`);
  }
  
  private async trainGBDTModel(): Promise<void> {
    // Call Python training script
    const trainingCommand = [
      'python3',
      '/app/router/services/tuning/train_gbdt.py',
      '--log-file', this.config.data_sources.posthook_logs_path,
      '--optimize-hyperparams',
      '--n-trials', String(this.config.optimization.hyperparameter_trials),
      '--cv-folds', String(this.config.optimization.cross_validation_folds)
    ].join(' ');
    
    console.log(`🏃 Executing: ${trainingCommand}`);
    
    try {
      // Execute training - in production, use proper process spawning
      const result = await this.executeTrainingScript(trainingCommand);
      
      // Parse training results
      const trainingResults = this.parseTrainingResults(result);
      
      this.currentRun!.training_results = trainingResults;
      
      console.log(`🎯 GBDT training complete: CV score ${trainingResults.gbdt_cv_score.toFixed(4)}`);
      
    } catch (error) {
      throw new Error(`GBDT training failed: ${error}`);
    }
  }
  
  private async optimizeHyperparameters(): Promise<void> {
    if (!this.currentRun!.training_results) {
      throw new Error('Training results not available for hyperparameter optimization');
    }
    
    // Optimize α, τ_cheap, τ_hard using validation data
    const optimizationResult = await this.runHyperparameterOptimization();
    
    // Update training results with optimal parameters
    this.currentRun!.training_results.optimal_params = optimizationResult.optimal_params;
    this.currentRun!.training_results.penalty_weights = optimizationResult.penalty_weights;
    
    console.log(`⚡ Hyperparameter optimization complete:`);
    console.log(`   α: ${optimizationResult.optimal_params.alpha.toFixed(3)}`);
    console.log(`   τ_cheap: ${optimizationResult.optimal_params.tau_cheap.toFixed(3)}`);
    console.log(`   τ_hard: ${optimizationResult.optimal_params.tau_hard.toFixed(3)}`);
  }
  
  private async validateModel(): Promise<void> {
    if (!this.currentRun!.training_results) {
      throw new Error('Training results not available for validation');
    }
    
    // Run staging tests if enabled
    let stagingTestsPassed = true;
    if (this.config.artifact_management.staging_validation_required) {
      stagingTestsPassed = await this.runStagingTests();
    }
    
    // Performance regression check
    const currentPerformance = await this.getCurrentPerformanceMetrics();
    const projectedPerformance = await this.projectNewPerformanceMetrics();
    
    const performanceCheck = {
      passed: projectedPerformance.win_rate >= currentPerformance.win_rate * (1 + this.config.optimization.performance_improvement_threshold),
      current_win_rate: currentPerformance.win_rate,
      new_win_rate: projectedPerformance.win_rate,
      improvement: projectedPerformance.win_rate - currentPerformance.win_rate
    };
    
    const costCheck = {
      passed: projectedPerformance.cost_per_task <= currentPerformance.cost_per_task,
      current_cost_per_task: currentPerformance.cost_per_task,
      new_cost_per_task: projectedPerformance.cost_per_task,
      improvement: currentPerformance.cost_per_task - projectedPerformance.cost_per_task
    };
    
    this.currentRun!.validation_results = {
      staging_tests_passed: stagingTestsPassed,
      performance_regression_check: performanceCheck,
      cost_efficiency_check: costCheck
    };
    
    // Check if validation passed
    const validationPassed = stagingTestsPassed && performanceCheck.passed && costCheck.passed;
    
    if (!validationPassed) {
      const failures = [];
      if (!stagingTestsPassed) failures.push('staging tests');
      if (!performanceCheck.passed) failures.push('performance regression');
      if (!costCheck.passed) failures.push('cost efficiency');
      
      throw new Error(`Validation failed: ${failures.join(', ')}`);
    }
    
    console.log(`✅ Model validation passed:`);
    console.log(`   Win rate improvement: ${(performanceCheck.improvement * 100).toFixed(2)}%`);
    console.log(`   Cost reduction: ${(costCheck.improvement * 100).toFixed(2)}%`);
  }
  
  private async generateAndDeployArtifacts(): Promise<void> {
    if (!this.currentRun!.training_results || !this.currentRun!.validation_results) {
      throw new Error('Training and validation results required for artifact generation');
    }
    
    // Generate new artifact version
    const artifactVersion = `v${Date.now()}`;
    const artifactPath = await this.generateArtifact(artifactVersion);
    
    // Upload to artifact store
    const uploadResult = await this.uploadArtifact(artifactPath, artifactVersion);
    
    // Update deployment info
    this.currentRun!.deployment = {
      artifact_version: artifactVersion,
      deployment_timestamp: new Date().toISOString(),
      rollout_percentage: 0, // Will be handled by canary system
      rollback_available: true
    };
    
    console.log(`📦 Artifact generated and uploaded: ${artifactVersion}`);
    console.log(`📍 Artifact location: ${uploadResult.url}`);
  }
  
  // Scheduling and utility methods
  
  private scheduleWeeklyRuns(): void {
    const getNextRunTime = () => {
      const now = new Date();
      const nextRun = new Date();
      
      // Set to target day and hour
      const daysUntilTarget = (this.config.schedule.weekly_retrain_day - now.getUTCDay() + 7) % 7;
      nextRun.setUTCDate(now.getUTCDate() + daysUntilTarget);
      nextRun.setUTCHours(this.config.schedule.weekly_retrain_hour, 0, 0, 0);
      
      // If the time has passed today and it's the target day, schedule for next week
      if (daysUntilTarget === 0 && nextRun <= now) {
        nextRun.setUTCDate(nextRun.getUTCDate() + 7);
      }
      
      return nextRun;
    };
    
    const scheduleNext = () => {
      const nextRun = getNextRunTime();
      const msUntilRun = nextRun.getTime() - Date.now();
      
      console.log(`⏰ Next tuning run scheduled for ${nextRun.toISOString()}`);
      
      this.schedulerTimer = setTimeout(() => {
        this.executeTrainingRun('scheduled').catch(error => {
          console.error('❌ Scheduled tuning run failed:', error);
        }).finally(() => {
          scheduleNext(); // Schedule next run
        });
      }, msUntilRun);
    };
    
    scheduleNext();
  }
  
  private getNextScheduledRunTime(): string {
    const now = new Date();
    const nextRun = new Date();
    
    const daysUntilTarget = (this.config.schedule.weekly_retrain_day - now.getUTCDay() + 7) % 7;
    nextRun.setUTCDate(now.getUTCDate() + daysUntilTarget);
    nextRun.setUTCHours(this.config.schedule.weekly_retrain_hour, 0, 0, 0);
    
    if (daysUntilTarget === 0 && nextRun <= now) {
      nextRun.setUTCDate(nextRun.getUTCDate() + 7);
    }
    
    return nextRun.toISOString();
  }
  
  private getLastSuccessfulRun(): TuningRun | undefined {
    return this.recentRuns.slice().reverse().find(run => run.status === 'completed');
  }
  
  private assessPipelineHealth(): 'healthy' | 'degraded' | 'unhealthy' {
    const recent = this.recentRuns.slice(-5);
    if (recent.length === 0) return 'healthy'; // No runs yet
    
    const failures = recent.filter(run => run.status === 'failed').length;
    const successRate = (recent.length - failures) / recent.length;
    
    if (successRate >= 0.8) return 'healthy';
    if (successRate >= 0.5) return 'degraded';
    return 'unhealthy';
  }
  
  // Utility methods - simplified implementations for demo
  
  private async analyzeLogFiles(sinceTimestamp: string): Promise<any> {
    // In production, parse actual log files
    return {
      count: 1500,
      buckets: { cheap: 600, mid: 500, hard: 400 }
    };
  }
  
  private async collectFromWarehouse(sinceTimestamp: string): Promise<any> {
    // In production, query metrics warehouse
    return {
      count: 800,
      buckets: { cheap: 300, mid: 300, hard: 200 }
    };
  }
  
  private calculateDistributionBalance(buckets: any): number {
    const total = buckets.cheap + buckets.mid + buckets.hard;
    if (total === 0) return 0;
    
    const idealRatio = 1/3;
    const cheapRatio = buckets.cheap / total;
    const midRatio = buckets.mid / total;
    const hardRatio = buckets.hard / total;
    
    const deviations = [
      Math.abs(cheapRatio - idealRatio),
      Math.abs(midRatio - idealRatio),
      Math.abs(hardRatio - idealRatio)
    ];
    
    const avgDeviation = deviations.reduce((sum, dev) => sum + dev, 0) / 3;
    return Math.max(0, 1 - avgDeviation * 3); // Scale deviation to [0,1]
  }
  
  private getOldestLogTimestamp(): number {
    // In production, scan log files for oldest entry
    return Date.now() - (this.config.data_sources.lookback_days * 24 * 60 * 60 * 1000);
  }
  
  private async executeTrainingScript(command: string): Promise<any> {
    // In production, use child_process to spawn Python training
    return {
      cv_score: 0.846,
      test_accuracy: 0.823,
      optimal_params: { alpha: 0.62, tau_cheap: 0.65, tau_hard: 0.55 }
    };
  }
  
  private parseTrainingResults(result: any): any {
    return {
      gbdt_cv_score: result.cv_score || 0.85,
      gbdt_improvement: 0.03, // vs previous model
      optimal_params: result.optimal_params || { alpha: 0.6, tau_cheap: 0.62, tau_hard: 0.58 },
      penalty_weights: { latency_sd: 0.05, ctx_over_80pct: 0.15 },
      model_performance: {
        accuracy: result.test_accuracy || 0.82,
        precision_by_class: [0.78, 0.85, 0.88],
        recall_by_class: [0.82, 0.81, 0.85],
        f1_score: 0.83
      }
    };
  }
  
  private async runHyperparameterOptimization(): Promise<any> {
    // In production, run actual hyperparameter search
    return {
      optimal_params: { alpha: 0.61, tau_cheap: 0.64, tau_hard: 0.56 },
      penalty_weights: { latency_sd: 0.04, ctx_over_80pct: 0.16 }
    };
  }
  
  private async runStagingTests(): Promise<boolean> {
    // In production, deploy to staging and run comprehensive tests
    return true;
  }
  
  private async getCurrentPerformanceMetrics(): Promise<any> {
    return { win_rate: 0.85, cost_per_task: 0.045 };
  }
  
  private async projectNewPerformanceMetrics(): Promise<any> {
    return { win_rate: 0.89, cost_per_task: 0.041 };
  }
  
  private async generateArtifact(version: string): Promise<string> {
    // In production, call artifact generation with trained models
    return `/artifacts/avengers_artifact_${version}.tar`;
  }
  
  private async uploadArtifact(path: string, version: string): Promise<any> {
    return { url: `${this.config.artifact_management.artifact_store_url}/artifacts/${version}` };
  }
  
  private async sendNotification(run: TuningRun): Promise<void> {
    const notification = {
      type: 'tuning_run_complete',
      run_id: run.run_id,
      status: run.status,
      timestamp: run.timestamp,
      duration_ms: run.duration_ms,
      trigger: run.trigger,
      summary: {
        samples_processed: run.data_quality.total_samples,
        performance_improvement: run.training_results?.gbdt_improvement,
        validation_passed: run.validation_results?.staging_tests_passed
      }
    };
    
    if (this.config.notifications.webhook_url) {
      try {
        await fetch(this.config.notifications.webhook_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(notification)
        });
      } catch (error) {
        console.warn('Failed to send webhook notification:', error);
      }
    }
  }
  
  private mergeDefaultConfig(config: Partial<TuningPipelineConfig>): TuningPipelineConfig {
    return {
      schedule: {
        weekly_retrain_day: 0, // Sunday
        weekly_retrain_hour: 3, // 3 AM UTC
        min_samples_for_retrain: 1000,
        ...config.schedule
      },
      data_sources: {
        posthook_logs_path: process.env.POSTHOOK_LOGS_PATH || '/var/log/bifrost/posthook.jsonl',
        metrics_warehouse_url: process.env.METRICS_WAREHOUSE_URL,
        lookback_days: 7,
        ...config.data_sources
      },
      optimization: {
        hyperparameter_trials: 100,
        threshold_trials: 50,
        cross_validation_folds: 5,
        performance_improvement_threshold: 0.02, // 2% minimum improvement
        ...config.optimization
      },
      artifact_management: {
        versioning_enabled: true,
        backup_count: 5,
        artifact_store_url: process.env.ARTIFACT_STORE_URL || 'http://localhost:8081',
        staging_validation_required: true,
        ...config.artifact_management
      },
      notifications: {
        enabled: true,
        webhook_url: process.env.TUNING_WEBHOOK_URL,
        email_recipients: process.env.TUNING_EMAIL_RECIPIENTS?.split(','),
        slack_channel: process.env.TUNING_SLACK_CHANNEL,
        ...config.notifications
      }
    };
  }
}