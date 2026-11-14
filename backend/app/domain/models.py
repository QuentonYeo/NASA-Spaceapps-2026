from dataclasses import dataclass


@dataclass(frozen=True)
class Region:
    ra: float
    dec: float
    fov: float


@dataclass(frozen=True)
class Exposure:
    id: str
    url: str
    mjd: float
    observed_at: str
    release: str
    detector: str
