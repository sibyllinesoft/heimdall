#!/usr/bin/env python3
"""
GBDT Training Pipeline for Bifrost Router Milestone 3

This module implements the complete LightGBM training pipeline for 3-class bucket triage
(cheap/mid/hard) based on request features from PostHook logs.

Features extracted from PostHook logs:
- Embeddings (768-dim)
- Cluster signals (nearest centroid ID, top-p distances)
- Lexical features (token count, code/math flags, n-gram entropy)
- Context fit (estimated tokens vs model context capacity)
- Historical user success/latency priors

Training target: empirical win-per-$ bucket classification based on actual routing performance.
"""

import asyncio
import json
import logging
import os
import tempfile
import tarfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Any
import warnings

import click
import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.metrics import accuracy_score, classification_report, log_loss
from sklearn.model_selection import StratifiedKFold, cross_val_score
from sklearn.preprocessing import StandardScaler, LabelEncoder
import optuna
import joblib
from tqdm import tqdm

# Suppress LightGBM warnings
warnings.filterwarnings('ignore', category=UserWarning)
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class PostHookLogProcessor:
    """Process PostHook logs to extract features and labels for GBDT training."""
    
    def __init__(self, embedding_dim: int = 768):
        self.embedding_dim = embedding_dim
        self.feature_names = [
            'cluster_id',
            'token_count', 
            'has_code',
            'has_math',
            'ngram_entropy',
            'context_ratio',
            'top_p_distance_0',
            'top_p_distance_1', 
            'top_p_distance_2',
            'user_success_rate',
            'avg_latency'
        ] + [f'embedding_{i}' for i in range(embedding_dim)]
    
    def process_logs(self, log_file_path: str) -> Tuple[pd.DataFrame, np.ndarray]:
        """Process PostHook logs to extract features and labels.
        
        Args:
            log_file_path: Path to PostHook log file (JSON lines format)
            
        Returns:
            Tuple of (features_df, labels_array) where labels are 0=cheap, 1=mid, 2=hard
        """
        logger.info(f"Processing PostHook logs from: {log_file_path}")
        
        # Load log data
        logs = []
        with open(log_file_path, 'r') as f:
            for line in f:
                try:
                    logs.append(json.loads(line.strip()))
                except json.JSONDecodeError as e:
                    logger.warning(f"Skipping malformed log line: {e}")
                    continue
        
        if not logs:
            raise ValueError("No valid log entries found")
            
        logger.info(f"Loaded {len(logs)} log entries")
        
        # Extract features and compute empirical labels
        features_list = []
        labels = []
        
        for log_entry in tqdm(logs, desc="Processing logs"):
            try:
                features = self._extract_features(log_entry)
                label = self._compute_empirical_label(log_entry)
                
                features_list.append(features)
                labels.append(label)
                
            except (KeyError, ValueError) as e:
                logger.warning(f"Skipping log entry due to error: {e}")
                continue
        
        # Convert to DataFrame and numpy array
        features_df = pd.DataFrame(features_list)
        labels_array = np.array(labels, dtype=int)
        
        logger.info(f"Extracted {len(features_df)} training samples")
        logger.info(f"Label distribution: {np.bincount(labels_array)}")
        
        return features_df, labels_array
    
    def _extract_features(self, log_entry: Dict[str, Any]) -> Dict[str, float]:
        """Extract feature vector from a PostHook log entry."""
        features = log_entry.get('features', {})
        decision = log_entry.get('decision', {})
        response = log_entry.get('response', {})
        
        # Core features from request analysis
        feature_dict = {
            'cluster_id': float(features.get('cluster_id', 0)),
            'token_count': float(features.get('token_count', 0)),
            'has_code': float(features.get('has_code', False)),
            'has_math': float(features.get('has_math', False)),
            'ngram_entropy': float(features.get('ngram_entropy', 0)),
            'context_ratio': float(features.get('context_ratio', 0)),
            'user_success_rate': float(features.get('user_success_rate', 0.5)),
            'avg_latency': float(features.get('avg_latency', 1000))
        }
        
        # Top-p distances from ANN search
        top_p_distances = features.get('top_p_distances', [1.0, 1.0, 1.0])
        for i in range(3):
            feature_dict[f'top_p_distance_{i}'] = float(
                top_p_distances[i] if i < len(top_p_distances) else 1.0
            )
        
        # Embeddings - pad or truncate to expected dimension
        embedding = features.get('embedding', [])
        for i in range(self.embedding_dim):
            feature_dict[f'embedding_{i}'] = float(
                embedding[i] if i < len(embedding) else 0.0
            )
        
        return feature_dict
    
    def _compute_empirical_label(self, log_entry: Dict[str, Any]) -> int:
        """Compute empirical bucket label based on actual win-per-$ performance.
        
        Logic:
        - If cost/quality ratio indicates cheap models would have sufficed: label=0 (cheap)
        - If mid-tier quality needed for this task: label=1 (mid)  
        - If high reasoning/quality was truly needed: label=2 (hard)
        
        This is computed by analyzing the actual routing decision, cost, latency,
        and success metrics vs what cheaper alternatives would have achieved.
        """
        decision = log_entry.get('decision', {})
        response = log_entry.get('response', {})
        metrics = log_entry.get('metrics', {})
        
        # Get actual routing bucket and model performance
        actual_model = decision.get('model', '')
        actual_cost = float(response.get('total_cost', 0))
        actual_latency = float(response.get('latency_ms', 1000))
        success = metrics.get('success', False)
        quality_score = float(metrics.get('quality_score', 0.5))  # From judge/eval
        
        # Define cost thresholds (per million tokens) for bucket classification
        # These are based on typical model pricing as of 2024-2025
        cheap_cost_threshold = 0.50   # DeepSeek R1, Qwen3-Coder range
        mid_cost_threshold = 5.0      # Claude 3.5 Sonnet, GPT-4o range
        # hard_cost_threshold = 20.0  # GPT-5 high reasoning, Gemini Pro thinking
        
        # Normalize cost to per-1M-token basis
        token_count = float(log_entry.get('features', {}).get('token_count', 1000))
        cost_per_million = (actual_cost / max(token_count, 1)) * 1_000_000
        
        # Empirical labeling logic based on win-per-$ analysis
        if not success:
            # Failed requests should go to more capable models
            return 2  # hard
        
        elif quality_score < 0.3:
            # Very poor quality - should have used better model
            return 2  # hard
            
        elif quality_score < 0.6 and cost_per_million < cheap_cost_threshold:
            # Low quality from cheap model - needed mid-tier
            return 1  # mid
            
        elif quality_score > 0.8 and cost_per_million > mid_cost_threshold:
            # High quality from expensive model but could have been cheaper
            # Check if task characteristics suggest cheaper would work
            features = log_entry.get('features', {})
            
            # Simple heuristics for task complexity
            has_complex_reasoning = (
                features.get('has_math', False) or
                features.get('ngram_entropy', 0) > 6.0 or
                features.get('token_count', 0) > 20000
            )
            
            if not has_complex_reasoning:
                return 0  # cheap would have sufficed
            else:
                return 1  # mid was appropriate
                
        elif cost_per_million < cheap_cost_threshold:
            # Used cheap model successfully
            return 0  # cheap
            
        elif cost_per_million < mid_cost_threshold:
            # Used mid-tier model
            return 1  # mid
            
        else:
            # Used expensive model (presumably needed)
            return 2  # hard


