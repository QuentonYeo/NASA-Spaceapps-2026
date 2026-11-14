"""Small opt-in comparison; no notebook dependencies or persistent data cache."""
import argparse
import json
import time
from concurrent.futures import ThreadPoolExecutor
from app.domain.models import Region
from app.services.irsa.discovery import IrsaArchive
from app.services.irsa.cutouts import IrsaCutouts
from app.services.irsa.s3_cutouts import S3Cutouts
from app.services.rendering import FitsRenderer


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--count", type=int, default=4)
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    region = Region(133.79513, -7.24515, .05)
    frames = sorted(IrsaArchive().discover(region), key=lambda f: f.mjd)[:args.count]
    for mode in ("irsa-fresh", "irsa-pooled", "s3"):
        provider = S3Cutouts(connections=args.workers) if mode == "s3" else IrsaCutouts(connections=args.workers)
        def fetch(frame):
            start = time.monotonic()
            own = IrsaCutouts() if mode == "irsa-fresh" else None
            try:
                data = (own or provider).fetch(frame, region)
                preview = FitsRenderer().render(data)
                return {"seconds": round(time.monotonic() - start, 2), "fitsBytes": len(data), "grid": preview["grid"]}
            except Exception as exc:
                return {"seconds": round(time.monotonic() - start, 2), "error": str(exc)}
            finally:
                if own: own.close()
        start = time.monotonic()
        try:
            with ThreadPoolExecutor(max_workers=args.workers) as pool:
                results = list(pool.map(fetch, frames))
            print(json.dumps({"provider": mode, "seconds": round(time.monotonic()-start, 2), "results": results}), flush=True)
        finally:
            provider.close()


if __name__ == "__main__":
    main()
