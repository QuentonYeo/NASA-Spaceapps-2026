from app.services.native_regions import Aperture, PixelPosition, sky_aperture
from typing import Annotated
from fastapi import APIRouter, Depends, Query, Request, Response
from astropy.wcs import WcsError
from app.domain.models import Region
from app.schemas.frames import AcceptedSequence, BatchQuery, ErrorResponse, FrameQuery, GaiaCatalogue, MotionPhotometryQuery, ObservationAnalysis, SequencePage
from app.services.interfaces import Frames
from app.schemas.fingerprints import AcceptedFingerprint, FingerprintQuery, FingerprintStatus, NativeRegionQuery

router = APIRouter(prefix="/frames", tags=["frames"])


def resolve_native_region(sequence_id: str, query: NativeRegionQuery, request: Request) -> Aperture:
    from app.domain.errors import AppError
    job = request.app.state.frames.jobs.get(sequence_id)
    data = job.science_cutout(query.referenceFrameId)
    if data is None:
        raise AppError("SCIENCE_UNAVAILABLE", "Choose a loaded native image with retained coordinates.", 409)
    try:
        return sky_aperture(data, query.circle)
    except (ValueError, KeyError, OSError, TypeError) as exc:
        raise AppError("INVALID_REFERENCE_REGION", str(exc), 422) from exc


@router.post("/{sequence_id}/sky-region", response_model=Aperture)
def native_sky_region(sequence_id: str, query: NativeRegionQuery, request: Request, response: Response):
    """Convert a circle on a retained native frame into a sky region without starting cube analysis."""
    response.headers["Cache-Control"] = "no-store"
    return resolve_native_region(sequence_id, query, request)


@router.post("/{sequence_id}/fingerprints", status_code=202, response_model=AcceptedFingerprint)
def start_fingerprint(sequence_id: str, query: FingerprintQuery, request: Request, response: Response):
    """Resolve a native FOV circle and asynchronously acquire the separate DR1 cube.

    Stationary-sky quick look only. Combined epochs, no per-channel uncertainty,
    no PSF-matched source photometry, chemical detections, or abundance estimates.
    Native reference coordinates must be retained; aligned-image pixels are not
    accepted as native coordinates. Cube downloads are disk-cached and bounded.
    """
    region = resolve_native_region(sequence_id, query, request)
    response.headers["Cache-Control"] = "no-store"
    return {**request.app.state.fingerprints.start(sequence_id, region, retry=query.retry), "region": region.model_dump()}


@router.get("/{sequence_id}/fingerprints/{analysis_id}", response_model=FingerprintStatus)
def get_fingerprint(sequence_id: str, analysis_id: str, request: Request, response: Response):
    request.app.state.frames.jobs.get(sequence_id)
    response.headers["Cache-Control"] = "no-store"
    return request.app.state.fingerprints.get(analysis_id, sequence_id)


def get_frames_service(request: Request) -> Frames:
    return request.app.state.frames


@router.post("", response_model=AcceptedSequence, status_code=202,
             responses={422: {"model": ErrorResponse}, 503: {"model": ErrorResponse}})
def start_frames(query: FrameQuery, response: Response,
                 service: Annotated[Frames, Depends(get_frames_service)]):
    result = service.start(Region(query.ra, query.dec, query.fov),
                           exposure_ids=query.exposureIds, detector=query.detector, find_movers=query.findMovers, refresh=query.refresh, request_group=query.requestGroup, collections=query.collections)
    response.headers["Location"] = result["pollUrl"]
    response.headers["Cache-Control"] = "no-store"
    return result


@router.get("/{sequence_id}", response_model=SequencePage,
            responses={400: {"model": ErrorResponse}, 404: {"model": ErrorResponse},
                       410: {"model": ErrorResponse}, 422: {"model": ErrorResponse}})
def poll_frames(sequence_id: str, response: Response,
                service: Annotated[Frames, Depends(get_frames_service)],
                after: Annotated[int, Query(ge=0)] = 0):
    """Return new preview frames and progress after a completion-log cursor.

    Images are unaligned display previews. Science FITS are retained separately within the sequence and
    checkpointed to disk subject to the configured storage budgets.
    """
    response.headers["Cache-Control"] = "no-store"
    return service.poll(sequence_id, after)



@router.get("/{sequence_id}/auto-observation", response_model=ObservationAnalysis)
def observation_status(sequence_id: str, response: Response,
                       service: Annotated[Frames, Depends(get_frames_service)]):
    response.headers["Cache-Control"] = "no-store"
    return service.auto_observation(sequence_id)


@router.post("/{sequence_id}/motion-photometry")
def motion_photometry(sequence_id: str, query: MotionPhotometryQuery, request: Request, response: Response):
    """Measure a candidate at its recorded positions in retained native frames."""
    service = request.app.state.frames
    job = service.jobs.get(sequence_id)
    result = service.measure_candidate(job, query.candidateId, query.radiusPixels)
    response.headers["Cache-Control"] = "no-store"
    return result


