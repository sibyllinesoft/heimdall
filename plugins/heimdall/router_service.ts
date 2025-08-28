#!/usr/bin/env node

/**
 * Simple HTTP service wrapper for the Heimdall RouterPreHook
 * This allows the Go plugin to call the TypeScript router via HTTP
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { URL } from 'url';
import { RouterPreHook, PreHookRequest, PreHookResponse } from '../../router/plugins/bifrost/router_prehook.js';
import { RouterConfig } from '../../src/types/common.js';

// Default configuration for the router
const defaultConfig: RouterConfig = {
  router: {
    alpha: 0.7,
    thresholds: {
      cheap: 0.6,
      hard: 0.3,
    },
    top_p: 0.05,
    penalties: {
      latency_sd: 2.0,
      ctx_over_80pct: 5.0,
    },
    bucket_defaults: {
      mid: {
        gpt5_reasoning_effort: 'medium',
        gemini_thinking_budget: 5000,
      },
      hard: {
        gpt5_reasoning_effort: 'high', 
        gemini_thinking_budget: 10000,
      },
    },
    cheap_candidates: [
      'qwen/qwen-2.5-coder-32b-instruct',
      'deepseek/deepseek-r1',
    ],
    mid_candidates: [
      'openai/gpt-4o',
      'anthropic/claude-3-5-sonnet-20241022',
      'google/gemini-1.5-pro',
    ],
    hard_candidates: [
      'google/gemini-2.0-flash-thinking-exp',
      'openai/o1',
      'anthropic/claude-3-opus',
    ],
    openrouter: {
      exclude_authors: ['huggingface'],
      provider: {
        sort: 'price',
        max_price: 10,
        allow_fallbacks: true,
      },
    },
  },
  auth_adapters: {
    enabled: ['openai-key', 'anthropic-oauth', 'google-oauth'],
  },
  catalog: {
    base_url: 'http://localhost:8001',
    refresh_seconds: 3600,
  },
  tuning: {
    artifact_url: 'http://localhost:8002/artifacts/latest',
    reload_seconds: 300,
  },
};

class RouterService {
  private router: RouterPreHook;
  private server?: any;

  constructor(config: RouterConfig = defaultConfig) {
    this.router = new RouterPreHook(
      config,
      config.catalog.base_url
    );
  }

  async start(port = 3000) {
    this.server = createServer((req, res) => {
      this.handleRequest(req, res).catch(error => {
        console.error('Request handling error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Internal server error',
          message: error.message,
        }));
      });
    });

    this.server.listen(port, () => {
      console.log(`Heimdall Router Service listening on port ${port}`);
      console.log(`Health check: http://localhost:${port}/health`);
      console.log(`Decide endpoint: http://localhost:${port}/decide`);
    });

    // Graceful shutdown
    process.on('SIGTERM', () => this.shutdown());
    process.on('SIGINT', () => this.shutdown());

    return this.server;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url || '/', `http://localhost`);
    
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    if (url.pathname === '/health') {
      await this.handleHealth(req, res);
    } else if (url.pathname === '/decide' && req.method === 'POST') {
      await this.handleDecide(req, res);
    } else if (url.pathname === '/metrics') {
      await this.handleMetrics(req, res);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  }

  private async handleHealth(req: IncomingMessage, res: ServerResponse) {
    try {
      // Check if router is healthy
      const health = await this.router.healthCheck();
      const artifactVersion = this.router.getCurrentArtifactVersion();
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'healthy',
        service: 'heimdall-router',
        version: '0.1.0',
        artifact_version: artifactVersion,
        providers: health,
        timestamp: new Date().toISOString(),
      }));
    } catch (error) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'unhealthy',
        error: error instanceof Error ? error.message : 'Unknown error',
      }));
    }
  }

  private async handleDecide(req: IncomingMessage, res: ServerResponse) {
    const startTime = Date.now();
    
    try {
      // Parse request body
      const body = await this.parseBody(req);
      const request = body as PreHookRequest;

      if (!request.url || !request.method) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Bad request',
          message: 'url and method are required',
        }));
        return;
      }

      // Make routing decision
      const decision = await this.router.decide(request);
      const processingTime = Date.now() - startTime;

      // Log the decision
      console.log(`Router decision made in ${processingTime}ms`, {
        bucket: decision.bucket,
        provider: decision.decision.kind,
        model: decision.decision.model,
        fallback: decision.fallback_reason,
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ...decision,
        processing_time_ms: processingTime,
      }));

    } catch (error) {
      const processingTime = Date.now() - startTime;
      console.error(`Router decision failed after ${processingTime}ms:`, error);
      
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Decision failed',
        message: error instanceof Error ? error.message : 'Unknown error',
        processing_time_ms: processingTime,
      }));
    }
  }

  private async handleMetrics(req: IncomingMessage, res: ServerResponse) {
    try {
      // Get basic metrics (you could expand this)
      const metrics = {
        service: 'heimdall-router',
        uptime_seconds: process.uptime(),
        memory_usage: process.memoryUsage(),
        cpu_usage: process.cpuUsage(),
        artifact_version: this.router.getCurrentArtifactVersion(),
        timestamp: new Date().toISOString(),
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(metrics));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Metrics failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      }));
    }
  }

  private async parseBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
      });
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (error) {
          reject(new Error('Invalid JSON body'));
        }
      });
      req.on('error', reject);
    });
  }

  private shutdown() {
    console.log('Shutting down Heimdall Router Service...');
    if (this.server) {
      this.server.close(() => {
        console.log('Server closed');
        process.exit(0);
      });
    }
  }
}

// CLI usage
if (require.main === module) {
  const port = parseInt(process.env.PORT || '3000', 10);
  const service = new RouterService();
  
  service.start(port).catch(error => {
    console.error('Failed to start router service:', error);
    process.exit(1);
  });
}

export default RouterService;