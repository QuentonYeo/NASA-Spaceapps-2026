"""Restore the immutable repository spectrum cache into a writable runtime cache."""
import hashlib
import io
import json
from pathlib import Path
import re
import tarfile
from uuid import uuid4

BUNDLE = Path(__file__).resolve().parents[3] / 'demo' / 'spectrum-cache'


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


class PartReader(io.RawIOBase):
    def __init__(self, paths):
        self.paths = iter(paths)
        self.stream = None

    def readable(self):
        return True

    def readinto(self, buffer):
        view = memoryview(buffer)
        used = 0
        while used < len(view):
            if self.stream is None:
                path = next(self.paths, None)
                if path is None:
                    break
                self.stream = path.open('rb')
            count = self.stream.readinto(view[used:])
            if count:
                used += count
            else:
                self.stream.close()
                self.stream = None
        return used

    def close(self):
        if self.stream is not None:
            self.stream.close()
        super().close()


def restore(destination, bundle=BUNDLE):
    bundle, destination = Path(bundle), Path(destination).resolve()
    manifest_path = bundle / 'manifest.json'
    if not manifest_path.is_file():
        return 0
    signature = digest(manifest_path)
    marker = destination / '.bundled-spectrum-version'
    if marker.is_file() and marker.read_text().strip() == signature:
        return 0
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    if manifest.get('version') != 1:
        raise ValueError('Unsupported bundled spectrum cache version')
    parts = []
    for item in manifest['parts']:
        if not re.fullmatch(r'spectrum-cache\.tar\.gz\.part\d{3}', item['name']):
            raise ValueError('Invalid spectrum cache part name')
        path = bundle / item['name']
        if path.stat().st_size != item['bytes'] or digest(path) != item['sha256']:
            raise ValueError('Bundled spectrum cache part failed integrity check')
        parts.append(path)
    expected = {item['name']: item for item in manifest['files']}
    if len(expected) != len(manifest['files']):
        raise ValueError('Duplicate bundled spectrum cache files')
    destination.mkdir(parents=True, exist_ok=True)
    seen, restored = set(), 0
    with PartReader(parts) as reader, tarfile.open(fileobj=reader, mode='r|gz') as archive:
        for member in archive:
            name = member.name
            if (not member.isfile() or name in seen or name not in expected or
                    not re.fullmatch(r'dr1-hips_\d{8}-(?:Npix)?\d+(?:-\d+-\d+)?\.(?:fits|range|size)', name)):
                raise ValueError('Unexpected bundled spectrum cache member')
            seen.add(name)
            item = expected[name]
            target = (destination / name).resolve()
            if not target.is_relative_to(destination) or member.size != item['bytes']:
                raise ValueError('Invalid spectrum cache destination or size')
            if target.is_file() and target.stat().st_size == member.size and digest(target) == item['sha256']:
                continue
            temporary = destination / f'.{name}.{uuid4().hex}.part'
            try:
                hasher = hashlib.sha256()
                with archive.extractfile(member) as source, temporary.open('wb') as output:
                    while chunk := source.read(1024 * 1024):
                        output.write(chunk)
                        hasher.update(chunk)
                if hasher.hexdigest() != item['sha256']:
                    raise ValueError('Bundled spectrum file failed integrity check')
                temporary.replace(target)
                restored += 1
            finally:
                temporary.unlink(missing_ok=True)
    if seen != set(expected):
        raise ValueError('Incomplete bundled spectrum cache')
    marker.write_text(signature + '\n')
    return restored
