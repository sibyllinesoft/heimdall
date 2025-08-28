#!/usr/bin/env python3
"""
LightGBM Prediction Bridge for TypeScript Integration

This script serves as a bridge between TypeScript and Python for GBDT predictions.
It loads a trained LightGBM model and provides predictions via command line interface.

Usage:
    python predict_bridge.py --model-path ./model.txt --features "[0.1,0.2,0.3,...]"
    python predict_bridge.py --model-path ./model.txt --features-file ./features.json
"""

import argparse
import json
import sys
from pathlib import Path
from typing import List, Dict, Any
import warnings

import lightgbm as lgb
import numpy as np
import joblib

warnings.filterwarnings('ignore', category=UserWarning)


class LightGBMPredictor:
    """LightGBM model wrapper for TypeScript bridge."""
    
    def __init__(self, model_path: str):
        self.model_path = model_path
        self.model = None
        self.scaler = None
        self.feature_names = None
        self.load_model()
    
    def load_model(self) -> None:
        """Load LightGBM model and preprocessing components."""
        try:
            # Load the main model
            self.model = lgb.Booster(model_file=self.model_path)
            
            # Load preprocessing components (scaler, feature names)
            preprocessor_path = self.model_path.replace('.txt', '_preprocessor.pkl')
            
            if Path(preprocessor_path).exists():
                preprocessor_data = joblib.load(preprocessor_path)
                self.scaler = preprocessor_data.get('scaler')
                self.feature_names = preprocessor_data.get('feature_names', [])
            else:
                # Fallback - get feature names from model if available
                self.feature_names = self.model.feature_name()
                self.scaler = None
                
        except Exception as e:
            raise RuntimeError(f"Failed to load model from {self.model_path}: {e}")
    
    def predict_proba(self, features: List[float]) -> List[float]:
        """Predict class probabilities for a single sample.
        
        Args:
            features: List of feature values
            
        Returns:
            List of probabilities [p_cheap, p_mid, p_hard]
        """
        if self.model is None:
            raise RuntimeError("Model not loaded")
        
        # Validate feature count
        expected_features = len(self.feature_names) if self.feature_names else len(features)
        
        if len(features) != expected_features:
            raise ValueError(f"Expected {expected_features} features, got {len(features)}")
        
        # Convert to numpy array
        features_array = np.array(features, dtype=np.float32).reshape(1, -1)
        
        # Apply preprocessing if scaler is available
        if self.scaler is not None:
            features_array = self.scaler.transform(features_array)
        
        # Get predictions
        predictions = self.model.predict(features_array, num_iteration=self.model.best_iteration)
        
        # Handle different output formats
        if predictions.ndim == 1:
            # Binary classification - shouldn't happen for 3-class problem
            predictions = predictions.reshape(1, -1)
        
        # Extract probabilities for the single sample
        probabilities = predictions[0].tolist()
        
        # Ensure we have exactly 3 probabilities and they sum to ~1.0
        if len(probabilities) != 3:
            raise RuntimeError(f"Expected 3 class probabilities, got {len(probabilities)}")
        
        # Normalize to ensure they sum to 1.0 (in case of numerical precision issues)
        total = sum(probabilities)
        if total > 0:
            probabilities = [p / total for p in probabilities]
        else:
            # Fallback to uniform distribution
            probabilities = [1/3, 1/3, 1/3]
        
        return probabilities
    
    def predict_batch(self, features_batch: List[List[float]]) -> List[List[float]]:
        """Predict probabilities for multiple samples.
        
        Args:
            features_batch: List of feature vectors
            
        Returns:
            List of probability vectors
        """
        return [self.predict_proba(features) for features in features_batch]
    
    def get_model_info(self) -> Dict[str, Any]:
        """Get information about the loaded model."""
        return {
            'model_path': self.model_path,
            'feature_names': self.feature_names or [],
            'num_features': len(self.feature_names) if self.feature_names else 0,
            'num_classes': 3,
            'has_scaler': self.scaler is not None,
            'best_iteration': getattr(self.model, 'best_iteration', None)
        }


def main():
    """Command line interface for the prediction bridge."""
    parser = argparse.ArgumentParser(description='LightGBM Prediction Bridge')
    parser.add_argument('--model-path', required=True, help='Path to LightGBM model file')
    parser.add_argument('--features', help='JSON string with feature values')
    parser.add_argument('--features-file', help='JSON file with feature values')
    parser.add_argument('--batch', action='store_true', help='Process multiple feature vectors')
    parser.add_argument('--info', action='store_true', help='Print model information and exit')
    
    args = parser.parse_args()
    
    try:
        # Load the predictor
        predictor = LightGBMPredictor(args.model_path)
        
        # Handle info request
        if args.info:
            model_info = predictor.get_model_info()
            print(json.dumps(model_info, indent=2))
            return
        
        # Get features from arguments
        if args.features_file:
            with open(args.features_file, 'r') as f:
                features_data = json.load(f)
        elif args.features:
            features_data = json.loads(args.features)
        else:
            print(json.dumps({'error': 'Must provide --features or --features-file'}))
            sys.exit(1)
        
        # Make predictions
        if args.batch and isinstance(features_data, list) and isinstance(features_data[0], list):
            # Batch prediction
            predictions = predictor.predict_batch(features_data)
            result = {
                'predictions': predictions,
                'batch_size': len(predictions)
            }
        else:
            # Single prediction
            if isinstance(features_data, list) and isinstance(features_data[0], list):
                # If it's a batch but --batch flag not set, use first sample
                features = features_data[0]
            else:
                features = features_data
            
            probabilities = predictor.predict_proba(features)
            result = {
                'probabilities': probabilities,
                'prediction': {
                    'cheap': probabilities[0],
                    'mid': probabilities[1], 
                    'hard': probabilities[2]
                }
            }
        
        # Output results as JSON
        print(json.dumps(result))
        
    except Exception as e:
        error_result = {
            'error': str(e),
            'type': type(e).__name__
        }
        print(json.dumps(error_result))
        sys.exit(1)


if __name__ == '__main__':
    main()