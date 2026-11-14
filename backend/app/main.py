from contextlib import asynccontextmanager
import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.exception_handlers import register_exception_handlers
from app.routers.frames import router
from app.services.frames import FramesService
from app.services.irsa.discovery import IrsaArchive
from app.services.irsa.cutouts import IrsaCutouts
from app.services.irsa.s3_cutouts import S3Cutouts
from app.services.jobs import LocalJobs
from app.services.rendering import FitsRenderer


def create_app(service=None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app):
        jobs = None
        cutouts = None
        if service is None:
            provider = os.getenv("CUTOUT_PROVIDER", "irsa")
            if provider not in {"irsa", "s3"}:
                raise ValueError("CUTOUT_PROVIDER must be irsa or s3")
            workers = int(os.getenv("CUTOUT_WORKERS", "4"))
            cutouts = (S3Cutouts(connections=2 * workers) if provider == "s3"
                       else IrsaCutouts(connections=2 * workers))
            jobs = LocalJobs(max_jobs=int(os.getenv("MAX_JOBS", "8")),
                             ttl=int(os.getenv("JOB_TTL_SECONDS", "1800")))
            app.state.frames = FramesService(
                IrsaArchive(tuple(os.getenv("IRSA_COLLECTIONS", "spherex_dr1").split(","))),
                cutouts, FitsRenderer(), jobs,
                max_frames=int(os.getenv("MAX_FRAMES", "300")),
                visit_gap_days=float(os.getenv("VISIT_GAP_DAYS", "10")),
                cutout_workers=int(os.getenv("CUTOUT_WORKERS", "4")),
                batch_size=int(os.getenv("FRAME_BATCH_SIZE", "12")))
        else:
            app.state.frames = service
        try:
            yield
        finally:
            if jobs is not None:
                jobs.close()
            if cutouts is not None:
                cutouts.close()

    app = FastAPI(title="SPHEREx Sky Blink", lifespan=lifespan)
    app.add_middleware(CORSMiddleware,
        allow_origins=os.getenv("CORS_ORIGINS", "http://localhost:5173").split(","),
        allow_methods=["GET", "POST"], allow_headers=["Content-Type"],
        expose_headers=["Location", "Retry-After"])
    register_exception_handlers(app)
    app.include_router(router, prefix="/api")
    return app


app = create_app()
