#!/usr/bin/env node
/**
 * Bifrost Router Observability CLI
 * Command-line interface for SLO monitoring, deployment validation, and operational management
 */

import { ObservabilityManager } from '../router/plugins/bifrost/observability/observability_manager.js';

interface CLIOptions {
  command: string;
  args: string[];
  flags: Record<string, string | boolean>;
}

/**
 * Observability CLI for operational management
 */
class ObservabilityCLI {
  private observabilityManager: ObservabilityManager;
  
  constructor() {
    this.observabilityManager = new ObservabilityManager();
  }
  
  async run(argv: string[]): Promise<void> {
    const options = this.parseArgs(argv);
    
    try {
      switch (options.command) {
        case 'status':
          await this.handleStatus(options);
          break;
          
        case 'dashboard':
          await this.handleDashboard(options);
          break;
          
        case 'validate':
          await this.handleValidate(options);
          break;
          
        case 'deploy-check':
          await this.handleDeployCheck(options);
          break;
          
        case 'report':
          await this.handleReport(options);
          break;
          
        case 'metrics':
          await this.handleMetrics(options);
          break;
          
        case 'slo':
          await this.handleSLO(options);
          break;
          
        case 'emergency':
          await this.handleEmergency(options);
          break;
          
        case 'help':
        default:
          this.showHelp();
          break;
      }
    } catch (error) {
      console.error('❌ Command failed:', error);
      process.exit(1);
    }
  }
  
  private async handleStatus(options: CLIOptions): Promise<void> {
    console.log('🔍 Checking Bifrost Router operational status...');
    
    await this.observabilityManager.initialize();
    const status = await this.observabilityManager.getOperationalStatus();
    
    console.log('\n📊 OPERATIONAL STATUS');
    console.log('=' * 50);
    
    // Overall status
    const statusEmoji = {
      'GREEN': '🟢',
      'YELLOW': '🟡', 
      'RED': '🔴'
    }[status.current_slo_status] || '⚪';
    
    console.log(`Overall SLO Status: ${statusEmoji} ${status.current_slo_status}`);
    console.log(`Deployment Readiness: ${status.deployment_readiness}`);
    console.log(`Uptime: ${Math.floor(status.uptime_seconds / 3600)}h ${Math.floor((status.uptime_seconds % 3600) / 60)}m`);
    console.log(`Requests Processed: ${status.total_requests_processed.toLocaleString()}`);
    
    console.log('\n🔧 COMPONENT HEALTH');
    console.log('-' * 30);
    Object.entries(status.components).forEach(([component, health]) => {
      const emoji = this.getHealthEmoji(health as string);
      console.log(`${emoji} ${component.replace(/_/g, ' ')}: ${health}`);
    });
    
    if (options.flags.detailed) {
      const dashboardMetrics = this.observabilityManager.getEnhancedPostHook().getDashboardMetrics();
      
      console.log('\n📈 KEY METRICS');
      console.log('-' * 30);
      console.log(`P95 Latency: ${dashboardMetrics.latency_metrics.p95.toFixed(0)}ms`);
      console.log(`Cost per Task: $${dashboardMetrics.cost_per_task.mean.toFixed(4)}`);
      console.log(`Win Rate: ${(dashboardMetrics.win_rate_vs_baseline.overall * 100).toFixed(1)}%`);
      console.log(`Anthropic 429 Rate: ${(dashboardMetrics.anthropic_429_rate.rate * 100).toFixed(2)}%`);
      
      console.log('\n🏗️ ROUTE DISTRIBUTION');
      console.log('-' * 30);
      Object.entries(dashboardMetrics.route_share_by_bucket).forEach(([bucket, share]) => {
        console.log(`${bucket}: ${(share * 100).toFixed(1)}%`);
      });
    }
    
    await this.observabilityManager.shutdown();
  }
  
