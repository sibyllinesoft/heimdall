#!/usr/bin/env python3
"""
Clustering Component for Bifrost Router Milestone 3

This module implements k-means clustering on embeddings from PostHook logs
to create centroids for the Avengers-Pro routing system. The clusters are used
for computing per-cluster quality scores (Q̂) and generating ANN indices.

Key functions:
- Process embeddings from PostHook logs
- Fit k-means clusters with optimal number of clusters
- Compute per-cluster quality scores for each model
- Export centroids in FAISS-compatible format
- Generate cluster statistics and validation metrics
"""

import json
import logging
import os
from pathlib import Path
from typing import Dict, List, Tuple, Optional, Any
import warnings

import click
import faiss
import numpy as np
import pandas as pd
from sklearn.cluster import KMeans
from sklearn.metrics import silhouette_score, calinski_harabasz_score
from sklearn.preprocessing import StandardScaler
import joblib
from tqdm import tqdm
import matplotlib.pyplot as plt
import seaborn as sns

warnings.filterwarnings('ignore', category=FutureWarning)
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class EmbeddingClusterAnalyzer:
    """Analyze and cluster embeddings from PostHook logs."""
    
    def __init__(self, embedding_dim: int = 768, random_state: int = 42):
        self.embedding_dim = embedding_dim
        self.random_state = random_state
        self.scaler = StandardScaler()
        self.kmeans = None
        self.embeddings = None
        self.cluster_labels = None
        
    def load_embeddings_from_logs(self, log_file_path: str) -> Tuple[np.ndarray, List[Dict]]:
        """Load embeddings and metadata from PostHook logs.
        
        Args:
            log_file_path: Path to PostHook logs file
            
        Returns:
            Tuple of (embeddings_array, metadata_list)
        """
        logger.info(f"Loading embeddings from: {log_file_path}")
        
        embeddings = []
        metadata = []
        
        with open(log_file_path, 'r') as f:
            for line_num, line in enumerate(tqdm(f, desc="Processing logs")):
                try:
                    log_entry = json.loads(line.strip())
                    features = log_entry.get('features', {})
                    
                    # Extract embedding
                    embedding = features.get('embedding', [])
                    if len(embedding) < self.embedding_dim:
                        # Pad with zeros if embedding is too short
                        embedding.extend([0.0] * (self.embedding_dim - len(embedding)))
                    elif len(embedding) > self.embedding_dim:
                        # Truncate if embedding is too long
                        embedding = embedding[:self.embedding_dim]
                    
                    embeddings.append(embedding)
                    
                    # Extract metadata for quality computation
                    metadata.append({
                        'line_num': line_num,
                        'model': log_entry.get('decision', {}).get('model', ''),
                        'cost': log_entry.get('response', {}).get('total_cost', 0),
                        'latency': log_entry.get('response', {}).get('latency_ms', 1000),
                        'success': log_entry.get('metrics', {}).get('success', False),
                        'quality_score': log_entry.get('metrics', {}).get('quality_score', 0.5),
                        'token_count': features.get('token_count', 0),
                        'has_code': features.get('has_code', False),
                        'has_math': features.get('has_math', False)
                    })
                    
                except (json.JSONDecodeError, KeyError) as e:
                    logger.warning(f"Skipping line {line_num}: {e}")
                    continue
        
        if not embeddings:
            raise ValueError("No valid embeddings found in logs")
        
        embeddings_array = np.array(embeddings, dtype=np.float32)
        
        logger.info(f"Loaded {len(embeddings)} embeddings with dimension {embeddings_array.shape[1]}")
        
        return embeddings_array, metadata
    
    def find_optimal_clusters(
        self, 
        embeddings: np.ndarray, 
        k_range: Tuple[int, int] = (3, 20),
        max_samples: int = 10000
    ) -> int:
        """Find optimal number of clusters using elbow method and silhouette analysis.
        
        Args:
            embeddings: Embedding vectors
            k_range: Range of k values to test
            max_samples: Maximum samples for efficiency
            
        Returns:
            Optimal number of clusters
        """
        logger.info(f"Finding optimal clusters in range {k_range}")
        
        # Sample embeddings for efficiency if dataset is large
        if len(embeddings) > max_samples:
            indices = np.random.choice(len(embeddings), max_samples, replace=False)
            sample_embeddings = embeddings[indices]
            logger.info(f"Using {max_samples} samples for cluster optimization")
        else:
            sample_embeddings = embeddings
        
        # Normalize embeddings
        sample_embeddings = self.scaler.fit_transform(sample_embeddings)
        
        # Test different k values
        k_values = list(range(k_range[0], k_range[1] + 1))
        inertias = []
        silhouette_scores = []
        calinski_scores = []
        
        for k in tqdm(k_values, desc="Testing cluster counts"):
            kmeans = KMeans(n_clusters=k, random_state=self.random_state, n_init=10)
            labels = kmeans.fit_predict(sample_embeddings)
            
            inertias.append(kmeans.inertia_)
            
            # Silhouette score (higher is better)
            if k > 1:
                sil_score = silhouette_score(sample_embeddings, labels)
                silhouette_scores.append(sil_score)
                
                # Calinski-Harabasz score (higher is better)
                ch_score = calinski_harabasz_score(sample_embeddings, labels)
                calinski_scores.append(ch_score)
            else:
                silhouette_scores.append(0)
                calinski_scores.append(0)
        
        # Find elbow point in inertia
        elbow_k = self._find_elbow_point(k_values, inertias)
        
        # Find best silhouette score
        best_sil_idx = np.argmax(silhouette_scores)
        best_sil_k = k_values[best_sil_idx]
        
        # Find best Calinski-Harabasz score
        best_ch_idx = np.argmax(calinski_scores)
        best_ch_k = k_values[best_ch_idx]
        
        logger.info(f"Elbow method suggests k={elbow_k}")
        logger.info(f"Best silhouette score: k={best_sil_k} (score={silhouette_scores[best_sil_idx]:.3f})")
        logger.info(f"Best Calinski-Harabasz score: k={best_ch_k} (score={calinski_scores[best_ch_idx]:.1f})")
        
        # Choose optimal k (weighted decision)
        # Prefer silhouette score but consider elbow method
        if abs(best_sil_k - elbow_k) <= 2:
            optimal_k = best_sil_k
        elif silhouette_scores[best_sil_idx] > 0.3:  # Good silhouette score threshold
            optimal_k = best_sil_k
        else:
            optimal_k = elbow_k
        
        logger.info(f"Selected optimal k={optimal_k}")
        
        # Save clustering analysis plot
        self._plot_cluster_analysis(k_values, inertias, silhouette_scores, calinski_scores, optimal_k)
        
        return optimal_k
    
    def _find_elbow_point(self, k_values: List[int], inertias: List[float]) -> int:
        """Find elbow point using the "elbow method" for k-means."""
        # Calculate second derivative to find elbow
        if len(inertias) < 3:
            return k_values[0]
        
        # Normalize values
        x = np.array(k_values)
        y = np.array(inertias)
        
        # Calculate second derivative approximation
        second_derivs = []
        for i in range(1, len(y) - 1):
            second_deriv = y[i+1] - 2*y[i] + y[i-1]
            second_derivs.append(second_deriv)
        
        if second_derivs:
            elbow_idx = np.argmax(second_derivs) + 1  # +1 because we start from index 1
            return k_values[elbow_idx]
        else:
            return k_values[len(k_values) // 2]  # Fallback to middle value
    
    def _plot_cluster_analysis(
        self, 
        k_values: List[int], 
        inertias: List[float],
        silhouette_scores: List[float], 
        calinski_scores: List[float],
        optimal_k: int
    ):
        """Plot cluster analysis results."""
        fig, ((ax1, ax2), (ax3, ax4)) = plt.subplots(2, 2, figsize=(12, 10))
        
        # Elbow plot
        ax1.plot(k_values, inertias, 'bo-')
        ax1.axvline(x=optimal_k, color='r', linestyle='--', label=f'Optimal k={optimal_k}')
        ax1.set_xlabel('Number of Clusters (k)')
        ax1.set_ylabel('Inertia')
        ax1.set_title('Elbow Method')
        ax1.legend()
        ax1.grid(True, alpha=0.3)
        
        # Silhouette plot
        ax2.plot(k_values, silhouette_scores, 'go-')
        ax2.axvline(x=optimal_k, color='r', linestyle='--', label=f'Optimal k={optimal_k}')
        ax2.set_xlabel('Number of Clusters (k)')
        ax2.set_ylabel('Silhouette Score')
        ax2.set_title('Silhouette Analysis')
        ax2.legend()
        ax2.grid(True, alpha=0.3)
        
        # Calinski-Harabasz plot
        ax3.plot(k_values, calinski_scores, 'mo-')
        ax3.axvline(x=optimal_k, color='r', linestyle='--', label=f'Optimal k={optimal_k}')
        ax3.set_xlabel('Number of Clusters (k)')
        ax3.set_ylabel('Calinski-Harabasz Score')
        ax3.set_title('Calinski-Harabasz Index')
        ax3.legend()
        ax3.grid(True, alpha=0.3)
        
        # Combined normalized scores
        norm_sil = np.array(silhouette_scores) / max(silhouette_scores) if silhouette_scores else [0] * len(k_values)
        norm_ch = np.array(calinski_scores) / max(calinski_scores) if calinski_scores else [0] * len(k_values)
        combined = (norm_sil + norm_ch) / 2
        
        ax4.plot(k_values, combined, 'co-', label='Combined Score')
        ax4.axvline(x=optimal_k, color='r', linestyle='--', label=f'Optimal k={optimal_k}')
        ax4.set_xlabel('Number of Clusters (k)')
        ax4.set_ylabel('Normalized Combined Score')
        ax4.set_title('Combined Clustering Score')
        ax4.legend()
        ax4.grid(True, alpha=0.3)
        
        plt.tight_layout()
        plt.savefig('cluster_analysis.png', dpi=300, bbox_inches='tight')
        logger.info("Cluster analysis plot saved as: cluster_analysis.png")
        plt.close()
    
    def fit_clusters(self, embeddings: np.ndarray, n_clusters: int) -> np.ndarray:
        """Fit k-means clusters on embeddings.
        
        Args:
            embeddings: Embedding vectors
            n_clusters: Number of clusters to create
            
        Returns:
            Cluster labels for each embedding
        """
        logger.info(f"Fitting {n_clusters} clusters on {len(embeddings)} embeddings")
        
        # Normalize embeddings
        embeddings_scaled = self.scaler.fit_transform(embeddings)
        
        # Fit k-means
        self.kmeans = KMeans(
            n_clusters=n_clusters, 
            random_state=self.random_state,
            n_init=20,  # More initializations for better clustering
            max_iter=300
        )
        
        cluster_labels = self.kmeans.fit_predict(embeddings_scaled)
        
        # Store results
        self.embeddings = embeddings_scaled
        self.cluster_labels = cluster_labels
        
        # Calculate clustering quality metrics
        silhouette_avg = silhouette_score(embeddings_scaled, cluster_labels)
        calinski_score = calinski_harabasz_score(embeddings_scaled, cluster_labels)
        
        logger.info(f"Clustering complete:")
        logger.info(f"  Silhouette score: {silhouette_avg:.3f}")
        logger.info(f"  Calinski-Harabasz score: {calinski_score:.1f}")
        logger.info(f"  Inertia: {self.kmeans.inertia_:.1f}")
        
        # Print cluster size distribution
        unique, counts = np.unique(cluster_labels, return_counts=True)
        logger.info("Cluster size distribution:")
        for cluster_id, count in zip(unique, counts):
            logger.info(f"  Cluster {cluster_id}: {count} samples ({count/len(cluster_labels)*100:.1f}%)")
        
        return cluster_labels
    
    def compute_per_cluster_quality_scores(
        self, 
        metadata: List[Dict], 
        cluster_labels: np.ndarray,
        models: List[str]
    ) -> Dict[str, List[float]]:
        """Compute per-cluster quality scores (Q̂) for each model.
        
        Args:
            metadata: List of metadata dicts from PostHook logs
            cluster_labels: Cluster assignment for each sample
            models: List of model names to compute scores for
            
        Returns:
            Dict mapping model names to per-cluster quality scores
        """
        logger.info(f"Computing per-cluster quality scores for {len(models)} models")
        
        n_clusters = len(np.unique(cluster_labels))
        qhat = {model: [0.0] * n_clusters for model in models}
        
        # Group samples by cluster and model
        for cluster_id in range(n_clusters):
            cluster_mask = cluster_labels == cluster_id
            cluster_metadata = [metadata[i] for i in np.where(cluster_mask)[0]]
            
            logger.debug(f"Processing cluster {cluster_id} with {len(cluster_metadata)} samples")
            
            for model in models:
                # Find samples for this model in this cluster
                model_samples = [m for m in cluster_metadata if m['model'] == model]
                
                if not model_samples:
                    # No samples for this model in this cluster - use default score
                    qhat[model][cluster_id] = 0.5
                    continue
                
                # Compute average quality score for this model in this cluster
                quality_scores = [
                    s['quality_score'] for s in model_samples 
                    if s.get('success', False)  # Only consider successful requests
                ]
                
                if quality_scores:
                    avg_quality = np.mean(quality_scores)
                    # Apply success rate penalty
                    success_rate = sum(s.get('success', False) for s in model_samples) / len(model_samples)
                    adjusted_quality = avg_quality * success_rate
                    qhat[model][cluster_id] = max(0.1, min(1.0, adjusted_quality))
                else:
                    # No successful samples - penalize heavily
                    qhat[model][cluster_id] = 0.2
        
        # Log quality score statistics
        for model in models:
            scores = qhat[model]
            logger.info(f"{model}: mean={np.mean(scores):.3f}, std={np.std(scores):.3f}, range=[{min(scores):.3f}, {max(scores):.3f}]")
        
        return qhat
    
    def export_centroids_faiss(self, output_path: str) -> str:
        """Export cluster centroids in FAISS-compatible format.
        
        Args:
            output_path: Path to save FAISS index
            
        Returns:
            Path to saved FAISS index
        """
        if self.kmeans is None:
            raise ValueError("Must fit clusters before exporting centroids")
        
        logger.info(f"Exporting centroids to FAISS format: {output_path}")
        
        # Get centroids (already in scaled space)
        centroids = self.kmeans.cluster_centers_.astype(np.float32)
        
        # Create FAISS index (IndexFlatIP for cosine similarity)
        dimension = centroids.shape[1]
        index = faiss.IndexFlatIP(dimension)
        
        # Normalize centroids for cosine similarity
        faiss.normalize_L2(centroids)
        
        # Add centroids to index
        index.add(centroids)
        
        # Save index
        faiss.write_index(index, output_path)
        
        logger.info(f"Saved {index.ntotal} centroids to FAISS index")
        logger.info(f"Index dimension: {index.d}")
        
        return output_path
    
    def save_clustering_artifacts(self, output_dir: str) -> Dict[str, str]:
        """Save all clustering artifacts (scaler, kmeans model, etc.).
        
        Args:
            output_dir: Directory to save artifacts
            
        Returns:
            Dict mapping artifact names to file paths
        """
        if self.kmeans is None:
            raise ValueError("Must fit clusters before saving artifacts")
        
        output_dir = Path(output_dir)
        output_dir.mkdir(exist_ok=True)
        
        artifacts = {}
        
        # Save scaler
        scaler_path = output_dir / "scaler.pkl"
        joblib.dump(self.scaler, scaler_path)
        artifacts['scaler'] = str(scaler_path)
        
        # Save kmeans model
        kmeans_path = output_dir / "kmeans.pkl"
        joblib.dump(self.kmeans, kmeans_path)
        artifacts['kmeans'] = str(kmeans_path)
        
        # Save cluster labels
        labels_path = output_dir / "cluster_labels.npy"
        np.save(labels_path, self.cluster_labels)
        artifacts['labels'] = str(labels_path)
        
        # Save cluster statistics
        stats = {
            'n_clusters': int(self.kmeans.n_clusters),
            'inertia': float(self.kmeans.inertia_),
            'n_samples': len(self.cluster_labels),
            'cluster_sizes': {
                int(i): int(count) 
                for i, count in zip(*np.unique(self.cluster_labels, return_counts=True))
            }
        }
        
        stats_path = output_dir / "cluster_stats.json"
        with open(stats_path, 'w') as f:
            json.dump(stats, f, indent=2)
        artifacts['stats'] = str(stats_path)
        
        logger.info(f"Saved clustering artifacts to: {output_dir}")
        
        return artifacts
    
    def visualize_clusters(self, metadata: List[Dict], output_path: str = "cluster_visualization.png"):
        """Create 2D visualization of clusters using t-SNE or PCA."""
        if self.embeddings is None or self.cluster_labels is None:
            raise ValueError("Must fit clusters before visualization")
        
        logger.info("Creating cluster visualization...")
        
        try:
            from sklearn.manifold import TSNE
            from sklearn.decomposition import PCA
            
            # Use PCA for speed if large dataset, t-SNE for quality
            if len(self.embeddings) > 5000:
                reducer = PCA(n_components=2, random_state=self.random_state)
                method_name = "PCA"
            else:
                reducer = TSNE(n_components=2, random_state=self.random_state, perplexity=min(30, len(self.embeddings)//4))
                method_name = "t-SNE"
            
            # Sample embeddings if too large
            max_viz_samples = 3000
            if len(self.embeddings) > max_viz_samples:
                indices = np.random.choice(len(self.embeddings), max_viz_samples, replace=False)
                viz_embeddings = self.embeddings[indices]
                viz_labels = self.cluster_labels[indices]
                viz_metadata = [metadata[i] for i in indices]
            else:
                viz_embeddings = self.embeddings
                viz_labels = self.cluster_labels
                viz_metadata = metadata
            
            # Reduce dimensionality
            embeddings_2d = reducer.fit_transform(viz_embeddings)
            
            # Create visualization
            fig, ((ax1, ax2), (ax3, ax4)) = plt.subplots(2, 2, figsize=(15, 12))
            
            # Plot 1: Colored by cluster
            scatter1 = ax1.scatter(embeddings_2d[:, 0], embeddings_2d[:, 1], c=viz_labels, cmap='tab10', alpha=0.6, s=20)
            ax1.set_title(f'Clusters ({method_name})')
            ax1.set_xlabel(f'{method_name} Component 1')
            ax1.set_ylabel(f'{method_name} Component 2')
            plt.colorbar(scatter1, ax=ax1, label='Cluster ID')
            
            # Plot 2: Colored by model type
            model_names = list(set(m['model'] for m in viz_metadata))
            model_colors = {model: i for i, model in enumerate(model_names)}
            model_color_values = [model_colors.get(m['model'], 0) for m in viz_metadata]
            
            scatter2 = ax2.scatter(embeddings_2d[:, 0], embeddings_2d[:, 1], c=model_color_values, cmap='Set3', alpha=0.6, s=20)
            ax2.set_title('Colored by Model')
            ax2.set_xlabel(f'{method_name} Component 1')
            ax2.set_ylabel(f'{method_name} Component 2')
            
            # Plot 3: Colored by quality score
            quality_scores = [m['quality_score'] for m in viz_metadata]
            scatter3 = ax3.scatter(embeddings_2d[:, 0], embeddings_2d[:, 1], c=quality_scores, cmap='viridis', alpha=0.6, s=20)
            ax3.set_title('Colored by Quality Score')
            ax3.set_xlabel(f'{method_name} Component 1')
            ax3.set_ylabel(f'{method_name} Component 2')
            plt.colorbar(scatter3, ax=ax3, label='Quality Score')
            
            # Plot 4: Colored by task type (code vs math vs other)
            task_types = []
            for m in viz_metadata:
                if m['has_code']:
                    task_types.append('Code')
                elif m['has_math']:
                    task_types.append('Math')
                else:
                    task_types.append('Other')
            
            task_type_colors = {'Code': 0, 'Math': 1, 'Other': 2}
            task_color_values = [task_type_colors[t] for t in task_types]
            
            scatter4 = ax4.scatter(embeddings_2d[:, 0], embeddings_2d[:, 1], c=task_color_values, cmap='Set1', alpha=0.6, s=20)
            ax4.set_title('Colored by Task Type')
            ax4.set_xlabel(f'{method_name} Component 1')
            ax4.set_ylabel(f'{method_name} Component 2')
            
            plt.tight_layout()
            plt.savefig(output_path, dpi=300, bbox_inches='tight')
            logger.info(f"Cluster visualization saved as: {output_path}")
            plt.close()
            
        except ImportError:
            logger.warning("scikit-learn visualization libraries not available, skipping cluster visualization")


@click.command()
@click.option('--log-file', required=True, help='Path to PostHook logs file')
@click.option('--output-dir', default='./clustering_artifacts', help='Output directory for clustering artifacts')
@click.option('--faiss-output', default='./centroids.faiss', help='Path to save FAISS index')
@click.option('--n-clusters', default=0, help='Number of clusters (0=auto-detect)')
@click.option('--k-range', default='3,15', help='Range for optimal k detection (format: min,max)')
@click.option('--models', default='deepseek/deepseek-r1,qwen/qwen3-coder,openai/gpt-5,google/gemini-2.5-pro,anthropic/claude-3.5-sonnet', help='Comma-separated list of models')
@click.option('--visualize', is_flag=True, help='Generate cluster visualizations')
def main(
    log_file: str,
    output_dir: str,
    faiss_output: str,
    n_clusters: int,
    k_range: str,
    models: str,
    visualize: bool
):
    """Fit k-means clusters on embeddings from PostHook logs."""
    
    try:
        # Parse inputs
        model_list = [m.strip() for m in models.split(',')]
        k_min, k_max = map(int, k_range.split(','))
        
        # Initialize analyzer
        analyzer = EmbeddingClusterAnalyzer()
        
        # Load embeddings from logs
        logger.info("Step 1: Loading embeddings from PostHook logs...")
        embeddings, metadata = analyzer.load_embeddings_from_logs(log_file)
        
        # Find optimal number of clusters if not specified
        if n_clusters <= 0:
            logger.info("Step 2: Finding optimal number of clusters...")
            n_clusters = analyzer.find_optimal_clusters(embeddings, (k_min, k_max))
        else:
            logger.info(f"Step 2: Using specified number of clusters: {n_clusters}")
        
        # Fit clusters
        logger.info("Step 3: Fitting k-means clusters...")
        cluster_labels = analyzer.fit_clusters(embeddings, n_clusters)
        
        # Compute per-cluster quality scores
        logger.info("Step 4: Computing per-cluster quality scores...")
        qhat_scores = analyzer.compute_per_cluster_quality_scores(
            metadata, cluster_labels, model_list
        )
        
        # Export centroids to FAISS
        logger.info("Step 5: Exporting centroids to FAISS format...")
        analyzer.export_centroids_faiss(faiss_output)
        
        # Save clustering artifacts
        logger.info("Step 6: Saving clustering artifacts...")
        artifacts = analyzer.save_clustering_artifacts(output_dir)
        
        # Generate visualizations
        if visualize:
            logger.info("Step 7: Generating cluster visualizations...")
            analyzer.visualize_clusters(metadata)
        
        # Save quality scores
        qhat_path = Path(output_dir) / "qhat_scores.json"
        with open(qhat_path, 'w') as f:
            json.dump(qhat_scores, f, indent=2)
        
        logger.info("=" * 60)
        logger.info("CLUSTERING COMPLETE")
        logger.info("=" * 60)
        logger.info(f"Number of clusters: {n_clusters}")
        logger.info(f"FAISS centroids: {faiss_output}")
        logger.info(f"Quality scores: {qhat_path}")
        logger.info(f"Artifacts directory: {output_dir}")
        
        # Print quality score summary
        print("\nPer-cluster Quality Scores (Q̂):")
        for model, scores in qhat_scores.items():
            mean_score = np.mean(scores)
            std_score = np.std(scores)
            print(f"  {model}: {mean_score:.3f} ± {std_score:.3f}")
        
    except Exception as e:
        logger.error(f"Clustering failed: {e}")
        raise


if __name__ == '__main__':
    main()