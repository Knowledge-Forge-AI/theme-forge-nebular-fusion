"""Extract only an exact checksum-bound, manifest-closed input bundle.

No member is executed. Output must be new physical staging. Partial output on
refusal remains held for inspection; the caller must not continue to a build.
"""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import tarfile
import unicodedata

MAX_MEMBERS = 5000
MAX_FILE = 16 * 1024 * 1024
MAX_TOTAL = 64 * 1024 * 1024
MAX_MANIFEST = 2 * 1024 * 1024
MAX_DECODED_TAR = 80 * 1024 * 1024

class BoundedDecodedStream:
    def __init__(self, source):
        self.source = source
        self.total = 0

    def read(self, size=-1):
        remaining = MAX_DECODED_TAR - self.total
        value = self.source.read(min(size if size >= 0 else remaining + 1, remaining + 1))
        self.total += len(value)
        if self.total > MAX_DECODED_TAR:
            refuse("BUNDLE_DECODED_LIMIT")
        return value

def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            refuse("BUNDLE_DUPLICATE_JSON_KEY")
        result[key] = value
    return result

def register_path(name, prefix_names):
    parts = name.split("/")
    for index in range(1, len(parts) + 1):
        spelling = "/".join(parts[:index])
        key = unicodedata.normalize("NFC", spelling).casefold()
        kind = "file" if index == len(parts) else "directory"
        prior = prefix_names.get(key)
        if prior is not None and (prior != (spelling, kind) or kind == "file"):
            refuse("BUNDLE_MEMBER_PATH")
        prefix_names[key] = (spelling, kind)

def refuse(code):
    raise ValueError(code)

def name_ok(name):
    path = PurePosixPath(name)
    return (0 < len(name) <= 1024 and str(path) == name and not path.is_absolute()
            and not any(part in ('..', '.', '') or part.lower() in ('.git', '.serena', 'db', 'raw') for part in path.parts)
            and re.fullmatch(r'[A-Za-z0-9._@+ -]+(?:/[A-Za-z0-9._@+ -]+)*', name) is not None)

def unpack(archive, output, expected_sha256):
    if not re.fullmatch('[a-f0-9]{64}', expected_sha256):
        refuse('BUNDLE_DIGEST_ARGUMENT')
    descriptor = os.open(archive, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_TOTAL:
            refuse('BUNDLE_FILE_SHAPE')
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        if digest != expected_sha256:
            refuse('BUNDLE_DIGEST_MISMATCH')
        stream.seek(0)
        if output.parent.resolve() != output.parent.absolute():
            refuse('BUNDLE_OUTPUT_PARENT')
        try:
            output.mkdir(mode=0o700)
        except FileExistsError:
            refuse("BUNDLE_OUTPUT_EXISTS")
        with gzip.GzipFile(fileobj=stream, mode='rb') as decoded, tarfile.open(fileobj=BoundedDecodedStream(decoded), mode='r|') as tar:
            members = iter(tar)
            first = next(members, None)
            if first is None or first.name != 'bundle-manifest.json' or not first.isfile() or first.size > MAX_MANIFEST:
                refuse('BUNDLE_MANIFEST_REQUIRED')
            manifest_bytes = tar.extractfile(first).read(MAX_MANIFEST + 1)
            if len(manifest_bytes) != first.size:
                refuse('BUNDLE_MANIFEST_SIZE')
            manifest = json.loads(manifest_bytes, object_pairs_hook=unique_object)
            if not isinstance(manifest, dict) or manifest.get('schema') != 'nebular.native-material-input-bundle.v1':
                refuse('BUNDLE_MANIFEST_SCHEMA')
            rows = manifest.get('files')
            if not isinstance(rows, list) or not 1 <= len(rows) < MAX_MEMBERS:
                refuse('BUNDLE_MEMBER_COUNT')
            expected = {}
            prefix_names = {}
            register_path('bundle-manifest.json', prefix_names)
            total = 0
            for row in rows:
                if not isinstance(row, dict) or set(row) != {'path', 'sha256', 'bytes', 'mode'}:
                    refuse('BUNDLE_MEMBER_RECORD')
                name = row['path']
                if not isinstance(name, str) or not name_ok(name) or name == 'bundle-manifest.json':
                    refuse('BUNDLE_MEMBER_PATH')
                if type(row['bytes']) is not int or not 0 <= row['bytes'] <= MAX_FILE or row['mode'] not in ('100644', '100755') or not isinstance(row['sha256'], str) or not re.fullmatch('[a-f0-9]{64}', row['sha256']):
                    refuse('BUNDLE_MEMBER_RECORD')
                register_path(name, prefix_names)
                expected[name] = row
                total += row['bytes']
            if total > MAX_TOTAL:
                refuse('BUNDLE_TOTAL_LIMIT')
            seen = set()
            for member in members:
                if member.name not in expected or member.name in seen or len(seen) >= MAX_MEMBERS:
                    refuse('BUNDLE_UNEXPECTED_MEMBER')
                row = expected[member.name]
                if not member.isfile() or member.issym() or member.islnk() or member.size != row['bytes'] or member.mode != int(row['mode'][-3:], 8):
                    refuse('BUNDLE_MEMBER_SHAPE')
                body = tar.extractfile(member).read(MAX_FILE + 1)
                if len(body) != member.size or hashlib.sha256(body).hexdigest() != row['sha256']:
                    refuse('BUNDLE_MEMBER_DIGEST')
                destination = output / member.name
                destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                leaf = os.open(destination, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
                with os.fdopen(leaf, 'wb') as target:
                    target.write(body)
                    os.fchmod(target.fileno(), member.mode)
                seen.add(member.name)
            if seen != set(expected):
                refuse('BUNDLE_MISSING_MEMBER')
        after = os.fstat(stream.fileno())
        if any(getattr(after, key) != getattr(info, key) for key in ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns')):
            refuse('BUNDLE_INPUT_CHANGED')
    with (output / 'bundle-manifest.json').open('xb') as target:
        target.write(manifest_bytes)
    return {'schema': 'nebular.native-input-extraction.v1', 'status': 'passed-inputs-only',
            'archiveSha256': digest, 'manifestSha256': hashlib.sha256(manifest_bytes).hexdigest(),
            'members': len(seen) + 1, 'bytes': total, 'executedMembers': False, 'nativeBuild': False}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--sha256', required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(unpack(args.archive, args.output, args.sha256)))
    except Exception as error:
        code = str(error) if isinstance(error, ValueError) and re.fullmatch('BUNDLE_[A-Z_]+', str(error)) else 'BUNDLE_EXTRACTION_REFUSED'
        print(json.dumps({'status': 'refused', 'code': code}), file=sys.stderr)
        raise SystemExit(1)

if __name__ == '__main__':
    main()
