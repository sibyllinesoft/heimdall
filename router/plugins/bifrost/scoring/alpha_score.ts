/**
 * Avengers-Pro α-score Implementation
 * In-bucket model selection using quality vs cost trade-off
 */

import { RequestFeatures, AvengersArtifact } from '../../../../src/types/common.js';

export interface ModelScore {
  model: string;
  quality_score: number;
  cost_score: number;
  penalty_score: number;
  alpha_score: number;
}

/**
 * α-score calculator for Avengers-Pro routing
 */
export class AlphaScorer {
  /**
   * Select the best model from candidates using α-score
   * Formula: α * Q̂[m,c] - (1-α) * Ĉ[m] - penalties
   */
  async selectBest(
    candidates: string[],
    features: RequestFeatures,
    artifact: AvengersArtifact
  ): Promise<string> {
    try {
      const scores = await this.scoreModels(candidates, features, artifact);
      
      if (scores.length === 0) {
        throw new Error('No valid model scores');
      }
      
      // Sort by α-score (descending)
      scores.sort((a, b) => b.alpha_score - a.alpha_score);
      
      const best = scores[0];
      console.log(`Selected model: ${best.model} (score: ${best.alpha_score.toFixed(3)})`);
      
      return best.model;
    } catch (error) {
      console.error('α-score selection failed:', error);
      // Fallback to first candidate
      return candidates[0];
    }
  }
  
  /**
   * Score all candidate models
   */
  async scoreModels(
    candidates: string[],
    features: RequestFeatures,
    artifact: AvengersArtifact
  ): Promise<ModelScore[]> {
    const scores: ModelScore[] = [];
    
    for (const model of candidates) {
      try {
        const score = await this.scoreModel(model, features, artifact);
        if (score !== null) {
          scores.push(score);
        }
      } catch (error) {
        console.warn(`Failed to score model ${model}:`, error);
      }
    }
    
    return scores;
  }
  
  /**
   * Score a single model using α-score formula
   */
  private async scoreModel(
    model: string,
    features: RequestFeatures,
    artifact: AvengersArtifact
  ): Promise<ModelScore | null> {
    // Get quality score for this model and cluster
    const qualityScore = this.getQualityScore(model, features.cluster_id, artifact);
    if (qualityScore === null) {
      console.warn(`No quality score for model ${model}`);
      return null;
    }
    
    // Get cost score for this model
    const costScore = this.getCostScore(model, artifact);
    if (costScore === null) {
      console.warn(`No cost score for model ${model}`);
      return null;
    }
    
    // Calculate penalties
    const penaltyScore = this.calculatePenalties(model, features, artifact);
    
    // Calculate α-score: α * Q̂[m,c] - (1-α) * Ĉ[m] - penalties
    const alpha = artifact.alpha;
    const alphaScore = (alpha * qualityScore) - ((1 - alpha) * costScore) - penaltyScore;
    
    return {
      model,
      quality_score: qualityScore,
      cost_score: costScore,
      penalty_score: penaltyScore,
      alpha_score: alphaScore
    };
  }
  
  /**
   * Get quality score Q̂[m,c] for model m in cluster c
   */
  private getQualityScore(
    model: string,
    clusterId: number,
    artifact: AvengersArtifact
  ): number | null {
    const modelQuality = artifact.qhat[model];
    if (!modelQuality || !Array.isArray(modelQuality)) {
      return null;
    }
    
    // Use cluster-specific quality score, fallback to average
    const clusterScore = modelQuality[clusterId];
    if (clusterScore !== undefined) {
      return clusterScore;
    }
    
    // Fallback to average quality across all clusters
    const avgScore = modelQuality.reduce((sum, score) => sum + score, 0) / modelQuality.length;
    return avgScore;
  }
  
  /**
   * Get normalized cost score Ĉ[m] for model m
   */
  private getCostScore(model: string, artifact: AvengersArtifact): number | null {
    return artifact.chat[model] || null;
  }
  
  /**
   * Calculate penalties based on context, latency, and other factors
   */
  private calculatePenalties(
    model: string,
    features: RequestFeatures,
    artifact: AvengersArtifact
  ): number {
    let penalty = 0;
    const penalties = artifact.penalties;
    
    // Context over-utilization penalty
    if (features.context_ratio > 0.8) {
      penalty += penalties.ctx_over_80pct;
    }
    
    // Latency standard deviation penalty
    // This would be based on historical data - using heuristic for now
    const expectedLatency = this.estimateLatency(model, features);
    const avgLatency = features.avg_latency || expectedLatency;
    const latencyVariance = Math.abs(expectedLatency - avgLatency) / avgLatency;
    
    if (latencyVariance > 0.2) { // 20% variance threshold
      penalty += penalties.latency_sd * latencyVariance;
    }
    
    // Model-specific penalties
    penalty += this.getModelSpecificPenalties(model, features);
    
    return penalty;
  }
  
