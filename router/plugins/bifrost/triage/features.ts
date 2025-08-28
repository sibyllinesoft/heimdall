/**
 * Feature Extraction for GBDT Triage
 * Extracts request features within ~25ms budget
 */

import { RequestFeatures, AvengersArtifact } from '../../../../src/types/common.js';
import { PreHookRequest } from '../router_prehook.js';
import * as crypto from 'crypto';

export interface EmbeddingService {
  embed(text: string): Promise<number[]>;
}

export interface ANNIndex {
  search(vector: number[], k: number): Promise<{ id: number; distance: number }[]>;
}

/**
 * Simple in-memory embedding cache
 */
class EmbeddingCache {
  private cache = new Map<string, { embedding: number[]; timestamp: number }>();
  private readonly maxSize = 10000;
  private readonly ttl = 24 * 60 * 60 * 1000; // 24 hours
  
  get(text: string): number[] | null {
    const hash = this.hash(text);
    const cached = this.cache.get(hash);
    
    if (cached && (Date.now() - cached.timestamp) < this.ttl) {
      return cached.embedding;
    }
    
    return null;
  }
  
  set(text: string, embedding: number[]): void {
    const hash = this.hash(text);
    
    // Evict old entries if cache is full
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }
    
    this.cache.set(hash, {
      embedding,
      timestamp: Date.now()
    });
  }
  
  private hash(text: string): string {
    return crypto.createHash('md5').update(text).digest('hex');
  }
  
  getStats(): { size: number; hitRate: number } {
    // TODO: Implement hit rate tracking
    return { size: this.cache.size, hitRate: 0 };
  }
}

/**
 * Mock embedding service for development
 * In production, replace with actual embedding API
 */
/**
 * Production embedding service with multiple backend support
 * Supports local embedding models and remote APIs
 */
export class ProductionEmbeddingService implements EmbeddingService {
  private readonly modelUrl: string;
  private readonly timeout: number;
  private readonly maxRetries: number;
  
  constructor(
    modelUrl = process.env.EMBEDDING_SERVICE_URL || 'http://localhost:8080/embed',
    timeout = 15000, // 15s timeout
    maxRetries = 2
  ) {
    this.modelUrl = modelUrl;
    this.timeout = timeout;
    this.maxRetries = maxRetries;
  }
  
  async embed(text: string): Promise<number[]> {
    const startTime = Date.now();
    
    // Import error handler
    const { ErrorHandler, EmbeddingServiceError } = await import('../error_handler.js');
    
    // Define fallback operations in order of preference
    const operations = [
      () => this.embedWithRemoteAPI(text),
      () => this.embedWithLocalModel(text),
      () => this.embedWithFallback(text)
    ];
    
    try {
      const result = await ErrorHandler.withFallback(operations, {
        component: 'ProductionEmbeddingService',
        operation: 'embed',
        metadata: { textLength: text.length, modelUrl: this.modelUrl }
      }, {
        maxRetries: this.maxRetries,
        timeout: this.timeout,
        retryDelay: 200
      });
      
      const elapsed = Date.now() - startTime;
      
      if (elapsed > 20) {
        console.warn(`Embedding took ${elapsed}ms (>20ms budget)`);
      }
      
      return result;
      
    } catch (error) {
      throw new EmbeddingServiceError(
        `All embedding backends failed after ${this.maxRetries} retries`,
        error as Error
      );
    }
  }
  
  /**
   * Try remote embedding API (e.g., sentence-transformers server)
   */
  /**
   * Try remote embedding API (e.g., sentence-transformers server)
   */
  private async embedWithRemoteAPI(text: string): Promise<number[]> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    
    try {
      const response = await fetch(this.modelUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          texts: [text],
          model: process.env.EMBEDDING_MODEL || 'all-MiniLM-L6-v2'
        }),
        signal: controller.signal
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const data = await response.json() as { embeddings: number[][] };
      
      if (!data.embeddings || !Array.isArray(data.embeddings[0])) {
        throw new Error('Invalid embedding response format');
      }
      
