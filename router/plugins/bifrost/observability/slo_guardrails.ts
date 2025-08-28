/**
 * SLO Guardrails System for Bifrost Router
 * Implements deployment gates and quality enforcement for Milestone 5
 */

import { MetricsCollector, DashboardMetrics } from './metrics_collector.js';

export interface DeploymentGate {
  name: string;
  description: string;
  check: (metrics: DashboardMetrics) => Promise<GateResult>;
  blocking: boolean;
  timeout_ms: number;
}

export interface GateResult {
  passed: boolean;
  message: string;
  details?: Record<string, any>;
  recommendation?: string;
}

export interface SLOValidationResult {
  deployment_allowed: boolean;
  gates_passed: number;
  gates_total: number;
  blocking_failures: GateResult[];
  warnings: GateResult[];
  validation_time_ms: number;
  next_validation_allowed_at?: string;
}

export interface CanaryConfig {
  enabled: boolean;
  initial_traffic_percent: number;
  increment_percent: number;
  increment_interval_minutes: number;
  success_threshold: number;
  rollback_threshold: number;
  max_duration_minutes: number;
}

/**
 * Comprehensive SLO Guardrails for safe deployments
 */
export class SLOGuardrails {
  private gates: DeploymentGate[];
  private metricsCollector: MetricsCollector;
  private lastValidation?: Date;
  private validationCooldownMs = 5 * 60 * 1000; // 5 minutes between validations
  
  constructor(
    metricsCollector: MetricsCollector,
    private canaryConfig: CanaryConfig = {
      enabled: true,
      initial_traffic_percent: 5,
      increment_percent: 25,
      increment_interval_minutes: 15,
      success_threshold: 0.99,
      rollback_threshold: 0.95,
      max_duration_minutes: 120
    }
  ) {
    this.metricsCollector = metricsCollector;
    this.initializeDeploymentGates();
  }
  
  /**
   * Run full SLO validation for deployment readiness
   */
  async validateDeployment(): Promise<SLOValidationResult> {
    const startTime = Date.now();
    
    // Check cooldown period
    if (this.lastValidation && (startTime - this.lastValidation.getTime()) < this.validationCooldownMs) {
      const nextAllowed = new Date(this.lastValidation.getTime() + this.validationCooldownMs);
      return {
        deployment_allowed: false,
        gates_passed: 0,
        gates_total: this.gates.length,
        blocking_failures: [{
          passed: false,
          message: 'Validation cooldown period active',
          details: { cooldown_ms: this.validationCooldownMs }
        }],
        warnings: [],
        validation_time_ms: Date.now() - startTime,
        next_validation_allowed_at: nextAllowed.toISOString()
      };
    }
    
    const metrics = this.metricsCollector.getDashboardMetrics();
    const results: Array<{ gate: DeploymentGate; result: GateResult }> = [];
    
    // Run all gates
    for (const gate of this.gates) {
      try {
        const gateResult = await Promise.race([
          gate.check(metrics),
          this.createTimeoutResult(gate)
        ]);
        results.push({ gate, result: gateResult });
      } catch (error) {
        results.push({
          gate,
          result: {
            passed: false,
            message: `Gate execution failed: ${error}`,
            details: { error: String(error) }
          }
        });
      }
    }
    
    const blockingFailures = results
      .filter(r => r.gate.blocking && !r.result.passed)
      .map(r => ({ ...r.result, gate_name: r.gate.name }));
    
    const warnings = results
      .filter(r => !r.gate.blocking && !r.result.passed)
      .map(r => ({ ...r.result, gate_name: r.gate.name }));
    
    const passed = results.filter(r => r.result.passed).length;
    const deploymentAllowed = blockingFailures.length === 0;
    
    this.lastValidation = new Date();
    
    const result: SLOValidationResult = {
      deployment_allowed: deploymentAllowed,
      gates_passed: passed,
      gates_total: this.gates.length,
      blocking_failures: blockingFailures,
      warnings,
      validation_time_ms: Date.now() - startTime
    };
    
    // Log validation result
    this.logValidationResult(result);
    
    return result;
  }
  
