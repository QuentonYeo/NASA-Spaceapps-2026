from app.services.spectra import Aperture, PixelPosition, SpectrumQuery, SpectrumResponse, sequence_spectrum
from typing import Annotated
from fastapi import APIRouter, Depends, Query, Request, Response
from app.domain.models import Region
from app.schemas.frames import AcceptedSequence, BatchQuery, ErrorResponse, FrameQuery, GaiaCatalogue, SequencePage
from app.services.interfaces import Frames

router = APIRouter(prefix="/frames", tags=["frames"])


def get_frames_service(request: Request) -> Frames:
    return request.app.state.frames


@router.post("", response_model=AcceptedSequence, status_code=202,
             responses={422: {"model": ErrorResponse}, 503: {"model": ErrorResponse}})
def start_frames(query: FrameQuery, response: Response,
                 service: Annotated[Frames, Depends(get_frames_service)]):
    result = service.start(Region(query.ra, query.dec, query.fov),
                           exposure_ids=query.exposureIds, detector=query.detector)
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

    Images are unaligned display previews. Science FITS are retained separately
    within the process-local sequence lifetime and bounded storage budget.
    """
    response.headers["Cache-Control"] = "no-store"
    return service.poll(sequence_id, after)



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


@router.post("/{sequence_id}/spectra", response_model=SpectrumResponse,
             responses={404: {"model": ErrorResponse}, 409: {"model": ErrorResponse},
                        410: {"model": ErrorResponse}, 422: {"model": ErrorResponse}})
def extract_spectrum(sequence_id: str, query: SpectrumQuery, request: Request, response: Response):
    """Explicit region extraction; navigation is independent. Reuses exposure measurements."""
    job = request.app.state.frames.jobs.get(sequence_id)
    result = sequence_spectrum(job, query)
    response.headers["Cache-Control"] = "no-store"
    return result


@router.post("/{sequence_id}/frames/{frame_id:path}/coordinate")
def pixel_coordinate(sequence_id: str, frame_id: str, query: PixelPosition, request: Request):
    import io
    from astropy.io import fits
    from astropy.wcs import WCS
    from app.domain.errors import AppError
    job = request.app.state.frames.jobs.get(sequence_id)
    with job.lock:
        data = job.science.get(frame_id)
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
    with job.lock:
        data = job.science.get(frame_id)
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