class GBDTTrainer:
    """LightGBM GBDT trainer with cross-validation and hyperparameter optimization."""
    
    def __init__(self, n_splits: int = 5, random_state: int = 42):
        self.n_splits = n_splits
        self.random_state = random_state
        self.model = None
        self.scaler = StandardScaler()
        self.label_encoder = LabelEncoder()
        
        # Default hyperparameters - will be optimized
        self.default_params = {
            'objective': 'multiclass',
            'num_class': 3,
            'metric': 'multi_logloss',
            'boosting_type': 'gbdt',
            'num_leaves': 31,
            'learning_rate': 0.1,
            'feature_fraction': 0.8,
            'bagging_fraction': 0.8,
            'bagging_freq': 5,
            'verbose': -1,
            'random_state': random_state
        }
    
    def train_with_cv(
        self, 
        X: pd.DataFrame, 
        y: np.ndarray,
        optimize_hyperparams: bool = True,
        n_trials: int = 100
    ) -> Dict[str, Any]:
        """Train GBDT model with cross-validation and optional hyperparameter optimization.
        
        Args:
            X: Feature matrix
            y: Target labels (0=cheap, 1=mid, 2=hard)
            optimize_hyperparams: Whether to run hyperparameter optimization
            n_trials: Number of Optuna trials for hyperparameter search
            
        Returns:
            Training results with metrics and best parameters
        """
        logger.info(f"Training GBDT on {len(X)} samples with {X.shape[1]} features")
        
        # Preprocess features and labels
        X_scaled = self.scaler.fit_transform(X)
        y_encoded = self.label_encoder.fit_transform(y)
        
        # Feature names for model interpretability
        feature_names = list(X.columns)
        
        # Hyperparameter optimization
        best_params = self.default_params.copy()
        if optimize_hyperparams:
            logger.info(f"Running hyperparameter optimization with {n_trials} trials")
            best_params = self._optimize_hyperparameters(X_scaled, y_encoded, n_trials)
        
        # Final model training with cross-validation
        logger.info("Training final model with cross-validation")
        cv_scores, final_model = self._train_final_model(
            X_scaled, y_encoded, best_params, feature_names
        )
        
        self.model = final_model
        
        # Evaluation metrics
        y_pred = self.model.predict(X_scaled, num_iteration=self.model.best_iteration)
        y_pred_proba = self.model.predict(X_scaled, num_iteration=self.model.best_iteration)
        
        # Convert probabilities to class predictions
        y_pred_classes = np.argmax(y_pred_proba, axis=1)
        
        results = {
            'cv_scores': cv_scores,
            'cv_mean': np.mean(cv_scores),
            'cv_std': np.std(cv_scores),
            'test_accuracy': accuracy_score(y_encoded, y_pred_classes),
            'test_logloss': log_loss(y_encoded, y_pred_proba),
            'classification_report': classification_report(
                y_encoded, y_pred_classes, 
                target_names=['cheap', 'mid', 'hard']
            ),
            'best_params': best_params,
            'feature_importance': dict(zip(
                feature_names,
                self.model.feature_importance(importance_type='gain')
            )),
            'n_estimators': self.model.best_iteration
        }
        
        logger.info(f"Training complete. CV Score: {results['cv_mean']:.4f} ± {results['cv_std']:.4f}")
        logger.info(f"Test Accuracy: {results['test_accuracy']:.4f}")
        
        return results
    
    def _optimize_hyperparameters(
        self, 
        X: np.ndarray, 
        y: np.ndarray, 
        n_trials: int
    ) -> Dict[str, Any]:
        """Optimize hyperparameters using Optuna."""
        
        def objective(trial):
            params = {
                'objective': 'multiclass',
                'num_class': 3,
                'metric': 'multi_logloss',
                'boosting_type': 'gbdt',
                'num_leaves': trial.suggest_int('num_leaves', 10, 100),
                'learning_rate': trial.suggest_float('learning_rate', 0.01, 0.3, log=True),
                'feature_fraction': trial.suggest_float('feature_fraction', 0.4, 1.0),
                'bagging_fraction': trial.suggest_float('bagging_fraction', 0.4, 1.0),
                'bagging_freq': trial.suggest_int('bagging_freq', 1, 7),
                'min_child_samples': trial.suggest_int('min_child_samples', 5, 100),
                'reg_alpha': trial.suggest_float('reg_alpha', 0, 10),
                'reg_lambda': trial.suggest_float('reg_lambda', 0, 10),
                'verbose': -1,
                'random_state': self.random_state
            }
            
            # Cross-validation
            cv = StratifiedKFold(n_splits=self.n_splits, shuffle=True, random_state=self.random_state)
            scores = []
            
            for train_idx, val_idx in cv.split(X, y):
                X_train, X_val = X[train_idx], X[val_idx]
                y_train, y_val = y[train_idx], y[val_idx]
                
                train_data = lgb.Dataset(X_train, label=y_train)
                val_data = lgb.Dataset(X_val, label=y_val, reference=train_data)
                
                model = lgb.train(
                    params,
                    train_data,
                    valid_sets=[val_data],
                    num_boost_round=1000,
                    callbacks=[lgb.early_stopping(50), lgb.log_evaluation(0)]
                )
                
                y_pred_proba = model.predict(X_val, num_iteration=model.best_iteration)
                score = log_loss(y_val, y_pred_proba)
                scores.append(score)
            
            return np.mean(scores)
        
        study = optuna.create_study(direction='minimize')
        study.optimize(objective, n_trials=n_trials, show_progress_bar=True)
        
        best_params = self.default_params.copy()
        best_params.update(study.best_params)
        
        logger.info(f"Best hyperparameters found: {study.best_params}")
        logger.info(f"Best CV score: {study.best_value:.4f}")
        
        return best_params
    
    def _train_final_model(
        self,
        X: np.ndarray,
        y: np.ndarray, 
        params: Dict[str, Any],
        feature_names: List[str]
    ) -> Tuple[List[float], lgb.Booster]:
        """Train final model with cross-validation."""
        
        # Cross-validation for model evaluation
        cv = StratifiedKFold(n_splits=self.n_splits, shuffle=True, random_state=self.random_state)
        cv_scores = []
        
        for train_idx, val_idx in cv.split(X, y):
            X_train, X_val = X[train_idx], X[val_idx]
            y_train, y_val = y[train_idx], y[val_idx]
            
            train_data = lgb.Dataset(X_train, label=y_train, feature_name=feature_names)
            val_data = lgb.Dataset(X_val, label=y_val, reference=train_data)
            
            model = lgb.train(
                params,
                train_data,
                valid_sets=[val_data],
                num_boost_round=1000,
                callbacks=[lgb.early_stopping(50), lgb.log_evaluation(0)]
            )
            
            y_pred_proba = model.predict(X_val, num_iteration=model.best_iteration)
            score = log_loss(y_val, y_pred_proba)
            cv_scores.append(score)
        
        # Train final model on full dataset
        full_data = lgb.Dataset(X, label=y, feature_name=feature_names)
        final_model = lgb.train(
            params,
            full_data,
            num_boost_round=1000,
            callbacks=[lgb.log_evaluation(0)]
        )
        
        return cv_scores, final_model
    
    def predict_proba(self, X: pd.DataFrame) -> np.ndarray:
        """Predict bucket probabilities for new samples."""
        if self.model is None:
            raise ValueError("Model not trained yet")
            
        X_scaled = self.scaler.transform(X)
        probabilities = self.model.predict(X_scaled, num_iteration=self.model.best_iteration)
        return probabilities
    
    def save_model(self, model_path: str) -> None:
        """Save trained model and preprocessing components."""
        if self.model is None:
            raise ValueError("Model not trained yet")
            
        # Save model
        self.model.save_model(model_path)
        
        # Save preprocessing components
        preprocessor_path = model_path.replace('.txt', '_preprocessor.pkl')
        joblib.dump({
            'scaler': self.scaler,
            'label_encoder': self.label_encoder,
            'feature_names': self.model.feature_name()
        }, preprocessor_path)
        
        logger.info(f"Model saved to: {model_path}")
        logger.info(f"Preprocessor saved to: {preprocessor_path}")
    
    @classmethod
    def load_model(cls, model_path: str) -> 'GBDTTrainer':
        """Load trained model and preprocessing components."""
        trainer = cls()
        
        # Load model
        trainer.model = lgb.Booster(model_file=model_path)
        
        # Load preprocessing components
        preprocessor_path = model_path.replace('.txt', '_preprocessor.pkl')
        preprocessor_data = joblib.load(preprocessor_path)
        
        trainer.scaler = preprocessor_data['scaler']
        trainer.label_encoder = preprocessor_data['label_encoder']
        
        logger.info(f"Model loaded from: {model_path}")
        
        return trainer