  /**
   * Continuous monitoring during canary deployment
   */
  async monitorCanaryDeployment(): Promise<{
    continue_canary: boolean;
    rollback_required: boolean;
    current_traffic_percent: number;
    next_increment_at?: string;
    metrics_snapshot: DashboardMetrics;
  }> {
    const metrics = this.metricsCollector.getDashboardMetrics();
    
    // Simplified canary logic - in production this would integrate with deployment system
    const sloCompliance = this.metricsCollector.checkSLOCompliance();
    
    const continue_canary = sloCompliance.compliant;
    const rollback_required = metrics.slo_status.uptime_percentage < (this.canaryConfig.rollback_threshold * 100);
    
    return {
      continue_canary,
      rollback_required,
      current_traffic_percent: this.canaryConfig.initial_traffic_percent, // Simplified
      next_increment_at: rollback_required ? undefined : 
        new Date(Date.now() + this.canaryConfig.increment_interval_minutes * 60 * 1000).toISOString(),
      metrics_snapshot: metrics
    };
  }
  
  /**
   * Emergency deployment rollback detection
   */
  checkEmergencyRollback(): {
    rollback_required: boolean;
    severity: 'low' | 'medium' | 'high' | 'critical';
    reason: string;
    immediate_action_required: boolean;
  } {
    const metrics = this.metricsCollector.getDashboardMetrics();
    
    // Critical thresholds for emergency rollback
    if (metrics.slo_status.uptime_percentage < 90) {
      return {
        rollback_required: true,
        severity: 'critical',
        reason: `Uptime critically low: ${metrics.slo_status.uptime_percentage.toFixed(1)}%`,
        immediate_action_required: true
      };
    }
    
    if (metrics.latency_metrics.p95 > 10000) {
      return {
        rollback_required: true,
        severity: 'critical',
        reason: `P95 latency critically high: ${metrics.latency_metrics.p95.toFixed(0)}ms`,
        immediate_action_required: true
      };
    }
    
    if (metrics.slo_status.failover_misfire_rate > 0.5) {
      return {
        rollback_required: true,
        severity: 'high',
        reason: `Failover misfire rate critically high: ${(metrics.slo_status.failover_misfire_rate * 100).toFixed(1)}%`,
        immediate_action_required: true
      };
    }
    
    if (metrics.anthropic_429_rate.rate > 0.5) {
      return {
        rollback_required: true,
        severity: 'medium',
        reason: `Anthropic 429 rate extremely high: ${(metrics.anthropic_429_rate.rate * 100).toFixed(1)}%`,
        immediate_action_required: false
      };
    }
    
    return {
      rollback_required: false,
      severity: 'low',
      reason: 'All metrics within acceptable ranges',
      immediate_action_required: false
    };
  }
  
  /**
   * Generate deployment report with recommendations
   */
  generateDeploymentReport(): {
    timestamp: string;
    deployment_recommendation: 'proceed' | 'caution' | 'block';
    confidence_score: number;
    risk_factors: Array<{ factor: string; severity: 'low' | 'medium' | 'high'; impact: string }>;
    optimization_opportunities: string[];
    next_assessment_recommended: string;
  } {
    const metrics = this.metricsCollector.getDashboardMetrics();
    const sloCompliance = this.metricsCollector.checkSLOCompliance();
    
    let recommendation: 'proceed' | 'caution' | 'block' = 'proceed';
    let confidenceScore = 0.9;
    const riskFactors: Array<{ factor: string; severity: 'low' | 'medium' | 'high'; impact: string }> = [];
    const optimizations: string[] = [];
    
    // Analyze risk factors
    if (!sloCompliance.compliant) {
      recommendation = 'block';
      confidenceScore = 0.3;
      riskFactors.push({
        factor: 'SLO Violations',
        severity: 'high',
        impact: 'Multiple SLO thresholds exceeded'
      });
    }
    
    if (metrics.latency_metrics.p95 > 2000) {
      if (recommendation === 'proceed') recommendation = 'caution';
      confidenceScore = Math.min(confidenceScore, 0.7);
      riskFactors.push({
        factor: 'High Latency',
        severity: metrics.latency_metrics.p95 > 3000 ? 'high' : 'medium',
        impact: `P95 latency at ${metrics.latency_metrics.p95.toFixed(0)}ms`
      });
    }
    
    if (metrics.anthropic_429_rate.rate > 0.1) {
      if (recommendation === 'proceed') recommendation = 'caution';
      riskFactors.push({
        factor: 'Anthropic Rate Limiting',
        severity: 'medium',
        impact: `${(metrics.anthropic_429_rate.rate * 100).toFixed(1)}% of Anthropic requests rate limited`
      });
    }
    
    // Identify optimizations
    if (metrics.cost_per_task.mean > 0.05) {
      optimizations.push('Cost optimization: Review bucket distribution and thinking budgets');
    }
    
    if (metrics.win_rate_vs_baseline.overall < 0.9) {
      optimizations.push('Quality optimization: Tune alpha-score parameters');
    }
    
    Object.entries(metrics.provider_health).forEach(([provider, health]) => {
      if (health.availability < 0.99) {
        optimizations.push(`Provider ${provider}: Investigate availability issues (${(health.availability * 100).toFixed(1)}%)`);
      }
    });
    
    return {
      timestamp: new Date().toISOString(),
      deployment_recommendation: recommendation,
      confidence_score: confidenceScore,
      risk_factors: riskFactors,
      optimization_opportunities: optimizations,
      next_assessment_recommended: new Date(Date.now() + 30 * 60 * 1000).toISOString() // 30 minutes
    };
  }
  