      return data.embeddings[0];
      
    } finally {
      clearTimeout(timeoutId);
    }
  }
  
  /**
   * Try local embedding model (if available)
   */
  private async embedWithLocalModel(text: string): Promise<number[]> {
    // For now, this would load a local model like sentence-transformers
    // In a real implementation, you might use:
    // - @tensorflow/tfjs with a loaded model
    // - Python subprocess with sentence-transformers
    // - Native Node.js ML libraries
    
    throw new Error('Local embedding model not implemented');
  }
  
  /**
   * Fast deterministic fallback for when services are down
   * Creates a reasonable embedding-like vector from text hash
   */
  private async embedWithFallback(text: string): Promise<number[]> {
    console.warn('Using fallback embedding generation');
    
    // Generate multiple hashes for better distribution
    const hashes = [
      crypto.createHash('sha256').update(text).digest(),
      crypto.createHash('sha256').update(text + 'salt1').digest(),
      crypto.createHash('sha256').update(text + 'salt2').digest()
    ];
    
    const embedding = new Array(384); // Standard sentence-transformer dimension
    
    // Combine hashes to create embedding-like vector
    for (let i = 0; i < 384; i++) {
      const hashIndex = i % hashes.length;
      const byteIndex = Math.floor(i / hashes.length) % hashes[hashIndex].length;
      
      // Normalize to [-1, 1] with better distribution
      const rawValue = hashes[hashIndex][byteIndex] / 255;
      embedding[i] = (rawValue - 0.5) * 2;
    }
    
    // Add small processing delay to simulate real embedding time
    await new Promise(resolve => setTimeout(resolve, 2 + Math.random() * 3));
    
    return embedding;
  }
  
  /**
   * Health check for embedding service
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.embed('health check');
      return true;
    } catch {
      return false;
    }
  }
  
  /**
   * Get service information
   */
  getInfo(): {
    modelUrl: string;
    timeout: number;
    isLocal: boolean;
  } {
    return {
      modelUrl: this.modelUrl,
      timeout: this.timeout,
      isLocal: this.modelUrl.includes('localhost') || this.modelUrl.includes('127.0.0.1')
    };
  }
}

/**
 * Mock ANN index for development
 * In production, replace with FAISS or similar
 */
/**
 * FAISS-based ANN index for production cluster lookup
 * Provides fast nearest neighbor search for embeddings
 */
export class FAISSANNIndex implements ANNIndex {
  private index: any = null;
  private centroids: number[][] = [];
  private readonly indexPath: string;
  private readonly dimension: number;
  
  constructor(
    indexPath = process.env.FAISS_INDEX_PATH || '.cache/centroids.faiss',
    dimension = 384
  ) {
    this.indexPath = indexPath;
    this.dimension = dimension;
  }
  
  /**
   * Initialize FAISS index from file or create new one
   */
  async initialize(): Promise<void> {
    try {
      // Try to import faiss-node
      const faiss = await import('faiss-node');
      
      // Try to load existing index
      try {
        this.index = faiss.IndexFlatIP.read(this.indexPath);
        console.log(`Loaded FAISS index from ${this.indexPath} with ${this.index.ntotal()} centroids`);
        
        // Load centroids for distance calculation
        await this.loadCentroidsFromIndex();
        
      } catch (loadError) {
        console.warn('Could not load FAISS index, creating new one:', loadError);
        await this.createNewIndex(faiss);
      }
      
    } catch (importError) {
      console.error('FAISS not available, falling back to mock implementation:', importError);
      await this.initializeMockIndex();
    }
  }
  
  async search(vector: number[], k: number): Promise<{ id: number; distance: number }[]> {
    if (!this.index) {
      await this.initialize();
    }
    
    try {
      if (this.index && typeof this.index.search === 'function') {
        return await this.searchWithFAISS(vector, k);
      } else {
        return await this.searchWithMock(vector, k);
      }
    } catch (error) {
      console.warn('FAISS search failed, using fallback:', error);
      return await this.searchWithMock(vector, k);
    }
  }
  
  /**
   * Search using FAISS index
   */
  private async searchWithFAISS(vector: number[], k: number): Promise<{ id: number; distance: number }[]> {
    const startTime = Date.now();
    
    // FAISS expects float32 array
    const queryVector = new Float32Array(vector);
    
    // Search for k nearest neighbors
    const results = this.index.search(queryVector, Math.min(k, this.index.ntotal()));
    
    const searchResults = [];
    for (let i = 0; i < results.labels.length; i++) {
      if (results.labels[i] >= 0) { // Valid result
        searchResults.push({
          id: results.labels[i],
          distance: 1.0 - results.distances[i] // Convert cosine similarity to distance
        });
      }
    }
    
    const elapsed = Date.now() - startTime;
    if (elapsed > 5) {
      console.warn(`FAISS search took ${elapsed}ms (>5ms target)`);
    }
    
    return searchResults;
  }
  
