#!/usr/bin/env python3
"""Validate/extract a static web archive; optionally install with index.html last.

Old hashed assets remain available to browsers opened before deployment. Each file is
replaced atomically, and index.html is switched only after every new asset is present.
"""
import argparse
import os
from pathlib import Path, PurePosixPath
import shutil
import tarfile
import tempfile


def stage(archive, destination):
    destination = Path(destination)
    if destination.exists():
        raise ValueError('staging destination already exists')
    with tarfile.open(archive, 'r:gz') as source:
        members = source.getmembers()
        names = set()
        for member in members:
            path = PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts or '\\' in member.name:
                raise ValueError('unsafe archive path')
            if not (member.isdir() or member.isfile()):
                raise ValueError('archive links and special files are forbidden')
            if member.isfile():
                if str(path) in names:
                    raise ValueError('duplicate archive path')
                names.add(str(path))
        if 'index.html' not in names or not any(n.startswith('assets/') for n in names):
            raise ValueError('web artifact needs index.html and assets')
        destination.mkdir(parents=True)
        for member in members:
            target = destination / member.name
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with source.extractfile(member) as src, target.open('xb') as dst:
                    shutil.copyfileobj(src, dst)
                target.chmod(0o644)


def install(staged, destination):
    staged, destination = Path(staged), Path(destination)
    files = sorted(p for p in staged.rglob('*') if p.is_file())
    index = staged / 'index.html'
    if index not in files:
        raise ValueError('staged index missing')
    files.remove(index)
    files.append(index)
    for source in files:
        relative = source.relative_to(staged)
        target = destination / relative
        # Refuse existing symlink parents or leaves; never follow an unexpected live path.
        if any(p.is_symlink() for p in [target, *target.parents]):
            raise ValueError('symlink in live destination')
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix='.release-', dir=target.parent)
        try:
            with os.fdopen(fd, 'wb') as out, source.open('rb') as src:
                shutil.copyfileobj(src, out)
                out.flush()
                os.fsync(out.fileno())
            os.chmod(temporary, 0o644)
            os.replace(temporary, target)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('archive')
    parser.add_argument('staged')
    parser.add_argument('--install')
    args = parser.parse_args()
    if args.install:
        install(args.staged, args.install)
    else:
        stage(args.archive, args.staged)
