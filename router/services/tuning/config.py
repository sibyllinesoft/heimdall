#!/usr/bin/env python3
"""
Configuration management for Tuning Service.
"""

import os
from pathlib import Path
from typing import Dict, Any, Optional
from dataclasses import dataclass, field

from pydantic import BaseModel, Field
import yaml
from dotenv import load_dotenv

# Load environment variables
load_dotenv()


@dataclass
class TrainingConfig:
    """Configuration for GBDT training."""
    default_cv_folds: int = 5
    default_n_trials: int = 100
    default_optimize_hyperparams: bool = True
    max_training_time_hours: int = 24
    embedding_dimension: int = 768
    
    # LightGBM defaults
    lgb_defaults: Dict[str, Any] = field(default_factory=lambda: {
        'objective': 'multiclass',
        'num_class': 3,
        'metric': 'multi_logloss',
        'boosting_type': 'gbdt',
        'num_leaves': 31,
        'learning_rate': 0.1,
        'feature_fraction': 0.8,
        'bagging_fraction': 0.8,
        'bagging_freq': 5,
        'verbose': -1
    })


@dataclass  
class ClusteringConfig:
    """Configuration for k-means clustering."""
    default_k_range_min: int = 3
    default_k_range_max: int = 15
    max_samples_for_optimization: int = 10000
    max_visualization_samples: int = 3000
    
    # Default models to compute Q-hat for
    default_models: list = field(default_factory=lambda: [
        "deepseek/deepseek-r1",
        "qwen/qwen3-coder", 
        "openai/gpt-5",
        "google/gemini-2.5-pro",
        "anthropic/claude-3.5-sonnet"
    ])


@dataclass
class StorageConfig:
    """Configuration for artifact storage."""
    # S3 Configuration
    s3_bucket: str = os.getenv('TUNING_S3_BUCKET', 'llm-router-artifacts')
    s3_region: str = os.getenv('AWS_REGION', 'us-east-1')
    s3_endpoint_url: Optional[str] = os.getenv('S3_ENDPOINT_URL')  # For MinIO/LocalStack
    
    # Local storage fallback
    local_artifacts_dir: str = os.getenv('LOCAL_ARTIFACTS_DIR', './artifacts')
    
    # Artifact retention
    max_artifacts_to_keep: int = int(os.getenv('MAX_ARTIFACTS_TO_KEEP', '10'))


@dataclass
class APIConfig:
    """Configuration for API service."""
    host: str = os.getenv('TUNING_API_HOST', '0.0.0.0')
    port: int = int(os.getenv('TUNING_API_PORT', '8082'))
    
    # API limits
    max_concurrent_jobs: int = int(os.getenv('MAX_CONCURRENT_TRAINING_JOBS', '3'))
    max_upload_size_mb: int = int(os.getenv('MAX_UPLOAD_SIZE_MB', '100'))
    
    # Timeouts
    training_timeout_hours: int = int(os.getenv('TRAINING_TIMEOUT_HOURS', '12'))