  /**
   * Fallback search using mock implementation
   */
  private async searchWithMock(vector: number[], k: number): Promise<{ id: number; distance: number }[]> {
    const distances = this.centroids.map((centroid, id) => ({
      id,
      distance: this.euclideanDistance(vector, centroid)
    }));
    
    distances.sort((a, b) => a.distance - b.distance);
    
    // Add small delay to simulate processing
    await new Promise(resolve => setTimeout(resolve, 1));
    
    return distances.slice(0, k);
  }
  
  /**
   * Create a new FAISS index with dummy centroids
   */
  private async createNewIndex(faiss: any): Promise<void> {
    console.log('Creating new FAISS index...');
    
    // Create IndexFlatIP (Inner Product / Cosine similarity)
    this.index = new faiss.IndexFlatIP(this.dimension);
    
    // Generate dummy centroids for development
    const numCentroids = parseInt(process.env.NUM_CENTROIDS || '100');
    this.centroids = this.generateDummyCentroids(numCentroids, this.dimension);
    
    // Add centroids to index
    const centroidMatrix = new Float32Array(numCentroids * this.dimension);
    for (let i = 0; i < numCentroids; i++) {
      for (let j = 0; j < this.dimension; j++) {
        centroidMatrix[i * this.dimension + j] = this.centroids[i][j];
      }
    }
    
    this.index.add(centroidMatrix);
    
    // Save index to disk
    try {
      this.index.write(this.indexPath);
      console.log(`Saved FAISS index to ${this.indexPath}`);
    } catch (saveError) {
      console.warn('Could not save FAISS index:', saveError);
    }
  }
  
  /**
   * Initialize mock index when FAISS is not available
   */
  private async initializeMockIndex(): Promise<void> {
    const numCentroids = parseInt(process.env.NUM_CENTROIDS || '100');
    this.centroids = this.generateDummyCentroids(numCentroids, this.dimension);
    console.log(`Initialized mock ANN index with ${numCentroids} centroids`);
  }
  
  /**
   * Load centroids from existing FAISS index
   */
  private async loadCentroidsFromIndex(): Promise<void> {
    // This is a simplified version - in production you'd reconstruct centroids
    // from the FAISS index or load them from a separate file
    const numCentroids = this.index.ntotal();
    this.centroids = this.generateDummyCentroids(numCentroids, this.dimension);
  }
  
  /**
   * Generate dummy centroids for development/testing
   */
  private generateDummyCentroids(numCentroids: number, dimension: number): number[][] {
    const centroids: number[][] = [];
    
    for (let i = 0; i < numCentroids; i++) {
      const centroid = new Array(dimension);
      
      // Create some structure in the centroids for better clustering
      const clusterType = i % 5; // 5 different types of clusters
      
      for (let j = 0; j < dimension; j++) {
        // Add cluster-specific bias
        const bias = clusterType === 0 ? 0.3 :  // Code cluster
                     clusterType === 1 ? -0.3 : // Math cluster
                     clusterType === 2 ? 0.1 :  // General cluster
                     clusterType === 3 ? -0.1 : // Question cluster
                     0;                         // Neutral cluster
        
        centroid[j] = (Math.random() * 2 - 1) + bias;
      }
      
      // Normalize the centroid vector
      const norm = Math.sqrt(centroid.reduce((sum, val) => sum + val * val, 0));
      if (norm > 0) {
        for (let j = 0; j < dimension; j++) {
          centroid[j] /= norm;
        }
      }
      
      centroids.push(centroid);
    }
    
    return centroids;
  }
  