  private async handleDashboard(options: CLIOptions): Promise<void> {
    console.log('🖥️  Starting Bifrost Router Dashboard...');
    
    await this.observabilityManager.initialize();
    
    const port = options.flags.port as string || '8090';
    console.log(`\n✅ Dashboard running at: http://localhost:${port}/dashboard`);
    console.log('   📊 Metrics API: http://localhost:' + port + '/metrics');
    console.log('   🔍 SLO Status: http://localhost:' + port + '/slo-status');
    console.log('   🚀 Deploy Check: http://localhost:' + port + '/deployment-readiness');
    console.log('\nPress Ctrl+C to stop the dashboard');
    
    // Keep process alive
    process.on('SIGINT', async () => {
      console.log('\n🛑 Stopping dashboard...');
      await this.observabilityManager.shutdown();
      process.exit(0);
    });
    
    // Keep the process running
    await new Promise(() => {});
  }
  
  private async handleValidate(options: CLIOptions): Promise<void> {
    console.log('🔬 Running SLO validation...');
    
    await this.observabilityManager.initialize();
    const validationResult = await this.observabilityManager.runDeploymentValidation();
    
    console.log('\n🎯 DEPLOYMENT VALIDATION RESULTS');
    console.log('=' * 50);
    
    const result = validationResult.validation_result;
    const status = result.deployment_allowed ? '✅ ALLOWED' : '❌ BLOCKED';
    console.log(`Deployment Status: ${status}`);
    console.log(`Gates Passed: ${result.gates_passed}/${result.gates_total}`);
    console.log(`Validation Time: ${result.validation_time_ms}ms`);
    
    if (result.blocking_failures.length > 0) {
      console.log('\n🚫 BLOCKING FAILURES:');
      result.blocking_failures.forEach((failure: any, index: number) => {
        console.log(`${index + 1}. ${failure.message}`);
        if (failure.recommendation) {
          console.log(`   💡 Recommendation: ${failure.recommendation}`);
        }
      });
    }
    
    if (result.warnings.length > 0) {
      console.log('\n⚠️  WARNINGS:');
      result.warnings.forEach((warning: any, index: number) => {
        console.log(`${index + 1}. ${warning.message}`);
      });
    }
    
    if (validationResult.recommendations.length > 0) {
      console.log('\n💡 RECOMMENDATIONS:');
      validationResult.recommendations.forEach(rec => {
        console.log(`   ${rec}`);
      });
    }
    
    await this.observabilityManager.shutdown();
    process.exit(result.deployment_allowed ? 0 : 1);
  }
  
  private async handleDeployCheck(options: CLIOptions): Promise<void> {
    console.log('🚀 Checking deployment readiness...');
    
    await this.observabilityManager.initialize();
    const metricsCollector = this.observabilityManager.getEnhancedPostHook().getMetricsCollector();
    const readiness = metricsCollector.getDeploymentReadiness();
    
    console.log('\n🚀 DEPLOYMENT READINESS ASSESSMENT');
    console.log('=' * 50);
    
    const status = readiness.ready ? '🟢 READY' : '🔴 NOT READY';
    console.log(`Status: ${status}`);
    
    if (!readiness.ready) {
      console.log('\n🚫 BLOCKERS:');
      readiness.blockers.forEach((blocker, index) => {
        console.log(`${index + 1}. ${blocker}`);
      });
    }
    
    if (readiness.warnings.length > 0) {
      console.log('\n⚠️  WARNINGS:');
      readiness.warnings.forEach((warning, index) => {
        console.log(`${index + 1}. ${warning}`);
      });
    }
    
    // Key metrics summary
    const metrics = readiness.metrics;
    console.log('\n📊 KEY METRICS');
    console.log('-' * 30);
    console.log(`P95 Latency: ${metrics.latency_metrics.p95.toFixed(0)}ms (target: ≤2500ms)`);
    console.log(`Uptime: ${metrics.slo_status.uptime_percentage.toFixed(2)}% (target: ≥99.5%)`);
    console.log(`Failover Misfire Rate: ${(metrics.slo_status.failover_misfire_rate * 100).toFixed(2)}% (target: ≤5%)`);
    console.log(`Average Cost: $${metrics.cost_per_task.mean.toFixed(4)} (target: ≤$0.10)`);
    
    await this.observabilityManager.shutdown();
    process.exit(readiness.ready ? 0 : 1);
  }
  