  /**
   * Estimate latency for model based on features
   */
  private estimateLatency(model: string, features: RequestFeatures): number {
    // Base latency estimates (in seconds)
    const baseLatencies: Record<string, number> = {
      'deepseek/deepseek-r1': 3.0,
      'qwen/qwen3-coder': 2.5,
      'openai/gpt-5': 8.0,
      'google/gemini-2.5-pro': 6.0
    };
    
    let latency = baseLatencies[model] || 5.0;
    
    // Scale with token count
    const tokenMultiplier = Math.min(features.token_count / 10000, 3.0);
    latency *= (1 + tokenMultiplier * 0.5);
    
    // Reasoning models take longer for complex tasks
    if ((model.includes('gpt-5') || model.includes('gemini')) && 
        (features.has_code || features.has_math)) {
      latency *= 1.5;
    }
    
    return latency;
  }
  
  /**
   * Model-specific penalty adjustments
   */
  private getModelSpecificPenalties(
    model: string,
    features: RequestFeatures
  ): number {
    let penalty = 0;
    
    // Penalize models that are poor fits for the task
    if (features.has_code && model.includes('deepseek')) {
      // DeepSeek is good for code, bonus
      penalty -= 0.05;
    }
    
    if (features.has_math && !model.includes('gpt-5') && !model.includes('gemini')) {
      // Math tasks benefit from reasoning models
      penalty += 0.1;
    }
    
    // Very long context penalty for models without good long-context support
    if (features.token_count > 100000 && !model.includes('gemini')) {
      penalty += 0.15;
    }
    
    return penalty;
  }
  
  /**
   * Get detailed scoring breakdown for debugging
   */
  async getDetailedScores(
    candidates: string[],
    features: RequestFeatures,
    artifact: AvengersArtifact
  ): Promise<ModelScore[]> {
    return this.scoreModels(candidates, features, artifact);
  }
  
  /**
   * Validate artifact has required scoring data
   */
  validateArtifact(artifact: AvengersArtifact): {
    isValid: boolean;
    missingModels: string[];
    issues: string[];
  } {
    const issues: string[] = [];
    const missingModels: string[] = [];
    
    // Check alpha value
    if (typeof artifact.alpha !== 'number' || artifact.alpha < 0 || artifact.alpha > 1) {
      issues.push('Invalid alpha value');
    }
    
    // Check for missing quality scores
    if (!artifact.qhat || typeof artifact.qhat !== 'object') {
      issues.push('Missing quality scores (qhat)');
    }
    
    // Check for missing cost scores
    if (!artifact.chat || typeof artifact.chat !== 'object') {
      issues.push('Missing cost scores (chat)');
    }
    
    // Check for missing penalties
    if (!artifact.penalties) {
      issues.push('Missing penalty configuration');
    }
    
    // Check common models
    const commonModels = [
      'deepseek/deepseek-r1',
      'qwen/qwen3-coder',
      'openai/gpt-5',
      'google/gemini-2.5-pro'
    ];
    
    for (const model of commonModels) {
      if (!artifact.qhat?.[model] || !artifact.chat?.[model]) {
        missingModels.push(model);
      }
    }
    
    return {
      isValid: issues.length === 0,
      missingModels,
      issues
    };
  }
  
  /**
   * Calculate diversity score to avoid always picking the same model
   */
  private calculateDiversityBonus(
    model: string,
    recentSelections: string[] = []
  ): number {
    // Simple diversity bonus based on recent selections
    const recentCount = recentSelections.filter(m => m === model).length;
    const diversityBonus = Math.max(0, 0.1 - (recentCount * 0.02));
    
    return diversityBonus;
  }
  
  /**
   * A/B test mode: randomly select between top N models
   */
  async selectWithExploration(
    candidates: string[],
    features: RequestFeatures,
    artifact: AvengersArtifact,
    explorationRate = 0.1,
    topN = 2
  ): Promise<string> {
    const scores = await this.scoreModels(candidates, features, artifact);
    
    if (scores.length === 0) {
      return candidates[0];
    }
    
    scores.sort((a, b) => b.alpha_score - a.alpha_score);
    
    // Exploration: randomly select from top N with explorationRate probability
    if (Math.random() < explorationRate && scores.length > 1) {
      const topCandidates = scores.slice(0, Math.min(topN, scores.length));
      const randomIndex = Math.floor(Math.random() * topCandidates.length);
      console.log(`Exploration selection: ${topCandidates[randomIndex].model}`);
      return topCandidates[randomIndex].model;
    }
    
    // Exploitation: select the best
    return scores[0].model;
  }
}