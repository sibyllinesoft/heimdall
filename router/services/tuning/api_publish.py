#!/usr/bin/env python3
"""
Tuning Service API for Bifrost Router Milestone 3

FastAPI service that provides:
1. Training job management and status
2. Artifact publishing and versioning 
3. Model performance monitoring
4. Hyperparameter optimization endpoints

This service coordinates the training pipeline and publishes versioned artifacts
for the TypeScript router to consume.
"""

import asyncio
import json
import logging
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Any
import traceback

import uvicorn
from fastapi import FastAPI, HTTPException, BackgroundTasks, File, UploadFile, Depends
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
import boto3
from botocore.exceptions import ClientError, NoCredentialsError

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


# Pydantic models for API
class TrainingRequest(BaseModel):
    """Request to start GBDT training job."""
    log_file_url: str = Field(..., description="URL to PostHook logs file")
    optimize_hyperparams: bool = Field(True, description="Whether to run hyperparameter optimization")
    n_trials: int = Field(100, description="Number of optimization trials")
    cv_folds: int = Field(5, description="Number of cross-validation folds")
    n_clusters: int = Field(0, description="Number of clusters (0=auto-detect)")
    models: List[str] = Field(
        default=["deepseek/deepseek-r1", "qwen/qwen3-coder", "openai/gpt-5", "google/gemini-2.5-pro", "anthropic/claude-3.5-sonnet"],
        description="List of models to train quality scores for"
    )


class TrainingStatus(BaseModel):
    """Status of training job."""
    job_id: str
    status: str = Field(..., description="pending, running, completed, failed")
    progress: float = Field(default=0.0, description="Progress percentage (0-100)")
    message: str = Field(default="", description="Status message")
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    artifact_url: Optional[str] = None
    error: Optional[str] = None
    results: Optional[Dict[str, Any]] = None


class ArtifactInfo(BaseModel):
    """Information about a trained artifact."""
    version: str
    created_at: datetime
    artifact_url: str
    metadata: Dict[str, Any]
    performance_metrics: Dict[str, float]
    file_size_bytes: int


class HealthCheck(BaseModel):
    """Health check response."""
    status: str = "healthy"
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    version: str = "1.0.0"
    components: Dict[str, str] = Field(default_factory=dict)


