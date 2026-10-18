import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('release', Path(__file__).resolve().parents[2] / 'ops/stage-web-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

class WebReleaseTest(unittest.TestCase):
    def test_install_keeps_old_assets_and_switches_index_last(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root); archive = root / 'web.tar.gz'
            with tarfile.open(archive, 'w:gz') as out:
                for name, data in [('index.html', b'new'), ('assets/new.js', b'new JS')]:
                    entry = tarfile.TarInfo(name); entry.size = len(data); out.addfile(entry, io.BytesIO(data))
            staged = root / 'stage'; live = root / 'live'; (live / 'assets').mkdir(parents=True)
            (live / 'assets/old.js').write_text('old JS'); (live / 'index.html').write_text('old')
            release.stage(archive, staged)
            replaced = []; original = release.os.replace
            def replace(source, destination):
                replaced.append(Path(destination).relative_to(live).as_posix()); original(source, destination)
            with patch.object(release.os, 'replace', replace): release.install(staged, live)
            self.assertEqual(replaced, ['assets/new.js', 'index.html'])
            self.assertEqual((live/'assets/old.js').read_text(), 'old JS')
            self.assertEqual((live/'index.html').read_text(), 'new')
            with self.assertRaises(ValueError): release.stage(archive, staged)

    def test_unsafe_archives_never_create_staging(self):
        for name, kind in [('../outside', tarfile.REGTYPE),('/absolute',tarfile.REGTYPE),('link',tarfile.SYMTYPE),('hard',tarfile.LNKTYPE)]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as root:
                root=Path(root); archive=root/'web.tar.gz'; staged=root/'stage'
                with tarfile.open(archive,'w:gz') as out:
                    entry=tarfile.TarInfo(name); entry.type=kind; entry.linkname='../outside'; out.addfile(entry)
                with self.assertRaises(ValueError): release.stage(archive,staged)
                self.assertFalse(staged.exists())

    def test_existing_live_symlink_is_not_followed(self):
        with tempfile.TemporaryDirectory() as root:
            root=Path(root); staged=root/'stage'; live=root/'live'; outside=root/'outside'
            staged.mkdir(); live.mkdir(); outside.mkdir(); (staged/'index.html').write_text('new'); (live/'index.html').symlink_to(outside/'index.html')
            with self.assertRaises(ValueError): release.install(staged,live)
            self.assertFalse((outside/'index.html').exists())

if __name__=='__main__': unittest.main()
