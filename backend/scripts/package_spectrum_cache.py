"""Package existing local FITS/range cache into Git-friendly, checksummed parts."""
import hashlib
import json
from pathlib import Path
import tarfile

ROOT = Path(__file__).resolve().parents[2]


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


class Parts:
    def __init__(self, directory, limit=48 * 1024**2):
        self.directory, self.limit = directory, limit
        self.stream = None
        self.size = 0
        self.paths = []

    def write(self, data):
        original = len(data)
        while data:
            if self.stream is None or self.size == self.limit:
                if self.stream is not None:
                    self.stream.close()
                path = self.directory / f'spectrum-cache.tar.gz.part{len(self.paths) + 1:03}'
                self.paths.append(path)
                self.stream, self.size = path.open('wb'), 0
            length = min(len(data), self.limit - self.size)
            self.stream.write(data[:length])
            self.size += length
            data = data[length:]
        return original

    def close(self):
        if self.stream is not None:
            self.stream.close()


def package(source, output, *, part_bytes=48 * 1024**2):
    output.mkdir(parents=True, exist_ok=True)
    files = sorted(path for path in source.iterdir() if path.suffix in {'.range', '.size', '.fits'})
    manifest = {'version': 1, 'files': [], 'parts': []}
    writer = Parts(output, limit=part_bytes)
    try:
        with tarfile.open(fileobj=writer, mode='w|gz', compresslevel=6) as archive:
            for path in files:
                manifest['files'].append({'name': path.name, 'bytes': path.stat().st_size, 'sha256': digest(path)})
                info = archive.gettarinfo(str(path), arcname=path.name)
                info.mtime = info.uid = info.gid = 0
                info.uname = info.gname = ''
                with path.open('rb') as stream:
                    archive.addfile(info, stream)
    finally:
        writer.close()
    manifest['parts'] = [{'name': path.name, 'bytes': path.stat().st_size, 'sha256': digest(path)} for path in writer.paths]
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    print(f"Packaged {len(files)} files into {len(writer.paths)} parts, {sum(p.stat().st_size for p in writer.paths):,} bytes")


if __name__ == '__main__':
    package(ROOT / 'backend' / '.cache' / 'spherex-cubes', ROOT / 'demo' / 'spectrum-cache')