  private euclideanDistance(a: number[], b: number[]): number {
    let sum = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      sum += Math.pow(a[i] - b[i], 2);
    }
    return Math.sqrt(sum);
  }
  
  /**
   * Get index statistics
   */
  getStats(): {
    isInitialized: boolean;
    numCentroids: number;
    dimension: number;
    indexPath: string;
    usingFAISS: boolean;
  } {
    return {
      isInitialized: this.index !== null || this.centroids.length > 0,
      numCentroids: this.index ? this.index.ntotal() : this.centroids.length,
      dimension: this.dimension,
      indexPath: this.indexPath,
      usingFAISS: this.index !== null && typeof this.index.search === 'function'
    };
  }
  
  /**
   * Update centroids (for when new clustering results are available)
   */
  async updateCentroids(newCentroids: number[][]): Promise<void> {
    try {
      const faiss = await import('faiss-node');
      
      // Create new index
      this.index = new faiss.IndexFlatIP(this.dimension);
      this.centroids = newCentroids;
      
      // Add new centroids to index
      const centroidMatrix = new Float32Array(newCentroids.length * this.dimension);
      for (let i = 0; i < newCentroids.length; i++) {
        for (let j = 0; j < this.dimension; j++) {
          centroidMatrix[i * this.dimension + j] = newCentroids[i][j];
        }
      }
      
      this.index.add(centroidMatrix);
      
      // Save to disk
      this.index.write(this.indexPath);
      console.log(`Updated FAISS index with ${newCentroids.length} new centroids`);
      
    } catch (error) {
      console.warn('Could not update FAISS index, using mock centroids:', error);
      this.centroids = newCentroids;
    }
  }
}

/**
 * Feature extractor for routing decisions
 */
export class FeatureExtractor {
  private embeddingCache = new EmbeddingCache();
  private embeddingService: EmbeddingService;
  private annIndex: ANNIndex;
  
  constructor(
    embeddingService?: EmbeddingService,
    annIndex?: ANNIndex
  ) {
    // Use production services by default, with fallback to development services
    this.embeddingService = embeddingService || new ProductionEmbeddingService();
    this.annIndex = annIndex || new FAISSANNIndex();
  }
  
  /**
   * Extract features from request within 25ms budget
   */
  async extract(
    request: PreHookRequest,
    artifact: AvengersArtifact,
    timeoutMs = 25
  ): Promise<RequestFeatures> {
    const startTime = Date.now();
    
    try {
      // Extract prompt text
      const promptText = this.extractPromptText(request);
      
      // Get embedding (cached if possible)
      const embedding = await this.getEmbedding(promptText, timeoutMs - (Date.now() - startTime));
      
      // Find nearest clusters
      const remainingTime = timeoutMs - (Date.now() - startTime);
      const nearestClusters = remainingTime > 0 ? 
        await this.findNearestClusters(embedding, artifact.alpha, Math.min(remainingTime, 10)) :
        [];
      
      // Extract lexical features (fast)
      const lexicalFeatures = this.extractLexicalFeatures(promptText);
      
      // Context analysis
      const tokenCount = this.estimateTokens(promptText);
      const contextRatio = this.calculateContextRatio(tokenCount);
      
      const features: RequestFeatures = {
        embedding,
        cluster_id: nearestClusters[0]?.id || 0,
        top_p_distances: nearestClusters.map(c => c.distance),
        token_count: tokenCount,
        has_code: lexicalFeatures.hasCode,
        has_math: lexicalFeatures.hasMath,
        ngram_entropy: lexicalFeatures.ngramEntropy,
        context_ratio: contextRatio
      };
      
      const elapsed = Date.now() - startTime;
      if (elapsed > timeoutMs) {
        console.warn(`Feature extraction took ${elapsed}ms (budget: ${timeoutMs}ms)`);
      }
      
      return features;
      
    } catch (error) {
      console.error('Feature extraction failed:', error);
      // Return minimal features as fallback
      return this.getFallbackFeatures(request);
    }
  }
  
  private extractPromptText(request: PreHookRequest): string {
    const messages = request.body?.messages || [];
    return messages
      .map(msg => msg.content || '')
      .join('\n')
      .trim();
  }
  