  private async handleReport(options: CLIOptions): Promise<void> {
    const timeWindow = options.flags.window ? 
      parseInt(options.flags.window as string) * 60 * 1000 : 
      undefined;
      
    console.log(`📄 Generating operational report${timeWindow ? ` (${options.flags.window}min window)` : ''}...`);
    
    await this.observabilityManager.initialize();
    const report = await this.observabilityManager.generateOperationalReport(timeWindow);
    
    console.log('\n📊 EXECUTIVE SUMMARY');
    console.log('=' * 50);
    
    const statusEmoji = {
      'GREEN': '🟢',
      'YELLOW': '🟡', 
      'RED': '🔴'
    }[report.executive_summary.status] || '⚪';
    
    console.log(`Overall Status: ${statusEmoji} ${report.executive_summary.status}`);
    
    console.log('\n📈 KEY METRICS:');
    Object.entries(report.executive_summary.key_metrics).forEach(([metric, value]) => {
      const formattedValue = typeof value === 'number' ? 
        (metric.includes('percentage') || metric.includes('rate') ? 
          `${(value * 100).toFixed(1)}%` : 
          value.toFixed(metric.includes('cost') ? 4 : 0)) : 
        value;
      console.log(`  ${metric.replace(/_/g, ' ')}: ${formattedValue}`);
    });
    
    if (report.executive_summary.achievements.length > 0) {
      console.log('\n🏆 ACHIEVEMENTS:');
      report.executive_summary.achievements.forEach(achievement => {
        console.log(`  ✅ ${achievement}`);
      });
    }
    
    if (report.executive_summary.critical_issues.length > 0) {
      console.log('\n🚨 CRITICAL ISSUES:');
      report.executive_summary.critical_issues.forEach(issue => {
        console.log(`  ❌ ${issue}`);
      });
    }
    
    console.log('\n💰 COST ANALYSIS');
    console.log('-' * 30);
    console.log(`Current Burn Rate: $${report.cost_analysis.current_burn_rate.toFixed(2)}/day`);
    console.log(`Projected Monthly: $${report.cost_analysis.projected_monthly.toFixed(2)}`);
    console.log(`Efficiency Score: ${report.cost_analysis.efficiency_score.toFixed(1)}/100`);
    
    if (report.cost_analysis.optimization_potential.length > 0) {
      console.log('\n💡 COST OPTIMIZATIONS:');
      report.cost_analysis.optimization_potential.forEach(opt => {
        console.log(`  💰 ${opt}`);
      });
    }
    
    console.log('\n⚡ PERFORMANCE ANALYSIS');
    console.log('-' * 30);
    console.log(`Latency Trend: ${report.performance_analysis.latency_trends}`);
    
    console.log('\n🏆 PROVIDER RANKINGS:');
    report.performance_analysis.provider_rankings.forEach((provider, index) => {
      console.log(`  ${index + 1}. ${provider.provider}: ${(provider.score * 100).toFixed(1)}`);
    });
    
    if (report.performance_analysis.bottlenecks.length > 0) {
      console.log('\n🚧 BOTTLENECKS:');
      report.performance_analysis.bottlenecks.forEach(bottleneck => {
        console.log(`  ⚠️ ${bottleneck}`);
      });
    }
    
    if (options.flags.format === 'json') {
      console.log('\n📄 JSON REPORT:');
      console.log(JSON.stringify(report, null, 2));
    }
    
    await this.observabilityManager.shutdown();
  }
  
  private async handleMetrics(options: CLIOptions): Promise<void> {
    const timeWindow = options.flags.window ? 
      parseInt(options.flags.window as string) * 60 * 1000 : 
      undefined;
      
    console.log('📊 Fetching metrics...');
    
    await this.observabilityManager.initialize();
    const metrics = this.observabilityManager.getEnhancedPostHook().getDashboardMetrics(timeWindow);
    
    if (options.flags.format === 'json') {
      console.log(JSON.stringify(metrics, null, 2));
    } else {
      this.displayMetrics(metrics);
    }
    
    await this.observabilityManager.shutdown();
  }
  