class TuningServiceAPI:
    """Main API service for GBDT training and artifact management."""
    
    def __init__(self, artifact_storage_bucket: str = "llm-router-artifacts"):
        self.app = FastAPI(
            title="Bifrost Router Tuning Service",
            description="GBDT training and artifact management for router optimization",
            version="1.0.0"
        )
        
        self.artifact_bucket = artifact_storage_bucket
        self.training_jobs: Dict[str, TrainingStatus] = {}
        
        # Initialize S3 client (optional - can fall back to local storage)
        try:
            self.s3_client = boto3.client('s3')
            self.s3_available = True
        except (NoCredentialsError, Exception) as e:
            logger.warning(f"S3 not available, using local storage: {e}")
            self.s3_client = None
            self.s3_available = False
            
        # Local storage fallback
        self.local_artifacts_dir = Path("./artifacts")
        self.local_artifacts_dir.mkdir(exist_ok=True)
        
        self.setup_routes()
    
    def setup_routes(self):
        """Setup FastAPI routes."""
        
        @self.app.get("/health", response_model=HealthCheck)
        async def health_check():
            """Health check endpoint."""
            components = {
                "s3_storage": "available" if self.s3_available else "local_fallback",
                "training_jobs": f"{len(self.training_jobs)} active",
            }
            return HealthCheck(components=components)
        
        @self.app.post("/v1/training/start", response_model=TrainingStatus)
        async def start_training(
            request: TrainingRequest,
            background_tasks: BackgroundTasks
        ):
            """Start a new GBDT training job."""
            job_id = f"train_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}"
            
            # Create job status
            status = TrainingStatus(
                job_id=job_id,
                status="pending",
                message="Training job queued",
                started_at=datetime.now(timezone.utc)
            )
            
            self.training_jobs[job_id] = status
            
            # Start background training task
            background_tasks.add_task(
                self._run_training_job, job_id, request
            )
            
            logger.info(f"Started training job: {job_id}")
            return status
        
        @self.app.get("/v1/training/{job_id}", response_model=TrainingStatus)
        async def get_training_status(job_id: str):
            """Get status of training job."""
            if job_id not in self.training_jobs:
                raise HTTPException(status_code=404, detail=f"Training job {job_id} not found")
            
            return self.training_jobs[job_id]
        
        @self.app.get("/v1/training", response_model=List[TrainingStatus])
        async def list_training_jobs():
            """List all training jobs."""
            return list(self.training_jobs.values())
        
        @self.app.get("/v1/artifacts/latest", response_model=ArtifactInfo)
        async def get_latest_artifact():
            """Get information about the latest artifact."""
            return await self._get_latest_artifact_info()
        
        @self.app.get("/v1/artifacts", response_model=List[ArtifactInfo])
        async def list_artifacts():
            """List all available artifacts."""
            return await self._list_artifacts()
        
        @self.app.get("/v1/artifacts/{version}/download")
        async def download_artifact(version: str):
            """Download artifact by version."""
            artifact_path = await self._get_artifact_path(version)
            if not artifact_path or not Path(artifact_path).exists():
                raise HTTPException(status_code=404, detail=f"Artifact {version} not found")
            
            return FileResponse(
                path=artifact_path,
                filename=f"avengers_artifact_{version}.tar",
                media_type="application/x-tar"
            )
        
        @self.app.post("/v1/artifacts/{version}/publish")
        async def publish_artifact(
            version: str,
            artifact_file: UploadFile = File(...)
        ):
            """Publish artifact to storage."""
            try:
                # Save uploaded file
                temp_path = f"/tmp/artifact_{version}.tar"
                with open(temp_path, "wb") as buffer:
                    content = await artifact_file.read()
                    buffer.write(content)
                
                # Upload to storage
                storage_path = await self._upload_artifact(temp_path, version)
                
                # Clean up temp file
                os.remove(temp_path)
                
                return {
                    "version": version,
                    "storage_path": storage_path,
                    "status": "published",
                    "timestamp": datetime.now(timezone.utc)
                }
                
            except Exception as e:
                logger.error(f"Failed to publish artifact {version}: {e}")
                raise HTTPException(status_code=500, detail=f"Failed to publish artifact: {e}")
        
        @self.app.delete("/v1/training/{job_id}")
        async def cancel_training_job(job_id: str):
            """Cancel a training job."""
            if job_id not in self.training_jobs:
                raise HTTPException(status_code=404, detail=f"Training job {job_id} not found")
            
            job = self.training_jobs[job_id]
            if job.status in ["completed", "failed"]:
                raise HTTPException(status_code=400, detail=f"Cannot cancel {job.status} job")
            
            job.status = "cancelled"
            job.message = "Training job cancelled by user"
            job.completed_at = datetime.now(timezone.utc)
            
            return {"status": "cancelled", "job_id": job_id}
    
    async def _run_training_job(self, job_id: str, request: TrainingRequest):
        """Run training job in background."""
        job = self.training_jobs[job_id]
        
        try:
            job.status = "running"
            job.progress = 0.0
            job.message = "Downloading logs and initializing..."
            
            # Step 1: Download log file
            job.progress = 10.0
            job.message = "Processing PostHook logs..."
            log_file_path = await self._download_log_file(request.log_file_url)
            
            # Step 2: Run clustering
            job.progress = 30.0  
            job.message = "Fitting clusters on embeddings..."
            clustering_results = await self._run_clustering(
                log_file_path, request.n_clusters, request.models
            )
            
            # Step 3: Train GBDT
            job.progress = 60.0
            job.message = "Training GBDT model with cross-validation..."
            training_results = await self._run_gbdt_training(
                log_file_path, request.optimize_hyperparams, request.n_trials, request.cv_folds
            )
            
            # Step 4: Optimize thresholds
            job.progress = 80.0
            job.message = "Optimizing α, τ_cheap, τ_hard thresholds..."
            optimization_results = await self._run_threshold_optimization()
            
            # Step 5: Export artifact
            job.progress = 95.0
            job.message = "Exporting final artifact..."
            artifact_path = await self._export_final_artifact(
                training_results, clustering_results, optimization_results
            )
            
            # Step 6: Upload to storage
            job.progress = 100.0
            job.message = "Publishing artifact to storage..."
            
            version = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            artifact_url = await self._upload_artifact(artifact_path, version)
            
            # Complete job
            job.status = "completed"
            job.progress = 100.0
            job.message = "Training completed successfully"
            job.completed_at = datetime.now(timezone.utc)
            job.artifact_url = artifact_url
            job.results = {
                "cv_score": training_results.get("cv_mean", 0),
                "test_accuracy": training_results.get("test_accuracy", 0),
                "n_clusters": clustering_results.get("n_clusters", 0),
                "optimal_alpha": optimization_results.get("alpha", 0.6),
                "artifact_version": version
            }
            
            logger.info(f"Training job {job_id} completed successfully")
            
        except Exception as e:
            logger.error(f"Training job {job_id} failed: {e}")
            logger.error(traceback.format_exc())
            
            job.status = "failed"
            job.error = str(e)
            job.message = f"Training failed: {e}"
            job.completed_at = datetime.now(timezone.utc)
    
    async def _download_log_file(self, log_url: str) -> str:
        """Download log file from URL."""
        # For now, assume log_url is a local path
        # In production, implement HTTP/S3 download
        if os.path.exists(log_url):
            return log_url
        else:
            raise FileNotFoundError(f"Log file not found: {log_url}")
    
    async def _run_clustering(
        self, 
        log_file_path: str, 
        n_clusters: int, 
        models: List[str]
    ) -> Dict[str, Any]:
        """Run clustering subprocess."""
        # Run the clustering script
        cmd = [
            "python", "fit_clusters.py",
            "--log-file", log_file_path,
            "--output-dir", "./clustering_artifacts",
            "--faiss-output", "./centroids.faiss",
            "--models", ",".join(models)
        ]
        
        if n_clusters > 0:
            cmd.extend(["--n-clusters", str(n_clusters)])
        
        # In production, use subprocess to run the clustering script
        # For now, return mock results
        return {
            "n_clusters": n_clusters or 5,
            "centroids_path": "./centroids.faiss",
            "qhat_scores": {model: [0.7, 0.8, 0.75, 0.72, 0.78] for model in models}
        }
    
    async def _run_gbdt_training(
        self,
        log_file_path: str,
        optimize_hyperparams: bool,
        n_trials: int, 
        cv_folds: int
    ) -> Dict[str, Any]:
        """Run GBDT training subprocess."""
        # Run the training script  
        cmd = [
            "python", "train_gbdt.py",
            "--log-file", log_file_path,
            "--output-dir", "./artifacts",
            "--cv-folds", str(cv_folds),
            "--n-trials", str(n_trials)
        ]
        
        if optimize_hyperparams:
            cmd.append("--optimize-hyperparams")
        
        # In production, use subprocess to run the training script
        # For now, return mock results
        return {
            "cv_mean": 0.82,
            "cv_std": 0.03,
            "test_accuracy": 0.85,
            "n_samples": 10000,
            "best_params": {
                "num_leaves": 31,
                "learning_rate": 0.1,
                "feature_fraction": 0.8
            }
        }
    
    async def _run_threshold_optimization(self) -> Dict[str, float]:
        """Run threshold optimization."""
        # In production, this would optimize on validation data
        # For now, return reasonable defaults
        return {
            "alpha": 0.62,
            "tau_cheap": 0.65,
            "tau_hard": 0.55
        }
    
    async def _export_final_artifact(
        self,
        training_results: Dict[str, Any],
        clustering_results: Dict[str, Any], 
        optimization_results: Dict[str, float]
    ) -> str:
        """Export final artifact TAR file."""
        # Create artifact using the training results
        # For now, return a mock path
        artifact_path = "./artifacts/mock_artifact.tar"
        
        # In production, this would use the ArtifactExporter from train_gbdt.py
        # to create the actual TAR file with all components
        
        return artifact_path
    
    async def _upload_artifact(self, local_path: str, version: str) -> str:
        """Upload artifact to storage (S3 or local)."""
        if self.s3_available:
            try:
                # Upload to S3
                s3_key = f"artifacts/avengers_artifact_{version}.tar"
                self.s3_client.upload_file(local_path, self.artifact_bucket, s3_key)
                artifact_url = f"s3://{self.artifact_bucket}/{s3_key}"
                logger.info(f"Uploaded artifact to S3: {artifact_url}")
                return artifact_url
            except Exception as e:
                logger.error(f"S3 upload failed, falling back to local storage: {e}")
        
        # Fallback to local storage
        local_artifact_path = self.local_artifacts_dir / f"avengers_artifact_{version}.tar"
        
        if local_path != str(local_artifact_path):
            import shutil
            shutil.copy2(local_path, local_artifact_path)
        
        logger.info(f"Stored artifact locally: {local_artifact_path}")
        return f"file://{local_artifact_path.absolute()}"
    
    async def _get_latest_artifact_info(self) -> ArtifactInfo:
        """Get information about latest artifact."""
        # Mock implementation - in production, query storage
        return ArtifactInfo(
            version="2025-08-27T12:00:00Z",
            created_at=datetime.now(timezone.utc),
            artifact_url="file://./artifacts/latest.tar",
            metadata={
                "alpha": 0.62,
                "n_clusters": 5,
                "models_trained": 5
            },
            performance_metrics={
                "cv_score": 0.82,
                "test_accuracy": 0.85
            },
            file_size_bytes=1024000
        )
    
    async def _list_artifacts(self) -> List[ArtifactInfo]:
        """List all available artifacts."""
        # Mock implementation - in production, query storage
        return [await self._get_latest_artifact_info()]
    
    async def _get_artifact_path(self, version: str) -> Optional[str]:
        """Get local path to artifact by version."""
        local_path = self.local_artifacts_dir / f"avengers_artifact_{version}.tar"
        return str(local_path) if local_path.exists() else None
    
    def run(self, host: str = "0.0.0.0", port: int = 8082):
        """Run the API service."""
        uvicorn.run(
            self.app,
            host=host,
            port=port,
            log_level="info",
            access_log=True
        )


# CLI entry point
if __name__ == "__main__":
    import click
    
    @click.command()
    @click.option('--host', default='0.0.0.0', help='Host to bind to')
    @click.option('--port', default=8082, help='Port to bind to') 
    @click.option('--bucket', default='llm-router-artifacts', help='S3 bucket for artifacts')
    def main(host: str, port: int, bucket: str):
        """Start the Tuning Service API."""
        logger.info(f"Starting Tuning Service API on {host}:{port}")
        logger.info(f"Using artifact bucket: {bucket}")
        
        service = TuningServiceAPI(artifact_storage_bucket=bucket)
        service.run(host=host, port=port)
    
    main()