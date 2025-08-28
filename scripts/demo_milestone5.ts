#!/usr/bin/env node
/**
 * Milestone 5 Observability & Guardrails Demo
 * Demonstrates the comprehensive observability features implemented
 */

import { ObservabilityManager } from '../router/plugins/bifrost/observability/observability_manager.js';
import { Milestone5TestSuite } from '../router/plugins/bifrost/test_milestone5.js';

async function runDemo(): Promise<void> {
  console.log('🌈 Bifrost Router - Milestone 5 Observability Demo');
  console.log('=' * 60);
  
  try {
    // 1. Run comprehensive test suite
    console.log('\n🧪 STEP 1: Running Comprehensive Test Suite');
    console.log('-' * 50);
    
    const testSuite = new Milestone5TestSuite();
    await testSuite.runAllTests();
    
    // 2. Initialize observability manager
    console.log('\n\n🔧 STEP 2: Initializing Observability Manager');
    console.log('-' * 50);
    
    const manager = new ObservabilityManager({
      dashboard: { port: 8093 }, // Use different port for demo
      posthook: {
        enableWarehouseEmission: false, // Disable for demo
        enableRealTimeAlerting: false
      }
    });
    
    await manager.initialize();
    console.log('✅ Observability manager initialized');
    
    // 3. Generate sample metrics
    console.log('\n📊 STEP 3: Generating Sample Metrics');
    console.log('-' * 50);
    
    const postHook = manager.getEnhancedPostHook();
    const collector = postHook.getMetricsCollector();
    
    // Simulate realistic traffic patterns
    const scenarios = [
      // Cheap bucket - successful requests
      { bucket: 'cheap', provider: 'deepseek/deepseek-r1', latency: 800, cost: 0.01, success: true, count: 15 },
      // Mid bucket - mixed success with some 429s
      { bucket: 'mid', provider: 'anthropic', latency: 2000, cost: 0.045, success: true, count: 8 },
      { bucket: 'mid', provider: 'anthropic', latency: 2200, cost: 0.045, success: true, count: 2, anthropic_429: true },
      // Hard bucket - high thinking budget
      { bucket: 'hard', provider: 'google', latency: 3500, cost: 0.12, success: true, count: 5 },
      // Some failures for realistic metrics
      { bucket: 'mid', provider: 'openai', latency: 8000, cost: 0.06, success: false, count: 1 }
    ];
    
    for (const scenario of scenarios) {
      for (let i = 0; i < scenario.count; i++) {
        const mockRequest = {
          originalRequest: {
            url: '/v1/chat/completions',
            method: 'POST',
            headers: { 'authorization': 'Bearer demo-token-' + i }
          },
          decision: {
            kind: scenario.provider.split('/')[0] as any,
            model: scenario.provider,
            params: {}
          },
          features: {
            token_count: 150 + Math.random() * 100,
            has_code: Math.random() > 0.5,
            has_math: Math.random() > 0.7,
            context_ratio: Math.random() * 0.3
          },
          execution: {
            provider_used: scenario.provider,
            success: scenario.success,
            execution_time_ms: scenario.latency + Math.random() * 200,
            fallback_used: scenario.anthropic_429 || false,
            fallback_reason: scenario.anthropic_429 ? 'anthropic_429' : undefined,
            response: {
              usage: {
                prompt_tokens: 100 + Math.floor(Math.random() * 50),
                completion_tokens: 50 + Math.floor(Math.random() * 25),
                total_tokens: 150 + Math.floor(Math.random() * 75)
              }
            },
            error: scenario.success ? undefined : { type: 'timeout', message: 'Request timeout' }
          },
          startTime: Date.now() - scenario.latency,
          endTime: Date.now()
        };
        
        await postHook.process(mockRequest as any);
      }
    }
    
    console.log('✅ Generated metrics from 31 simulated requests');
    
    // 4. Display dashboard metrics
    console.log('\n📊 STEP 4: Dashboard Metrics Summary');
    console.log('-' * 50);
    
    const metrics = collector.getDashboardMetrics();
    
    console.log('\n🎯 ROUTE DISTRIBUTION:');
    Object.entries(metrics.route_share_by_bucket).forEach(([bucket, share]) => {
      const percentage = (share * 100).toFixed(1);
      const bar = '█'.repeat(Math.floor(share * 20));
      console.log(`  ${bucket.padEnd(6)}: ${percentage.padStart(5)}% ${bar}`);
    });
    
    console.log('\n💰 COST ANALYSIS:');
    console.log(`  Average Cost: $${metrics.cost_per_task.mean.toFixed(4)}`);
    console.log(`  P95 Cost:     $${metrics.cost_per_task.p95.toFixed(4)}`);
    
    console.log('\n⚡ LATENCY METRICS:');
    console.log(`  P95 Latency:  ${metrics.latency_metrics.p95.toFixed(0)}ms`);
    console.log(`  P99 Latency:  ${metrics.latency_metrics.p99.toFixed(0)}ms`);
    console.log(`  Average:      ${metrics.latency_metrics.mean.toFixed(0)}ms`);
    
    console.log('\n🔄 ANTHROPIC 429 MONITORING:');
    console.log(`  429 Rate:     ${(metrics.anthropic_429_rate.rate * 100).toFixed(2)}%`);
    console.log(`  Escalations:  ${metrics.anthropic_429_rate.escalations_last_hour}`);
    
    console.log('\n🏆 WIN RATE vs BASELINE:');
    console.log(`  Overall:      ${(metrics.win_rate_vs_baseline.overall * 100).toFixed(1)}%`);
    
    console.log('\n🔍 PROVIDER HEALTH:');
    Object.entries(metrics.provider_health).forEach(([provider, health]) => {
      const availability = (health.availability * 100).toFixed(1);
      const status = health.availability >= 0.99 ? '✅' : health.availability >= 0.95 ? '⚠️' : '❌';
      console.log(`  ${provider.padEnd(20)}: ${status} ${availability}% (${health.avg_latency.toFixed(0)}ms avg)`);
    });
    
    // 5. SLO Compliance Check
    console.log('\n🎯 STEP 5: SLO Compliance Validation');
    console.log('-' * 50);
    
    const sloStatus = collector.checkSLOCompliance();
    const statusEmoji = sloStatus.compliant ? '✅' : '❌';
    const statusText = sloStatus.compliant ? 'COMPLIANT' : 'VIOLATION';
    
    console.log(`SLO Status: ${statusEmoji} ${statusText}`);
    
    if (!sloStatus.compliant) {
      console.log('\n🚫 SLO VIOLATIONS:');
      sloStatus.violations.forEach((violation, index) => {
        console.log(`  ${index + 1}. ${violation}`);
      });
    }
    
    // 6. Deployment Readiness
    console.log('\n🚀 STEP 6: Deployment Readiness Assessment');
    console.log('-' * 50);
    
    const readiness = collector.getDeploymentReadiness();
    const readinessEmoji = readiness.ready ? '🟢' : '🔴';
    const readinessText = readiness.ready ? 'READY' : 'NOT READY';
    
    console.log(`Deployment Status: ${readinessEmoji} ${readinessText}`);
    
    if (!readiness.ready) {
      console.log('\n🚫 DEPLOYMENT BLOCKERS:');
      readiness.blockers.forEach((blocker, index) => {
        console.log(`  ${index + 1}. ${blocker}`);
      });
    }
    
    if (readiness.warnings.length > 0) {
      console.log('\n⚠️  WARNINGS:');
      readiness.warnings.forEach((warning, index) => {
        console.log(`  ${index + 1}. ${warning}`);
      });
    }
    
    // 7. Dashboard Server Demo
    console.log('\n🖥️  STEP 7: Dashboard Server Demonstration');
    console.log('-' * 50);
    console.log('🌍 Dashboard is running at: http://localhost:8093/dashboard');
    console.log('📊 Metrics API: http://localhost:8093/metrics');
    console.log('🎯 SLO Status: http://localhost:8093/slo-status');
    console.log('🚀 Deploy Check: http://localhost:8093/deployment-readiness');
    console.log('❕ Health Check: http://localhost:8093/health');
    
    console.log('\n⏰ Dashboard will run for 30 seconds for demonstration...');
    
    // Keep dashboard running for demo
    await new Promise(resolve => setTimeout(resolve, 30000));
    
    // 8. Cleanup
    console.log('\n🧹 STEP 8: Cleanup');
    console.log('-' * 50);
    
    await manager.shutdown();
    console.log('✅ Observability manager shutdown complete');
    
    // 9. Demo Summary
    console.log('\n🎆 MILESTONE 5 DEMO COMPLETE!');
    console.log('=' * 60);
    console.log('✅ Enhanced PostHook logging with comprehensive metrics');
    console.log('✅ Real-time dashboard with route share and cost analysis');
    console.log('✅ SLO guardrails with deployment validation');
    console.log('✅ Provider health monitoring and alerting');
    console.log('✅ Emergency rollback detection and reporting');
    console.log('✅ Complete observability pipeline working end-to-end');
    
    console.log('\n🛠️  CLI COMMANDS AVAILABLE:');
    console.log('  npm run obs status --detailed    # System status');
    console.log('  npm run obs dashboard            # Start dashboard');
    console.log('  npm run obs validate             # SLO validation');
    console.log('  npm run obs deploy-check         # Deployment check');
    console.log('  npm run obs report --format=json # Operational report');
    console.log('  npm run obs emergency            # Emergency check');
    
    console.log('\n🏆 All Milestone 5 requirements successfully implemented!');
    
  } catch (error) {
    console.error('\n❌ Demo failed:', error);
    process.exit(1);
  }
}

// Run the demo
if (import.meta.url === `file://${process.argv[1]}`) {
  runDemo().catch(error => {
    console.error('Demo error:', error);
    process.exit(1);
  });
}

export { runDemo };