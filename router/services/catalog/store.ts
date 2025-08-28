/**
 * Catalog Store using SQLite for model metadata persistence
 */

import Database from 'better-sqlite3';
import { ModelInfo, ModelCapabilities, ModelPricing } from '../../../src/types/common.js';

export interface ModelFilter {
  provider?: string;
  family?: string;
}

export interface CatalogStats {
  total_models: number;
  providers: Record<string, number>;
  last_updated: string;
}

export class CatalogStore {
  private db: Database.Database;
  
  constructor(private dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
  }
  
  async initialize(): Promise<void> {
    // Create tables if they don't exist
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS models (
        slug TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        family TEXT NOT NULL,
        ctx_in INTEGER NOT NULL,
        params_json TEXT NOT NULL,
        pricing_json TEXT NOT NULL,
        capabilities_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE TABLE IF NOT EXISTS feature_flags (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE INDEX IF NOT EXISTS idx_models_provider ON models(provider);
      CREATE INDEX IF NOT EXISTS idx_models_family ON models(family);
      CREATE INDEX IF NOT EXISTS idx_models_updated_at ON models(updated_at);
    `);
  }
  
  async getModels(filter?: ModelFilter): Promise<ModelInfo[]> {
    let query = 'SELECT * FROM models';
    const params: unknown[] = [];
    const conditions: string[] = [];
    
    if (filter?.provider) {
      conditions.push('provider = ?');
      params.push(filter.provider);
    }
    
    if (filter?.family) {
      conditions.push('family = ?');
      params.push(filter.family);
    }
    
    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    
    query += ' ORDER BY provider, family, slug';
    
    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as Array<{
      slug: string;
      provider: string;
      family: string;
      ctx_in: number;
      params_json: string;
      pricing_json: string;
      capabilities_json: string | null;
    }>;
    
    return rows.map(row => ({
      slug: row.slug,
      provider: row.provider as any,
      family: row.family,
      ctx_in: row.ctx_in,
      params: JSON.parse(row.params_json),
      pricing: JSON.parse(row.pricing_json),
      capabilities: row.capabilities_json ? JSON.parse(row.capabilities_json) : undefined
    }));
  }
  
  async getModel(slug: string): Promise<ModelInfo | null> {
    const stmt = this.db.prepare('SELECT * FROM models WHERE slug = ?');
    const row = stmt.get(slug) as {
      slug: string;
      provider: string;
      family: string;
      ctx_in: number;
      params_json: string;
      pricing_json: string;
      capabilities_json: string | null;
    } | undefined;
    
    if (!row) return null;
    
    return {
      slug: row.slug,
      provider: row.provider as any,
      family: row.family,
      ctx_in: row.ctx_in,
      params: JSON.parse(row.params_json),
      pricing: JSON.parse(row.pricing_json),
      capabilities: row.capabilities_json ? JSON.parse(row.capabilities_json) : undefined
    };
  }
  
  async getCapabilities(slug: string): Promise<ModelCapabilities | null> {
    const stmt = this.db.prepare('SELECT capabilities_json FROM models WHERE slug = ?');
    const row = stmt.get(slug) as { capabilities_json: string | null } | undefined;
    
    if (!row || !row.capabilities_json) return null;
    
    return JSON.parse(row.capabilities_json);
  }
  
  async getPricing(slug: string): Promise<ModelPricing | null> {
    const stmt = this.db.prepare('SELECT pricing_json FROM models WHERE slug = ?');
    const row = stmt.get(slug) as { pricing_json: string } | undefined;
    
    if (!row) return null;
    
    return JSON.parse(row.pricing_json);
  }
  
  async updateModels(models: ModelInfo[]): Promise<void> {
    const updateStmt = this.db.prepare(`
      INSERT OR REPLACE INTO models (
        slug, provider, family, ctx_in, params_json, pricing_json, capabilities_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);
    
    const transaction = this.db.transaction((models: ModelInfo[]) => {
      for (const model of models) {
        updateStmt.run(
          model.slug,
          model.provider,
          model.family,
          model.ctx_in,
          JSON.stringify(model.params),
          JSON.stringify(model.pricing),
          model.capabilities ? JSON.stringify(model.capabilities) : null
        );
      }
      
      // Update metadata
      const metaStmt = this.db.prepare(`
        INSERT OR REPLACE INTO metadata (key, value, updated_at) 
        VALUES (?, ?, CURRENT_TIMESTAMP)
      `);
      metaStmt.run('last_update', new Date().toISOString());
      metaStmt.run('model_count', models.length.toString());
    });
    
    transaction(models);
  }
  
  async getFeatureFlags(): Promise<Record<string, unknown>> {
    const stmt = this.db.prepare('SELECT key, value FROM feature_flags');
    const rows = stmt.all() as Array<{ key: string; value: string }>;
    
    const flags: Record<string, unknown> = {};
    for (const row of rows) {
      try {
        flags[row.key] = JSON.parse(row.value);
      } catch {
        flags[row.key] = row.value;
      }
    }
    
    return flags;
  }
  
  async setFeatureFlag(key: string, value: unknown): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO feature_flags (key, value, updated_at) 
      VALUES (?, ?, CURRENT_TIMESTAMP)
    `);
    stmt.run(key, JSON.stringify(value));
  }
  
  async getStats(): Promise<CatalogStats> {
    const totalStmt = this.db.prepare('SELECT COUNT(*) as count FROM models');
    const total = (totalStmt.get() as { count: number }).count;
    
    const providerStmt = this.db.prepare(`
      SELECT provider, COUNT(*) as count 
      FROM models 
      GROUP BY provider
    `);
    const providerRows = providerStmt.all() as Array<{ provider: string; count: number }>;
    
    const providers: Record<string, number> = {};
    for (const row of providerRows) {
      providers[row.provider] = row.count;
    }
    
    const metaStmt = this.db.prepare('SELECT value FROM metadata WHERE key = ?');
    const lastUpdate = (metaStmt.get('last_update') as { value: string } | undefined)?.value || 
                       new Date().toISOString();
    
    return {
      total_models: total,
      providers,
      last_updated: lastUpdate
    };
  }
  
  async close(): Promise<void> {
    this.db.close();
  }
}