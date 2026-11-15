from contextlib import asynccontextmanager
import os
from pathlib import Path
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.exception_handlers import register_exception_handlers
from app.routers.frames import router
from app.services.cutout_cache import CutoutCache
from app.services.frames import FramesService
from app.services.irsa.discovery import IrsaArchive
from app.services.irsa.cutouts import IrsaCutouts
from app.services.irsa.s3_cutouts import S3Cutouts
from app.services.jobs import LocalJobs
from app.services.rendering import FitsRenderer
from app.services.search_cache import SearchCache
from app.services.demos import DemoCutouts, DemoStore
from app.services.fingerprints import Fingerprints


def create_app(service=None, fingerprints=None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app):
        app.state.fingerprints = fingerprints or Fingerprints()
        jobs = None
        cutouts = None
        if service is None:
            provider = os.getenv("CUTOUT_PROVIDER", "irsa")
            if provider not in {"irsa", "s3"}:
                raise ValueError("CUTOUT_PROVIDER must be irsa or s3")
            workers = int(os.getenv("CUTOUT_WORKERS", "4"))
            cutouts = (S3Cutouts(connections=2 * workers) if provider == "s3"
                       else IrsaCutouts(connections=2 * workers))
            demo_store = DemoStore()
            cutouts = DemoCutouts(cutouts, demo_store)
            cache = CutoutCache(int(os.getenv("CUTOUT_CACHE_BYTES", str(128 * 1024 * 1024))))
            search_bytes = int(os.getenv("SEARCH_CACHE_BYTES", str(256 * 1024 * 1024)))
            cache_root = Path.home() / ".cache"
            default_search_path = cache_root / "sifting-skies" / "searches-v1.sqlite3"
            legacy_search_path = cache_root / "spherex-sky-blink" / "searches-v1.sqlite3"
            if not default_search_path.exists() and legacy_search_path.is_file():
                default_search_path = legacy_search_path
            search_cache = SearchCache(
                Path(os.getenv("SEARCH_CACHE_PATH", str(default_search_path))),
                search_bytes, int(os.getenv("SEARCH_CACHE_TTL_SECONDS", str(7 * 86400))),
                science_max_bytes=int(os.getenv("SEARCH_SCIENCE_CACHE_BYTES", str(1024 ** 3))),
            ) if search_bytes > 0 else None
            jobs = LocalJobs(max_jobs=int(os.environ["MAX_JOBS"]) if os.getenv("MAX_JOBS") else None,
                             ttl=int(os.getenv("JOB_TTL_SECONDS", "120")), search_cache=search_cache)
            app.state.frames = FramesService(
                IrsaArchive(tuple(os.getenv("IRSA_COLLECTIONS", "spherex_dr1").split(","))),
                cutouts, FitsRenderer(), jobs,
                max_frames=int(os.getenv("MAX_FRAMES", "300")),
                visit_gap_days=float(os.getenv("VISIT_GAP_DAYS", "10")),
                cutout_workers=int(os.getenv("CUTOUT_WORKERS", "4")),
                batch_size=int(os.getenv("FRAME_BATCH_SIZE", "12")),
                cutout_cache=cache,
                max_science_bytes=int(os.getenv("MAX_SCIENCE_BYTES", str(256 * 1024 ** 2))),
                demo_store=demo_store)
        else:
            app.state.frames = service
        try:
            yield
        finally:
            app.state.fingerprints.close()
            if jobs is not None:
                jobs.close()
            if cutouts is not None:
                cutouts.close()

    app = FastAPI(title="Sifting Skies", lifespan=lifespan)
    app.add_middleware(CORSMiddleware,
        allow_origins=os.getenv("CORS_ORIGINS", "http://localhost:5173").split(","),
        allow_methods=["GET", "POST"], allow_headers=["Content-Type"],
        expose_headers=["Location", "Retry-After"])
    register_exception_handlers(app)
    app.include_router(router, prefix="/api")
    return app


app = create_app()
