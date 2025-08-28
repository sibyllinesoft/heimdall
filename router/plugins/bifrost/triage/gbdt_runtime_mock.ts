/**
 * GBDT Runtime for Bucket Triage
 * Predicts bucket probabilities (cheap/mid/hard) from request features
 */

import { RequestFeatures, BucketProbabilities, AvengersArtifact } from '../../../../src/types/common.js';

export interface GBDTModel {
  framework: string;
  model_path: string;
  feature_schema: Record<string, unknown>;
  predict(features: number[]): Promise<number[]>;
}

/**
 * Mock GBDT model for development
 * In production, replace with actual LightGBM/XGBoost model loading
 */
class MockGBDTModel implements GBDTModel {
  framework = 'mock';
  model_path = '';
  feature_schema = {
    features: [
      'cluster_id',
      'token_count',
      'has_code',
      'has_math',
      'ngram_entropy',
      'context_ratio',
      'top_p_distance_0',
      'top_p_distance_1',
      'top_p_distance_2'
    ]
  };
  
  async predict(features: number[]): Promise<number[]> {
    // Mock prediction logic based on heuristics
    const [
      cluster_id,
      token_count,
      has_code,
      has_math,
      ngram_entropy,
      context_ratio,
      top_p_dist_0 = 1.0,
      top_p_dist_1 = 1.0,
      top_p_dist_2 = 1.0
    ] = features;
    
    // Simulate real GBDT decision logic
    let cheap_score = 0.6; // Base probability for cheap bucket
    let mid_score = 0.25;   // Base probability for mid bucket
    let hard_score = 0.15;  // Base probability for hard bucket
    
    // Adjust based on token count (context length)
    if (token_count > 50000) {
      hard_score += 0.3;
      mid_score += 0.1;
      cheap_score -= 0.4;
    } else if (token_count > 10000) {
      mid_score += 0.2;
      cheap_score -= 0.1;
      hard_score -= 0.1;
    }
    
    // Adjust based on code presence
    if (has_code > 0.5) {
      // Code tasks often benefit from reasoning models
      mid_score += 0.15;
      hard_score += 0.1;
      cheap_score -= 0.25;
    }
    
    // Adjust based on math presence
    if (has_math > 0.5) {
      // Math tasks definitely benefit from reasoning
      hard_score += 0.25;
      mid_score += 0.1;
      cheap_score -= 0.35;
    }
    
    // Adjust based on complexity (entropy)
    if (ngram_entropy > 6.0) {
      // High entropy suggests complex language
      mid_score += 0.1;
      hard_score += 0.05;
      cheap_score -= 0.15;
    } else if (ngram_entropy < 3.0) {
      // Low entropy suggests simple/repetitive text
      cheap_score += 0.1;
      mid_score -= 0.05;
      hard_score -= 0.05;
    }
    
    // Adjust based on cluster distance (how "unusual" the request is)
    const avg_distance = (top_p_dist_0 + top_p_dist_1 + top_p_dist_2) / 3;
    if (avg_distance > 1.5) {
      // Unusual requests might need better models
      hard_score += 0.1;
      mid_score += 0.05;
      cheap_score -= 0.15;
    }
    
    // Normalize to probabilities
    const total = cheap_score + mid_score + hard_score;
    const normalized = [cheap_score / total, mid_score / total, hard_score / total];
    
    // Add some realistic processing delay
    await this.sleep(1 + Math.random() * 2); // 1-3ms
    
    return normalized;
  }
  
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * GBDT Runtime for bucket prediction
 */
export class GBDTRuntime {
  private model: GBDTModel | null = null;
  private featureNames: string[] = [
    'cluster_id',
    'token_count', 
    'has_code',
    'has_math',
    'ngram_entropy',
    'context_ratio',
    'top_p_distance_0',
    'top_p_distance_1',
    'top_p_distance_2'
  ];
  
  /**
   * Predict bucket probabilities from request features
   */
  async predict(
    features: RequestFeatures,
    artifact: AvengersArtifact
  ): Promise<BucketProbabilities> {
    try {
      // Ensure model is loaded
      if (!this.model) {
        await this.loadModel(artifact);
      }
      
      if (!this.model) {
        throw new Error('No GBDT model available');
      }
      
      // Convert features to numeric array
      const featureVector = this.featuresToVector(features);
      
      // Get predictions from model
      const predictions = await this.model.predict(featureVector);
      
      // Ensure we have 3 probabilities
      if (predictions.length !== 3) {
        throw new Error(`Expected 3 class probabilities, got ${predictions.length}`);
      }
      
      return {
        cheap: Math.max(0, Math.min(1, predictions[0])),
        mid: Math.max(0, Math.min(1, predictions[1])),
        hard: Math.max(0, Math.min(1, predictions[2]))
      };
      
    } catch (error) {
      console.error('GBDT prediction failed:', error);
      return this.getFallbackProbabilities(features);
    }
  }
  
