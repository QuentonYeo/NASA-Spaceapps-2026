"""Public quick-look cube contract; no detection confidence or fabricated errors."""
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field
from app.services.native_regions import Aperture, NativeCircle


class FingerprintQuery(BaseModel):
    model_config = ConfigDict(extra="forbid")
    referenceFrameId: str = Field(min_length=1, max_length=2048)
    circle: NativeCircle
    retry: bool = False


class FingerprintIdentity(BaseModel):
    analysisId: str
    status: Literal["loading", "ready", "failed"]


class AcceptedFingerprint(FingerprintIdentity):
    region: Aperture


class CubeChannel(BaseModel):
    channel: int = Field(ge=1, le=102)
    detector: int
    subchannel: int
    wavelengthUm: float
    minUm: float
    maxUm: float
    value: float | None = Field(description="Background-subtracted fractional aperture flux density in mJy; null is missing, never zero.")
    uncertainty: None = Field(description="This cube provides no variance plane; NHITS is not an uncertainty.")
    apertureFluxMjy: float | None
    backgroundFluxMjy: float | None
    backgroundMeanMJySr: float | None
    apertureAreaPixels: float
    backgroundPixels: int
    backgroundCoverage: float = Field(ge=0, le=1)
    pixels: int
    coveredPixels: int
    coverage: float = Field(ge=0, le=1, description="Accepted fractional aperture solid-angle fraction, not S/N.")
    flagsOr: int
    reason: str


class CubeProvenance(BaseModel):
    tile: int
    url: str
    diskCacheHit: bool


class ReferencePosition(BaseModel):
    name: str
    wavelengthUm: float
    sourceUrl: str
    status: Literal["reference-only"]


class FingerprintResult(BaseModel):
    region: Aperture
    channels: list[CubeChannel] = Field(min_length=102, max_length=102)
    usableChannels: int
    totalChannels: Literal[102]
    unit: Literal["mJy"]
    processingVersion: str
    product: str
    provenance: list[CubeProvenance]
    references: list[ReferencePosition]
    limitations: list[str]
    qualityPolicy: str
    combinedEpochs: Literal[True]
    uncertaintyAvailable: Literal[False]
    elapsedSeconds: float


class FingerprintStatus(FingerprintIdentity):
    message: str
    downloadedBytes: int | None
    totalBytes: int | None
    result: FingerprintResult | None
    error: str | None