class HyperparameterOptimizer:
    """Optimize α, τ_cheap, τ_hard thresholds using historical routing performance."""
    
    def __init__(self, gbdt_trainer: GBDTTrainer):
        self.gbdt_trainer = gbdt_trainer
        
    def optimize_thresholds(
        self, 
        X_val: pd.DataFrame,
        y_val: np.ndarray,
        historical_performance: Dict[str, float],
        n_trials: int = 200
    ) -> Dict[str, float]:
        """Optimize α, τ_cheap, τ_hard thresholds.
        
        Args:
            X_val: Validation features
            y_val: Validation labels
            historical_performance: Dict with model performance metrics
            n_trials: Number of optimization trials
            
        Returns:
            Optimal parameters: α, τ_cheap, τ_hard
        """
        logger.info("Optimizing α, τ_cheap, τ_hard thresholds")
        
        def objective(trial):
            # Sample parameters
            alpha = trial.suggest_float('alpha', 0.1, 0.9)
            tau_cheap = trial.suggest_float('tau_cheap', 0.3, 0.8) 
            tau_hard = trial.suggest_float('tau_hard', 0.2, 0.7)
            
            # Ensure tau_hard < tau_cheap for logical consistency
            if tau_hard >= tau_cheap:
                return float('inf')
            
            # Get GBDT probabilities
            bucket_probs = self.gbdt_trainer.predict_proba(X_val)
            
            # Apply threshold-based routing decisions
            routing_decisions = []
            for probs in bucket_probs:
                p_cheap, p_mid, p_hard = probs
                
                if p_hard > tau_hard:
                    decision = 2  # hard
                elif p_cheap > tau_cheap:
                    decision = 0  # cheap
                else:
                    decision = 1  # mid
                    
                routing_decisions.append(decision)
            
            # Evaluate routing quality vs actual labels
            routing_decisions = np.array(routing_decisions)
            
            # Calculate win-per-$ metric (higher is better)
            # This is a simplified metric - in production, use actual cost/quality data
            win_per_dollar = self._calculate_win_per_dollar(
                routing_decisions, y_val, alpha, historical_performance
            )
            
            # Return negative for minimization
            return -win_per_dollar
        
        study = optuna.create_study(direction='minimize')
        study.optimize(objective, n_trials=n_trials, show_progress_bar=True)
        
        best_params = {
            'alpha': study.best_params['alpha'],
            'tau_cheap': study.best_params['tau_cheap'],
            'tau_hard': study.best_params['tau_hard']
        }
        
        logger.info(f"Optimal thresholds: {best_params}")
        logger.info(f"Best win-per-$ score: {-study.best_value:.4f}")
        
        return best_params
    
    def _calculate_win_per_dollar(
        self,
        decisions: np.ndarray,
        true_labels: np.ndarray,
        alpha: float,
        performance_data: Dict[str, float]
    ) -> float:
        """Calculate simplified win-per-$ metric for threshold optimization."""
        
        # Model costs (normalized, per million tokens)
        cost_by_bucket = {
            0: 0.08,   # cheap (DeepSeek R1)
            1: 3.50,   # mid (Claude 3.5 Sonnet, GPT-4o)  
            2: 15.00   # hard (GPT-5 high reasoning, Gemini Pro thinking)
        }
        
        # Model quality scores (estimated)
        quality_by_bucket = {
            0: 0.65,   # cheap
            1: 0.82,   # mid
            2: 0.92    # hard
        }
        
        total_score = 0.0
        n_samples = len(decisions)
        
        for decision, true_label in zip(decisions, true_labels):
            predicted_cost = cost_by_bucket[decision]
            predicted_quality = quality_by_bucket[decision]
            
            # Penalty for under-routing (cheap when should be expensive)
            if decision < true_label:
                quality_penalty = (true_label - decision) * 0.2
                predicted_quality -= quality_penalty
            
            # Penalty for over-routing (expensive when cheap would work)
            elif decision > true_label:
                cost_penalty = (decision - true_label) * 2.0
                predicted_cost += cost_penalty
            
            # Win-per-$ calculation: α * quality - (1-α) * normalized_cost
            normalized_cost = predicted_cost / 20.0  # Normalize to [0,1] range
            win_per_dollar = alpha * predicted_quality - (1 - alpha) * normalized_cost
            
            total_score += win_per_dollar
        
        return total_score / n_samples