  private initializeDeploymentGates(): void {
    this.gates = [
      {
        name: 'P95 Latency Threshold',
        description: 'Ensure P95 latency is within acceptable bounds',
        blocking: true,
        timeout_ms: 10000,
        check: async (metrics) => {
          const threshold = 2500; // 2.5 seconds
          const passed = metrics.latency_metrics.p95 <= threshold;
          return {
            passed,
            message: passed 
              ? `P95 latency ${metrics.latency_metrics.p95.toFixed(0)}ms within threshold` 
              : `P95 latency ${metrics.latency_metrics.p95.toFixed(0)}ms exceeds ${threshold}ms threshold`,
            details: {
              actual_p95: metrics.latency_metrics.p95,
              threshold,
              margin: threshold - metrics.latency_metrics.p95
            },
            recommendation: passed ? undefined : 'Investigate high-latency providers and optimize thinking budgets'
          };
        }
      },
      
      {
        name: 'Provider Availability',
        description: 'Ensure all providers are healthy and available',
        blocking: true,
        timeout_ms: 15000,
        check: async (metrics) => {
          const minAvailability = 0.95;
          const unhealthyProviders = Object.entries(metrics.provider_health)
            .filter(([_, health]) => health.availability < minAvailability);
          
          const passed = unhealthyProviders.length === 0;
          return {
            passed,
            message: passed 
              ? 'All providers are healthy' 
              : `${unhealthyProviders.length} provider(s) below availability threshold`,
            details: {
              unhealthy_providers: unhealthyProviders.map(([name, health]) => ({
                provider: name,
                availability: health.availability,
                threshold: minAvailability
              })),
              total_providers: Object.keys(metrics.provider_health).length
            },
            recommendation: passed ? undefined : 'Check provider health and authentication credentials'
          };
        }
      },
      
      {
        name: 'Failover Effectiveness',
        description: 'Ensure failover mechanisms are working correctly',
        blocking: true,
        timeout_ms: 5000,
        check: async (metrics) => {
          const maxMisfireRate = 0.05; // 5%
          const passed = metrics.slo_status.failover_misfire_rate <= maxMisfireRate;
          return {
            passed,
            message: passed 
              ? `Failover misfire rate ${(metrics.slo_status.failover_misfire_rate * 100).toFixed(2)}% within threshold` 
              : `Failover misfire rate ${(metrics.slo_status.failover_misfire_rate * 100).toFixed(2)}% exceeds ${maxMisfireRate * 100}% threshold`,
            details: {
              actual_misfire_rate: metrics.slo_status.failover_misfire_rate,
              threshold: maxMisfireRate,
              anthropic_429_rate: metrics.anthropic_429_rate.rate
            },
            recommendation: passed ? undefined : 'Review fallback selection logic and provider health'
          };
        }
      },
      
      {
        name: 'Cost Efficiency',
        description: 'Ensure cost per task is within budget constraints',
        blocking: false, // Warning only
        timeout_ms: 5000,
        check: async (metrics) => {
          const maxCostPerTask = 0.10; // $0.10
          const passed = metrics.cost_per_task.mean <= maxCostPerTask;
          return {
            passed,
            message: passed 
              ? `Cost per task $${metrics.cost_per_task.mean.toFixed(4)} within budget` 
              : `Cost per task $${metrics.cost_per_task.mean.toFixed(4)} exceeds budget of $${maxCostPerTask.toFixed(2)}`,
            details: {
              actual_cost: metrics.cost_per_task.mean,
              threshold: maxCostPerTask,
              cost_by_bucket: metrics.cost_per_task.by_bucket
            },
            recommendation: passed ? undefined : 'Review bucket distribution and thinking budget allocation'
          };
        }
      },
      
      {
        name: 'Win Rate vs Baseline',
        description: 'Ensure quality remains above baseline performance',
        blocking: false, // Warning only
        timeout_ms: 5000,
        check: async (metrics) => {
          const minWinRate = 0.85; // 85%
          const passed = metrics.win_rate_vs_baseline.overall >= minWinRate;
          return {
            passed,
            message: passed 
              ? `Win rate ${(metrics.win_rate_vs_baseline.overall * 100).toFixed(1)}% above baseline` 
              : `Win rate ${(metrics.win_rate_vs_baseline.overall * 100).toFixed(1)}% below ${minWinRate * 100}% threshold`,
            details: {
              actual_win_rate: metrics.win_rate_vs_baseline.overall,
              threshold: minWinRate,
              win_rate_by_bucket: metrics.win_rate_vs_baseline.by_bucket
            },
            recommendation: passed ? undefined : 'Tune alpha-score parameters and bucket thresholds'
          };
        }
      },
      
      {
        name: 'Anthropic Rate Limit Health',
        description: 'Check Anthropic 429 rate and fallback effectiveness',
        blocking: false, // Warning only
        timeout_ms: 5000,
        check: async (metrics) => {
          const max429Rate = 0.1; // 10%
          const passed = metrics.anthropic_429_rate.rate <= max429Rate;
          return {
            passed,
            message: passed 
              ? `Anthropic 429 rate ${(metrics.anthropic_429_rate.rate * 100).toFixed(1)}% within acceptable range` 
              : `Anthropic 429 rate ${(metrics.anthropic_429_rate.rate * 100).toFixed(1)}% indicates rate limiting issues`,
            details: {
              actual_429_rate: metrics.anthropic_429_rate.rate,
              threshold: max429Rate,
              escalations_last_hour: metrics.anthropic_429_rate.escalations_last_hour,
              cooldown_users: metrics.anthropic_429_rate.cooldown_users
            },
            recommendation: passed ? undefined : 'Review Anthropic usage patterns and cooldown strategies'
          };
        }
      }
    ];
  }
  
