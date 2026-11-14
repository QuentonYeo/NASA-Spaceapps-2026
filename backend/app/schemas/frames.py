from typing import Literal
from pydantic import BaseModel, ConfigDict, Field


class FrameQuery(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    ra: float = Field(ge=0, lt=360, description="ICRS right ascension in degrees")
    dec: float = Field(ge=-90, le=90, description="ICRS declination in degrees")
    fov: float = Field(gt=0, le=1, description="Square cutout side length in degrees")
    exposureIds: list[str] | None = Field(default=None, min_length=1, max_length=12)
    detector: Literal["D1", "D2", "D3", "D4", "D5", "D6"] | None = None


class BatchQuery(BaseModel):
    model_config = ConfigDict(extra="forbid")
    after: int = Field(ge=0, description="scheduledCount returned by polling; repeated offsets do not schedule duplicate downloads.")


class ErrorInfo(BaseModel):
    code: str
    message: str
    retryable: bool
    retryAfterSeconds: int | None = None


class ErrorResponse(BaseModel):
    error: ErrorInfo


class AcceptedSequence(BaseModel):
    sequenceId: str
    status: str
    pollUrl: str
    pollAfterSeconds: int


class Grid(BaseModel):
    width: int
    height: int
    orientation: str


class Display(BaseModel):
    stretch: str
    vmin: float
    vmax: float
    scope: str
    aligned: bool


class Frame(BaseModel):
    """Display preview and selected discovery metadata, not a science FITS product.

    The API omits raw IMAGE values, FLAGS quality masks, VARIANCE uncertainties,
    ZODI background estimates, PSF/EPSF data, WCS-WAVE spectral lookup tables,
    full spatial/spectral WCS, and original FITS headers (including processing
    VERSION and calibration/provenance details beyond the explicit fields).
    PNGs use lossy 8-bit display scaling. Non-finite pixels and known instrument
    artifacts are transparent when quality extensions are present. Previews are
    unsuitable for quantitative comparisons. The optional aligned preview uses a common sky grid.

    Science cutouts are retained separately for the spectra endpoint, subject to
    the process-local sequence lifetime and 128 MiB per-sequence budget.
    """
    scienceStatus: Literal["retained", "retention_limit", "unavailable"] = "unavailable"
    id: str
    visit: int = Field(description="Compatibility alias for observationGroupId: zero-based ten-day-gap heuristic, not a verified orbital pass.")
    observationGroupId: int = Field(default=0, description="Zero-based observation group using a ten-day-gap heuristic; not a verified orbital pass.")
    observedAtUtc: str
    release: str
    detector: str
    wavelengthUm: float | None = Field(description="Local wavelength at the query center in micrometres, when spectral WCS is available.")
    sourceFitsUrl: str = Field(description="Original archive FITS URL retained as provenance; archive access is handled by the backend.")
    previewUrl: str | None
    coverage: float | None = Field(description="Currently null: valid sky coverage and quality-mask coverage are not measured.")
    status: Literal["ready", "failed"]
    imageData: str | None = Field(description="Inline base64 RGBA PNG preview, not calibrated FITS pixels. 8-bit asinh scaling with per-frame limits; non-finite pixels are transparent.")
    sharedImageData: str | None = Field(default=None, description="PNG with fixed contrast for the same detector, release and brightness unit in this sequence.")
    sharedDisplay: Display | None = None
    alignedImageData: str | None = Field(default=None, description="PNG on the shared north-up query grid, using sharedDisplay limits.")
    alignedGrid: Grid | None = None
    grid: Grid | None
    display: Display | None
    error: ErrorInfo | None


class Progress(BaseModel):
    total: int
    ready: int
    failed: int


class SequencePage(BaseModel):
    sequenceId: str
    centerRaDeg: float
    centerDecDeg: float
    fovDeg: float
    grid: Grid | None
    status: Literal["queued", "discovering", "running", "awaiting_more", "completed", "partial", "failed"]
    scheduledCount: int
    remaining: int
    batchSize: int
    nextCursor: int
    hasMore: bool
    pollAfterSeconds: int
    progress: Progress
    frames: list[Frame]
    error: ErrorInfo | None


class GaiaSource(BaseModel):
    sourceId: str
    ra: float
    dec: float
    refEpoch: float
    pmRa: float | None
    pmDec: float | None
    gMagnitude: float


class GaiaCatalogue(BaseModel):
    sources: list[GaiaSource]
    limited: bool