class ArtifactExporter:
    """Export trained models and parameters in the specified JSON/TAR format."""
    
    def __init__(self, output_dir: str = "./artifacts"):
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(exist_ok=True)
    
    def export_artifact(
        self,
        gbdt_trainer: GBDTTrainer,
        optimal_params: Dict[str, float],
        training_results: Dict[str, Any],
        centroids_path: str,
        qhat_data: Dict[str, List[float]],
        cost_data: Dict[str, float]
    ) -> str:
        """Export complete Avengers artifact in specified JSON/TAR format.
        
        Args:
            gbdt_trainer: Trained GBDT model
            optimal_params: Optimized α, τ_cheap, τ_hard parameters
            training_results: Training metrics and results
            centroids_path: Path to FAISS centroids file
            qhat_data: Quality scores per model per cluster
            cost_data: Normalized cost data per model
            
        Returns:
            Path to exported artifact TAR file
        """
        timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        artifact_name = f"avengers_artifact_{timestamp}"
        
        # Create temporary directory for artifact contents
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            
            # Save GBDT model
            gbdt_model_path = temp_path / "gbdt_model.txt"
            gbdt_trainer.save_model(str(gbdt_model_path))
            
            # Copy centroids file
            centroids_dest = temp_path / "centroids.faiss" 
            if os.path.exists(centroids_path):
                import shutil
                shutil.copy2(centroids_path, centroids_dest)
            else:
                logger.warning(f"Centroids file not found: {centroids_path}")
                # Create dummy centroids file for testing
                with open(centroids_dest, 'wb') as f:
                    f.write(b'dummy_centroids_data')
            
            # Create artifact metadata JSON
            artifact_metadata = {
                "version": timestamp,
                "centroids": "centroids.faiss",
                "alpha": optimal_params.get('alpha', 0.60),
                "thresholds": {
                    "cheap": optimal_params.get('tau_cheap', 0.62),
                    "hard": optimal_params.get('tau_hard', 0.58)
                },
                "penalties": {
                    "latency_sd": 0.05,
                    "ctx_over_80pct": 0.15
                },
                "qhat": qhat_data,
                "chat": cost_data,
                "gbdt": {
                    "framework": "lightgbm",
                    "model_path": "gbdt_model.txt",
                    "preprocessor_path": "gbdt_model_preprocessor.pkl",
                    "feature_schema": {
                        "features": gbdt_trainer.model.feature_name() if gbdt_trainer.model else [],
                        "n_features": len(gbdt_trainer.model.feature_name()) if gbdt_trainer.model else 0
                    }
                },
                "training_metadata": {
                    "timestamp": timestamp,
                    "cv_score": training_results.get('cv_mean', 0),
                    "test_accuracy": training_results.get('test_accuracy', 0),
                    "n_samples": training_results.get('n_samples', 0),
                    "feature_importance": training_results.get('feature_importance', {}),
                    "best_params": training_results.get('best_params', {})
                }
            }
            
            # Save metadata JSON
            metadata_path = temp_path / "metadata.json"
            with open(metadata_path, 'w') as f:
                json.dump(artifact_metadata, f, indent=2)
            
            # Create TAR artifact
            artifact_tar_path = self.output_dir / f"{artifact_name}.tar"
            
            with tarfile.open(artifact_tar_path, 'w') as tar:
                for file_path in temp_path.iterdir():
                    tar.add(file_path, arcname=file_path.name)
            
            logger.info(f"Artifact exported to: {artifact_tar_path}")
            
            return str(artifact_tar_path)