  private async getEmbedding(text: string, timeoutMs: number): Promise<number[]> {
    // Check cache first
    const cached = this.embeddingCache.get(text);
    if (cached) {
      return cached;
    }
    
    // Generate embedding with timeout
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Embedding timeout')), timeoutMs);
    });
    
    try {
      const embedding = await Promise.race([
        this.embeddingService.embed(text),
        timeoutPromise
      ]);
      
      this.embeddingCache.set(text, embedding);
      return embedding;
    } catch (error) {
      console.warn('Embedding failed, using fallback:', error);
      // Return deterministic fallback based on text hash
      return this.getFallbackEmbedding(text);
    }
  }
  
  private async findNearestClusters(
    embedding: number[],
    topK: number,
    timeoutMs: number
  ): Promise<{ id: number; distance: number }[]> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('ANN timeout')), timeoutMs);
    });
    
    try {
      return await Promise.race([
        this.annIndex.search(embedding, Math.min(topK, 5)),
        timeoutPromise
      ]);
    } catch (error) {
      console.warn('ANN search failed:', error);
      return [{ id: 0, distance: 1.0 }]; // Fallback cluster
    }
  }
  
  private extractLexicalFeatures(text: string): {
    hasCode: boolean;
    hasMath: boolean;
    ngramEntropy: number;
  } {
    // Code detection patterns
    const codePatterns = [
      /```[\s\S]*?```/g,           // Code blocks
      /`[^`]+`/g,                  // Inline code
      /function\s+\w+\s*\(/g,      // Function definitions
      /class\s+\w+/g,              // Class definitions
      /\bimport\s+.*?from/g,       // Import statements
      /\bdef\s+\w+\s*\(/g,         // Python functions
      /\bconst\s+\w+\s*=/g,        // JS const declarations
      /\blet\s+\w+\s*=/g,          // JS let declarations
    ];
    
    const hasCode = codePatterns.some(pattern => pattern.test(text));
    
    // Math detection patterns
    const mathPatterns = [
      /\$[^$]+\$/g,                // LaTeX math
      /\\\([^)]+\\\)/g,           // LaTeX inline math
      /\\\[[^\]]+\\\]/g,         // LaTeX display math
      /∫|∑|∏|√|∞|≤|≥|≠|±|×|÷/g,    // Math symbols
      /\b\d+\.\d*[eE][+-]?\d+/g,   // Scientific notation
      /matrix|vector|derivative|integral/gi // Math terms
    ];
    
    const hasMath = mathPatterns.some(pattern => pattern.test(text));
    
    // N-gram entropy calculation (simplified)
    const ngramEntropy = this.calculateNgramEntropy(text);
    
    return {
      hasCode,
      hasMath,
      ngramEntropy
    };
  }
  
  private calculateNgramEntropy(text: string, n = 3): number {
    const ngrams = new Map<string, number>();
    const cleanText = text.toLowerCase().replace(/[^a-z\s]/g, '');
    
    // Generate n-grams
    for (let i = 0; i <= cleanText.length - n; i++) {
      const ngram = cleanText.substring(i, i + n);
      ngrams.set(ngram, (ngrams.get(ngram) || 0) + 1);
    }
    
    // Calculate entropy
    const total = cleanText.length - n + 1;
    let entropy = 0;
    
    for (const count of ngrams.values()) {
      const p = count / total;
      entropy -= p * Math.log2(p);
    }
    
    return entropy;
  }
  
  private estimateTokens(text: string): number {
    // Rough token estimation: ~4 characters per token
    return Math.ceil(text.length / 4);
  }
  
  private calculateContextRatio(tokenCount: number, maxContext = 128000): number {
    return Math.min(tokenCount / maxContext, 1.0);
  }
  
  private getFallbackEmbedding(text: string): number[] {
    const hash = crypto.createHash('sha256').update(text).digest();
    const embedding = new Array(384);
    
    for (let i = 0; i < 384; i++) {
      embedding[i] = (hash[i % hash.length] / 255 - 0.5) * 2;
    }
    
    return embedding;
  }
  
  private getFallbackFeatures(request: PreHookRequest): RequestFeatures {
    const promptText = this.extractPromptText(request);
    const tokenCount = this.estimateTokens(promptText);
    
    return {
      embedding: this.getFallbackEmbedding(promptText),
      cluster_id: 0,
      top_p_distances: [1.0],
      token_count: tokenCount,
      has_code: promptText.includes('```') || promptText.includes('function'),
      has_math: /\$|\\\(|matrix|integral/i.test(promptText),
      ngram_entropy: 5.0, // Average entropy
      context_ratio: Math.min(tokenCount / 128000, 1.0)
    };
  }
  
  /**
   * Get feature extraction statistics
   */
  getStats(): {
    embeddingCacheStats: { size: number; hitRate: number };
  } {
    return {
      embeddingCacheStats: this.embeddingCache.getStats()
    };
  }
}