  private async loadModel(artifact: AvengersArtifact): Promise<void> {
    try {
      console.log(`Loading GBDT model: ${artifact.gbdt.framework}`);
      
      if (artifact.gbdt.framework === 'lightgbm') {
        // In production, load actual LightGBM model
        // this.model = await this.loadLightGBM(artifact.gbdt.model_path);
        console.warn('LightGBM not implemented, using mock model');
        this.model = new MockGBDTModel();
      } else if (artifact.gbdt.framework === 'xgboost') {
        // In production, load actual XGBoost model
        // this.model = await this.loadXGBoost(artifact.gbdt.model_path);
        console.warn('XGBoost not implemented, using mock model');
        this.model = new MockGBDTModel();
      } else {
        // Fallback to mock model
        console.warn(`Unknown GBDT framework: ${artifact.gbdt.framework}, using mock`);
        this.model = new MockGBDTModel();
      }
      
      console.log('GBDT model loaded successfully');
    } catch (error) {
      console.error('Failed to load GBDT model:', error);
      console.log('Falling back to mock model');
      this.model = new MockGBDTModel();
    }
  }
  
  private featuresToVector(features: RequestFeatures): number[] {
    const vector: number[] = [];
    
    // Convert features to the expected order
    vector.push(features.cluster_id || 0);
    vector.push(features.token_count || 0);
    vector.push(features.has_code ? 1 : 0);
    vector.push(features.has_math ? 1 : 0);
    vector.push(features.ngram_entropy || 0);
    vector.push(features.context_ratio || 0);
    
    // Top-p distances (pad with 1.0 if missing)
    const distances = features.top_p_distances || [];
    vector.push(distances[0] || 1.0);
    vector.push(distances[1] || 1.0);
    vector.push(distances[2] || 1.0);
    
    return vector;
  }
  
  private getFallbackProbabilities(features: RequestFeatures): BucketProbabilities {
    // Simple heuristic-based fallback
    let cheapProb = 0.7;
    let midProb = 0.2;
    let hardProb = 0.1;
    
    // Long context -> harder bucket
    if (features.token_count > 20000) {
      hardProb += 0.3;
      midProb += 0.1;
      cheapProb -= 0.4;
    } else if (features.token_count > 5000) {
      midProb += 0.2;
      cheapProb -= 0.2;
    }
    
    // Code or math -> more sophisticated model
    if (features.has_code || features.has_math) {
      hardProb += 0.2;
      midProb += 0.1;
      cheapProb -= 0.3;
    }
    
    // Normalize
    const total = cheapProb + midProb + hardProb;
    
    return {
      cheap: cheapProb / total,
      mid: midProb / total,
      hard: hardProb / total
    };
  }
  
  /**
   * Get model information
   */
  getModelInfo(): {
    loaded: boolean;
    framework: string | null;
    featureNames: string[];
  } {
    return {
      loaded: this.model !== null,
      framework: this.model?.framework || null,
      featureNames: [...this.featureNames]
    };
  }
  
  /**
   * Force model reload on next prediction
   */
  invalidateModel(): void {
    this.model = null;
  }
  
  /**
   * Validate feature vector before prediction
   */
  private validateFeatures(features: number[]): boolean {
    if (features.length !== this.featureNames.length) {
      console.error(
        `Feature vector length mismatch: expected ${this.featureNames.length}, got ${features.length}`
      );
      return false;
    }
    
    // Check for invalid values
    for (let i = 0; i < features.length; i++) {
      if (!isFinite(features[i])) {
        console.error(`Invalid feature value at index ${i}: ${features[i]}`);
        return false;
      }
    }
    
    return true;
  }
  
  /**
   * Get prediction statistics (for monitoring)
   */
  getStats(): {
    totalPredictions: number;
    avgPredictionTime: number;
    errorRate: number;
  } {
    // TODO: Implement prediction tracking
    return {
      totalPredictions: 0,
      avgPredictionTime: 0,
      errorRate: 0
    };
  }
}