@click.command()
@click.option('--log-file', required=True, help='Path to PostHook logs file')
@click.option('--output-dir', default='./artifacts', help='Output directory for artifacts')
@click.option('--centroids-path', default='./centroids.faiss', help='Path to centroids file')
@click.option('--optimize-hyperparams', is_flag=True, help='Run hyperparameter optimization')
@click.option('--n-trials', default=100, help='Number of optimization trials')
@click.option('--cv-folds', default=5, help='Number of cross-validation folds')
def main(
    log_file: str,
    output_dir: str,
    centroids_path: str,
    optimize_hyperparams: bool,
    n_trials: int,
    cv_folds: int
):
    """Train GBDT model for Bifrost Router bucket triage."""
    
    try:
        # Initialize components
        processor = PostHookLogProcessor()
        trainer = GBDTTrainer(n_splits=cv_folds)
        exporter = ArtifactExporter(output_dir)
        
        # Process logs to extract features and labels
        logger.info("Step 1: Processing PostHook logs...")
        X, y = processor.process_logs(log_file)
        
        # Train GBDT model
        logger.info("Step 2: Training GBDT model...")
        training_results = trainer.train_with_cv(
            X, y, 
            optimize_hyperparams=optimize_hyperparams,
            n_trials=n_trials
        )
        training_results['n_samples'] = len(X)
        
        # Split data for threshold optimization
        from sklearn.model_selection import train_test_split
        X_train, X_val, y_train, y_val = train_test_split(
            X, y, test_size=0.2, random_state=42, stratify=y
        )
        
        # Optimize thresholds
        logger.info("Step 3: Optimizing α, τ_cheap, τ_hard thresholds...")
        optimizer = HyperparameterOptimizer(trainer)
        
        # Mock historical performance data - in production, load from metrics DB
        historical_performance = {
            'deepseek/deepseek-r1': 0.65,
            'qwen/qwen3-coder': 0.63,
            'openai/gpt-5': 0.88,
            'google/gemini-2.5-pro': 0.85,
            'anthropic/claude-3.5-sonnet': 0.82
        }
        
        optimal_params = optimizer.optimize_thresholds(
            X_val, y_val, historical_performance, n_trials=50
        )
        
        # Mock quality and cost data - in production, load from catalog
        qhat_data = {
            "deepseek/deepseek-r1": [0.78, 0.65, 0.72, 0.70, 0.68],
            "qwen/qwen3-coder": [0.75, 0.62, 0.69, 0.68, 0.66],
            "openai/gpt-5": [0.88, 0.94, 0.91, 0.89, 0.92],
            "google/gemini-2.5-pro": [0.85, 0.90, 0.88, 0.87, 0.89],
            "anthropic/claude-3.5-sonnet": [0.82, 0.88, 0.85, 0.84, 0.87]
        }
        
        cost_data = {
            "deepseek/deepseek-r1": 0.08,
            "qwen/qwen3-coder": 0.09,
            "openai/gpt-5": 0.85,
            "google/gemini-2.5-pro": 0.55,
            "anthropic/claude-3.5-sonnet": 0.35
        }
        
        # Export final artifact
        logger.info("Step 4: Exporting artifact...")
        artifact_path = exporter.export_artifact(
            trainer, optimal_params, training_results,
            centroids_path, qhat_data, cost_data
        )
        
        logger.info("=" * 60)
        logger.info("GBDT TRAINING COMPLETE")
        logger.info("=" * 60)
        logger.info(f"Artifact exported to: {artifact_path}")
        logger.info(f"Cross-validation score: {training_results['cv_mean']:.4f} ± {training_results['cv_std']:.4f}")
        logger.info(f"Test accuracy: {training_results['test_accuracy']:.4f}")
        logger.info(f"Optimal parameters: {optimal_params}")
        
        # Print classification report
        print("\nClassification Report:")
        print(training_results['classification_report'])
        
        # Print top feature importance
        print("\nTop 10 Feature Importance:")
        importance_sorted = sorted(
            training_results['feature_importance'].items(),
            key=lambda x: x[1], reverse=True
        )
        for feature, importance in importance_sorted[:10]:
            print(f"  {feature}: {importance:.2f}")
        
    except Exception as e:
        logger.error(f"Training failed: {e}")
        raise


if __name__ == '__main__':
    main()