  private async createTimeoutResult(gate: DeploymentGate): Promise<GateResult> {
    await new Promise(resolve => setTimeout(resolve, gate.timeout_ms));
    return {
      passed: false,
      message: `Gate '${gate.name}' timed out after ${gate.timeout_ms}ms`,
      details: { timeout: true, timeout_ms: gate.timeout_ms }
    };
  }
  
  private logValidationResult(result: SLOValidationResult): void {
    const status = result.deployment_allowed ? 'PASS' : 'FAIL';
    const emoji = result.deployment_allowed ? '✅' : '❌';
    
    console.log(
      `${emoji} SLO Validation ${status}: ${result.gates_passed}/${result.gates_total} gates passed ` +
      `(${result.validation_time_ms}ms)`
    );
    
    if (result.blocking_failures.length > 0) {
      console.log('🚫 Blocking failures:');
      result.blocking_failures.forEach(failure => {
        console.log(`  - ${failure.message}`);
      });
    }
    
    if (result.warnings.length > 0) {
      console.log('⚠️  Warnings:');
      result.warnings.forEach(warning => {
        console.log(`  - ${warning.message}`);
      });
    }
  }
  
  /**
   * Add custom deployment gate
   */
  addCustomGate(gate: DeploymentGate): void {
    this.gates.push(gate);
  }
  
  /**
   * Remove deployment gate by name
   */
  removeGate(name: string): boolean {
    const initialLength = this.gates.length;
    this.gates = this.gates.filter(gate => gate.name !== name);
    return this.gates.length < initialLength;
  }
  
  /**
   * Update canary configuration
   */
  updateCanaryConfig(config: Partial<CanaryConfig>): void {
    this.canaryConfig = { ...this.canaryConfig, ...config };
  }
  
  /**
   * Get current gate configuration
   */
  getGates(): DeploymentGate[] {
    return [...this.gates];
  }
}