  private async handleSLO(options: CLIOptions): Promise<void> {
    console.log('🎯 Checking SLO compliance...');
    
    await this.observabilityManager.initialize();
    const sloGuardrails = this.observabilityManager.getEnhancedPostHook().getSLOGuardrails();
    const sloStatus = await sloGuardrails.validateDeployment();
    
    console.log('\n🎯 SLO COMPLIANCE STATUS');
    console.log('=' * 50);
    
    const status = sloStatus.deployment_allowed ? '✅ COMPLIANT' : '❌ VIOLATION';
    console.log(`Status: ${status}`);
    console.log(`Gates Passed: ${sloStatus.gates_passed}/${sloStatus.gates_total}`);
    
    if (!sloStatus.deployment_allowed) {
      console.log('\n🚫 SLO VIOLATIONS:');
      sloStatus.blocking_failures.forEach((failure, index) => {
        console.log(`${index + 1}. ${failure.message}`);
      });
    }
    
    if (sloStatus.warnings.length > 0) {
      console.log('\n⚠️  WARNINGS:');
      sloStatus.warnings.forEach((warning, index) => {
        console.log(`${index + 1}. ${warning.message}`);
      });
    }
    
    await this.observabilityManager.shutdown();
  }
  
  private async handleEmergency(options: CLIOptions): Promise<void> {
    console.log('🚨 Checking for emergency rollback conditions...');
    
    await this.observabilityManager.initialize();
    const sloGuardrails = this.observabilityManager.getEnhancedPostHook().getSLOGuardrails();
    const emergencyCheck = sloGuardrails.checkEmergencyRollback();
    
    console.log('\n🚨 EMERGENCY ROLLBACK ASSESSMENT');
    console.log('=' * 50);
    
    if (emergencyCheck.rollback_required) {
      const severityEmoji = {
        'critical': '🔥',
        'high': '🚨',
        'medium': '⚠️',
        'low': 'ℹ️'
      }[emergencyCheck.severity] || '❓';
      
      console.log(`${severityEmoji} ROLLBACK REQUIRED (${emergencyCheck.severity.toUpperCase()})`);
      console.log(`Reason: ${emergencyCheck.reason}`);
      console.log(`Immediate Action: ${emergencyCheck.immediate_action_required ? 'YES' : 'NO'}`);
      
      if (emergencyCheck.immediate_action_required) {
        console.log('\n🚨 IMMEDIATE ACTIONS:');
        console.log('1. Initiate emergency rollback procedure');
        console.log('2. Notify on-call team immediately');
        console.log('3. Activate incident response protocol');
        console.log('4. Monitor system recovery');
      }
    } else {
      console.log('✅ NO EMERGENCY ROLLBACK REQUIRED');
      console.log(`Status: ${emergencyCheck.reason}`);
    }
    
    await this.observabilityManager.shutdown();
    process.exit(emergencyCheck.rollback_required ? 1 : 0);
  }
  
