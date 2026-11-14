from typing import Annotated
from fastapi import APIRouter, Depends, Query, Request, Response
from app.domain.models import Region
from app.schemas.frames import AcceptedSequence, BatchQuery, ErrorResponse, FrameQuery, SequencePage
from app.services.interfaces import Frames

router = APIRouter(prefix="/frames", tags=["frames"])


def get_frames_service(request: Request) -> Frames:
    return request.app.state.frames


@router.post("", response_model=AcceptedSequence, status_code=202,
             responses={422: {"model": ErrorResponse}, 503: {"model": ErrorResponse}})
def start_frames(query: FrameQuery, response: Response,
                 service: Annotated[Frames, Depends(get_frames_service)]):
    result = service.start(Region(query.ra, query.dec, query.fov))
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

    Images are unaligned, per-frame-scaled 8-bit PNGs. Raw pixels, FLAGS,
    VARIANCE, ZODI, PSF/EPSF, spectral lookup tables, full WCS and original
    FITS headers are omitted. Quality flags are not applied; local wavelength
    and coverage remain unknown. See the Frame schema for provider-specific
    retention details. Source archive files are not modified.
    """
    response.headers["Cache-Control"] = "no-store"
    return service.poll(sequence_id, after)


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
