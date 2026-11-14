"""Opt-in live smoke check: discovery and exactly one cutout."""
from app.domain.models import Region
from app.services.irsa.discovery import IrsaArchive
from app.services.irsa.cutouts import IrsaCutouts
from app.services.rendering import FitsRenderer


def main():
    region = Region(133.79513, -7.24515, .05)
    frames = IrsaArchive().discover(region)
    print(f"Discovered {len(frames)} archive rows")
    if not frames:
        raise SystemExit("No exposures available for the smoke target")
    preview = FitsRenderer().render(IrsaCutouts().fetch(frames[0], region))
    print(f"Rendered one preview: {preview['grid']}")


if __name__ == "__main__":
    main()
