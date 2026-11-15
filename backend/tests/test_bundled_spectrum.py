import json
import random

import pytest

from app.services.bundled_spectrum import restore
from scripts.package_spectrum_cache import package


def bundle(tmp_path):
    source, output = tmp_path / 'source', tmp_path / 'bundle'
    source.mkdir()
    (source / 'dr1-hips_20261026-445-0-4096.range').write_bytes(random.Random(1).randbytes(4096))
    (source / 'dr1-hips_20261026-445.size').write_text('4096')
    package(source, output, part_bytes=512)
    return source, output


def test_split_archive_restores_exact_files_and_is_idempotent(tmp_path):
    source, output = bundle(tmp_path)
    target = tmp_path / 'restored'
    assert len(list(output.glob('*.part*'))) > 1
    assert restore(target, output) == 2
    for path in source.iterdir():
        assert (target / path.name).read_bytes() == path.read_bytes()
    assert restore(target, output) == 0


def test_corrupt_archive_is_rejected_before_extraction(tmp_path):
    _, output = bundle(tmp_path)
    path = sorted(output.glob('*.part*'))[0]
    path.write_bytes(b'corrupt')
    with pytest.raises(ValueError, match='integrity'):
        restore(tmp_path / 'restored', output)


def test_unexpected_manifest_path_cannot_escape_destination(tmp_path):
    _, output = bundle(tmp_path)
    path = output / 'manifest.json'
    manifest = json.loads(path.read_text())
    manifest['files'][0]['name'] = '../outside.range'
    path.write_text(json.dumps(manifest))
    with pytest.raises(ValueError, match='Unexpected'):
        restore(tmp_path / 'restored', output)
    assert not (tmp_path / 'outside.range').exists()