@dataclass
class TuningServiceConfig:
    """Main configuration class."""
    training: TrainingConfig = field(default_factory=TrainingConfig)
    clustering: ClusteringConfig = field(default_factory=ClusteringConfig) 
    storage: StorageConfig = field(default_factory=StorageConfig)
    api: APIConfig = field(default_factory=APIConfig)
    
    # Environment
    environment: str = os.getenv('ENVIRONMENT', 'development')
    debug: bool = os.getenv('DEBUG', 'false').lower() == 'true'
    log_level: str = os.getenv('LOG_LEVEL', 'INFO')
    
    @classmethod
    def load_from_file(cls, config_path: str) -> 'TuningServiceConfig':
        """Load configuration from YAML file."""
        config_path = Path(config_path)
        
        if not config_path.exists():
            raise FileNotFoundError(f"Configuration file not found: {config_path}")
        
        with open(config_path, 'r') as f:
            config_data = yaml.safe_load(f)
        
        # Create config instance with defaults, then update from file
        config = cls()
        
        if 'training' in config_data:
            for key, value in config_data['training'].items():
                if hasattr(config.training, key):
                    setattr(config.training, key, value)
        
        if 'clustering' in config_data:
            for key, value in config_data['clustering'].items():
                if hasattr(config.clustering, key):
                    setattr(config.clustering, key, value)
        
        if 'storage' in config_data:
            for key, value in config_data['storage'].items():
                if hasattr(config.storage, key):
                    setattr(config.storage, key, value)
        
        if 'api' in config_data:
            for key, value in config_data['api'].items():
                if hasattr(config.api, key):
                    setattr(config.api, key, value)
        
        # Override with environment variables
        config.environment = os.getenv('ENVIRONMENT', config_data.get('environment', 'development'))
        config.debug = os.getenv('DEBUG', str(config_data.get('debug', False))).lower() == 'true'
        config.log_level = os.getenv('LOG_LEVEL', config_data.get('log_level', 'INFO'))
        
        return config
    
    def save_to_file(self, config_path: str) -> None:
        """Save configuration to YAML file."""
        config_dict = {
            'environment': self.environment,
            'debug': self.debug,
            'log_level': self.log_level,
            'training': {
                'default_cv_folds': self.training.default_cv_folds,
                'default_n_trials': self.training.default_n_trials,
                'default_optimize_hyperparams': self.training.default_optimize_hyperparams,
                'max_training_time_hours': self.training.max_training_time_hours,
                'embedding_dimension': self.training.embedding_dimension,
                'lgb_defaults': self.training.lgb_defaults
            },
            'clustering': {
                'default_k_range_min': self.clustering.default_k_range_min,
                'default_k_range_max': self.clustering.default_k_range_max,
                'max_samples_for_optimization': self.clustering.max_samples_for_optimization,
                'max_visualization_samples': self.clustering.max_visualization_samples,
                'default_models': self.clustering.default_models
            },
            'storage': {
                's3_bucket': self.storage.s3_bucket,
                's3_region': self.storage.s3_region,
                's3_endpoint_url': self.storage.s3_endpoint_url,
                'local_artifacts_dir': self.storage.local_artifacts_dir,
                'max_artifacts_to_keep': self.storage.max_artifacts_to_keep
            },
            'api': {
                'host': self.api.host,
                'port': self.api.port,
                'max_concurrent_jobs': self.api.max_concurrent_jobs,
                'max_upload_size_mb': self.api.max_upload_size_mb,
                'training_timeout_hours': self.api.training_timeout_hours
            }
        }
        
        with open(config_path, 'w') as f:
            yaml.dump(config_dict, f, default_flow_style=False, indent=2)
    
    def validate(self) -> bool:
        """Validate configuration."""
        errors = []
        
        # Validate training config
        if self.training.default_cv_folds < 2:
            errors.append("CV folds must be at least 2")
        
        if self.training.default_n_trials < 1:
            errors.append("Number of trials must be at least 1")
        
        if self.training.embedding_dimension < 1:
            errors.append("Embedding dimension must be positive")
        
        # Validate clustering config
        if self.clustering.default_k_range_min < 2:
            errors.append("Minimum k must be at least 2")
        
        if self.clustering.default_k_range_max <= self.clustering.default_k_range_min:
            errors.append("Maximum k must be greater than minimum k")
        
        if not self.clustering.default_models:
            errors.append("Must specify at least one model for clustering")
        
        # Validate storage config
        if not self.storage.s3_bucket:
            errors.append("S3 bucket name is required")
        
        # Validate API config
        if self.api.port < 1 or self.api.port > 65535:
            errors.append("API port must be between 1 and 65535")
        
        if self.api.max_concurrent_jobs < 1:
            errors.append("Max concurrent jobs must be at least 1")
        
        if errors:
            raise ValueError(f"Configuration validation failed: {'; '.join(errors)}")
        
        return True


# Global configuration instance
_config: Optional[TuningServiceConfig] = None


def get_config() -> TuningServiceConfig:
    """Get global configuration instance."""
    global _config
    
    if _config is None:
        # Try to load from environment-specified config file
        config_file = os.getenv('TUNING_CONFIG_FILE')
        
        if config_file and Path(config_file).exists():
            _config = TuningServiceConfig.load_from_file(config_file)
        else:
            # Use defaults with environment variable overrides
            _config = TuningServiceConfig()
        
        # Validate configuration
        _config.validate()
    
    return _config


def set_config(config: TuningServiceConfig) -> None:
    """Set global configuration instance."""
    global _config
    _config = config
    _config.validate()


# Export commonly used configurations
def get_training_config() -> TrainingConfig:
    """Get training configuration."""
    return get_config().training


def get_clustering_config() -> ClusteringConfig:
    """Get clustering configuration.""" 
    return get_config().clustering


def get_storage_config() -> StorageConfig:
    """Get storage configuration."""
    return get_config().storage


def get_api_config() -> APIConfig:
    """Get API configuration."""
    return get_config().api