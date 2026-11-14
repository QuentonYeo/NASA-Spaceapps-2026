from typing import Protocol
from app.domain.models import Exposure, Region


class Archive(Protocol):
    def discover(self, region: Region) -> list[Exposure]: ...


class Cutouts(Protocol):
    def fetch(self, exposure: Exposure, region: Region) -> bytes: ...


class Renderer(Protocol):
    def render(self, cutout: bytes) -> dict: ...


class Frames(Protocol):
    def start(self, region: Region) -> dict: ...
    def poll(self, sequence_id: str, after: int) -> dict: ...
    def next_batch(self, sequence_id: str, after: int) -> dict: ...