@router.post("/{sequence_id}/auto-observation", status_code=202, response_model=ObservationAnalysis)
def start_observation(sequence_id: str, response: Response,
                      service: Annotated[Frames, Depends(get_frames_service)], rerun: bool = False):
    response.headers["Cache-Control"] = "no-store"
    return service.auto_observation(sequence_id, start=True, rerun=rerun)


@router.get("/{sequence_id}/light-curve")
def light_curve(sequence_id: str, request: Request, response: Response, outer_wings: bool = False):
    """Measure brightness at the fixed search center using retained native FITS."""
    from app.domain.errors import AppError
    from app.services.light_curve import measure_light_curve

    job = request.app.state.frames.jobs.get(sequence_id)
    if job.status not in {"completed", "partial"}:
        raise AppError("OBSERVATION_NOT_READY", "Wait for the frame downloads to finish.", 409)
    response.headers["Cache-Control"] = "private, max-age=3600"
    return measure_light_curve(job, outer_wings=outer_wings)


@router.get("/{sequence_id}/gaia", response_model=GaiaCatalogue)
def gaia_sources(sequence_id: str, response: Response,
                 service: Annotated[Frames, Depends(get_frames_service)]):
    """Return Gaia DR3 reference sources for the requested sky field."""
    response.headers["Cache-Control"] = "no-store"
    return service.gaia_sources(sequence_id)


@router.post("/{sequence_id}/batches", response_model=AcceptedSequence, status_code=202,
             responses={404: {"model": ErrorResponse}, 409: {"model": ErrorResponse},
                        410: {"model": ErrorResponse}, 422: {"model": ErrorResponse}})
def next_batch(sequence_id: str, query: BatchQuery, response: Response,
               service: Annotated[Frames, Depends(get_frames_service)]):
    """Fetch the next bounded batch; supply scheduledCount as after.

    This offset is distinct from the polling completion cursor. Repeating an
    already scheduled offset does not fetch the same exposures again.
    """
    response.headers["Cache-Control"] = "no-store"
    return service.next_batch(sequence_id, query.after)



@router.get("/{sequence_id}/frames/{frame_id:path}/aligned-auto.png", response_class=Response)
def aligned_auto_preview(sequence_id: str, frame_id: str, request: Request):
    """Render a per-frame preview using the saved science and existing alignment."""
    from app.domain.errors import AppError

    service = request.app.state.frames
    job = service.jobs.get(sequence_id)
    cutout = job.science_cutout(frame_id)
    if cutout is None:
        raise AppError("SCIENCE_UNAVAILABLE", "Science cutout unavailable.", 409)
    image = service.renderer.aligned_auto_png(cutout, job.region)
    if image is None:
        raise AppError("ALIGNMENT_UNAVAILABLE", "Aligned preview unavailable.", 409)
    return Response(image, media_type="image/png", headers={"Cache-Control": "private, max-age=3600"})


@router.post("/{sequence_id}/frames/{frame_id:path}/coordinate")
def pixel_coordinate(sequence_id: str, frame_id: str, query: PixelPosition, request: Request):
    import io
    from astropy.io import fits
    from astropy.wcs import WCS
    from app.domain.errors import AppError
    job = request.app.state.frames.jobs.get(sequence_id)
    data = job.science_cutout(frame_id)
    if data is None:
        raise AppError("SCIENCE_UNAVAILABLE", "Science cutout unavailable.", 409)
    with fits.open(io.BytesIO(data)) as hdus:
        ny, nx = hdus["IMAGE"].data.shape
        if not (0 <= query.x < nx and 0 <= query.y < ny):
            raise AppError("INVALID_PIXEL", "Pixel outside native frame.", 422)
        coord = WCS(hdus["IMAGE"].header).celestial.pixel_to_world(query.x, query.y)
        return {"ra": float(coord.ra.deg), "dec": float(coord.dec.deg)}


@router.post("/{sequence_id}/frames/{frame_id:path}/projection")
def project_region(sequence_id: str, frame_id: str, query: Aperture, request: Request):
    import io
    import numpy as np
    from astropy import units as u
    from astropy.coordinates import SkyCoord
    from astropy.io import fits
    from astropy.wcs import WCS
    from app.domain.errors import AppError
    job = request.app.state.frames.jobs.get(sequence_id)
    data = job.science_cutout(frame_id)
    if data is None:
        raise AppError("SCIENCE_UNAVAILABLE", "Science cutout unavailable.", 409)
    with fits.open(io.BytesIO(data)) as hdus:
        wcs = WCS(hdus["IMAGE"].header).celestial
        center = SkyCoord(query.ra, query.dec, unit="deg")
        rings = []
        for radius in (query.radiusArcsec, query.innerArcsec, query.outerArcsec):
            sky = center.directional_offset_by(np.linspace(0, 360, 97)*u.deg, radius*u.arcsec)
            x, y = wcs.world_to_pixel(sky)
            if not np.isfinite([x, y]).all():
                raise AppError("INVALID_PROJECTION", "Region cannot be projected on this frame.", 422)
            rings.append(np.column_stack((x + .5, y + .5)).tolist())
        return {"rings": rings}