  private displayMetrics(metrics: any): void {
    console.log('\n📊 DASHBOARD METRICS');
    console.log('=' * 50);
    
    console.log('\n🎯 ROUTE DISTRIBUTION:');
    Object.entries(metrics.route_share_by_bucket).forEach(([bucket, share]) => {
      console.log(`  ${bucket}: ${((share as number) * 100).toFixed(1)}%`);
    });
    
    console.log('\n💰 COST METRICS:');
    console.log(`  Average: $${metrics.cost_per_task.mean.toFixed(4)}`);
    console.log(`  P95: $${metrics.cost_per_task.p95.toFixed(4)}`);
    
    console.log('\n⚡ LATENCY METRICS:');
    console.log(`  P95: ${metrics.latency_metrics.p95.toFixed(0)}ms`);
    console.log(`  P99: ${metrics.latency_metrics.p99.toFixed(0)}ms`);
    console.log(`  Average: ${metrics.latency_metrics.mean.toFixed(0)}ms`);
    
    console.log('\n🔄 ANTHROPIC 429 MONITORING:');
    console.log(`  Rate: ${(metrics.anthropic_429_rate.rate * 100).toFixed(2)}%`);
    console.log(`  Escalations (1h): ${metrics.anthropic_429_rate.escalations_last_hour}`);
    console.log(`  Cooldown Users: ${metrics.anthropic_429_rate.cooldown_users}`);
    
    console.log('\n🏆 WIN RATE VS BASELINE:');
    console.log(`  Overall: ${(metrics.win_rate_vs_baseline.overall * 100).toFixed(1)}%`);
    Object.entries(metrics.win_rate_vs_baseline.by_bucket).forEach(([bucket, rate]) => {
      console.log(`  ${bucket}: ${((rate as number) * 100).toFixed(1)}%`);
    });
    
    console.log('\n🔍 SLO STATUS:');
    console.log(`  P95 Target: ${metrics.slo_status.p95_latency_target}ms`);
    console.log(`  P95 Actual: ${metrics.slo_status.p95_latency_actual.toFixed(0)}ms`);
    console.log(`  Target Met: ${metrics.slo_status.target_met ? '✅' : '❌'}`);
    console.log(`  Uptime: ${metrics.slo_status.uptime_percentage.toFixed(2)}%`);
  }
  
  private getHealthEmoji(health: string): string {
    const emojiMap: Record<string, string> = {
      'healthy': '✅',
      'running': '✅', 
      'connected': '✅',
      'compliant': '✅',
      'degraded': '⚠️',
      'violation': '❌',
      'unhealthy': '❌',
      'stopped': '❌',
      'error': '❌',
      'disconnected': '❌',
      'unknown': '❓'
    };
    
    return emojiMap[health] || '❓';
  }
  
  private parseArgs(argv: string[]): CLIOptions {
    const args = argv.slice(2);
    if (args.length === 0) {
      return { command: 'help', args: [], flags: {} };
    }
    
    const command = args[0];
    const flags: Record<string, string | boolean> = {};
    const remainingArgs: string[] = [];
    
    for (let i = 1; i < args.length; i++) {
      const arg = args[i];
      if (arg.startsWith('--')) {
        const [key, value] = arg.slice(2).split('=');
        flags[key] = value || true;
      } else if (arg.startsWith('-')) {
        flags[arg.slice(1)] = true;
      } else {
        remainingArgs.push(arg);
      }
    }
    
    return { command, args: remainingArgs, flags };
  }
  
  private showHelp(): void {
    console.log(`
🌈 Bifrost Router Observability CLI
`);
    console.log('Commands:');
    console.log('  status              Show operational status');
    console.log('  dashboard           Start dashboard server');
    console.log('  validate            Run SLO validation for deployment');
    console.log('  deploy-check        Check deployment readiness');
    console.log('  report              Generate operational report');
    console.log('  metrics             Show current metrics');
    console.log('  slo                 Check SLO compliance');
    console.log('  emergency           Check emergency rollback conditions');
    console.log('  help                Show this help message');
    
    console.log('\nFlags:');
    console.log('  --detailed          Show detailed information');
    console.log('  --window=<minutes>  Time window for metrics (default: 24h)');
    console.log('  --format=json       Output in JSON format');
    console.log('  --port=<port>       Dashboard server port (default: 8090)');
    
    console.log('\nExamples:');
    console.log('  npm run obs status --detailed');
    console.log('  npm run obs validate');
    console.log('  npm run obs report --window=60 --format=json');
    console.log('  npm run obs dashboard --port=8080');
    console.log('  npm run obs emergency');
  }
}

// Main execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const cli = new ObservabilityCLI();
  cli.run(process.argv).catch(error => {
    console.error('CLI error:', error);
    process.exit(1);
  });
}

export { ObservabilityCLI };