#!/usr/bin/env python3
"""Build the TurnStage Web catalog from adjacent JSONC profile folders.

Uses only the Python 3.6 standard library. The generated catalog lists paths;
the browser loads and validates the original VSIX-compatible JSONC files.
"""

import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from urllib.parse import quote


MAX_FILE_BYTES = 524288
MAX_ENTRIES = 100
MAX_CATALOG_BYTES = 1048576
FOLDER_CATALOG_ID = "turnstage-folder-catalog"
DEFAULT_CATALOG_ID = "turnstage-default"
SOURCES = (
    ("profiles", "profiles", re.compile(r"^.+\.turnstage\.jsonc$")),
    ("environments", "environments", re.compile(r"^.+\.environment\.jsonc$")),
)


def scan(root, folder_name, filename_pattern):
    folder = root / folder_name
    if not folder.is_dir() or folder.is_symlink():
        raise ValueError("Missing or unsafe folder: {}".format(folder))
    paths = []
    for directory, names, filenames in os.walk(str(folder), followlinks=False):
        names.sort()
        filenames.sort()
        for name in names:
            path = Path(directory) / name
            if (path.is_symlink() or not path.is_dir() or len(name.encode("utf-8")) > 200
                    or name in (".", "..") or any(ord(character) < 32 or ord(character) == 127 or character == "\\" for character in name)):
                raise ValueError("Unsupported or unsafe folder: {}".format(path))
        for name in filenames:
            path = Path(directory) / name
            if not name.endswith(".jsonc") and not path.is_symlink():
                continue
            if (not filename_pattern.fullmatch(name) or path.is_symlink() or not path.is_file()
                    or len(name.encode("utf-8")) > 200
                    or any(ord(character) < 32 or ord(character) == 127 or character == "\\" for character in name)):
                raise ValueError("Unsupported or unsafe JSONC file: {}".format(path))
            paths.append(path)
    paths.sort(key=lambda path: path.relative_to(folder).parts)
    if any(len(path.relative_to(folder).parts) > 9 for path in paths):
        raise ValueError("JSONC folder nesting exceeds eight levels")
    if len(paths) > MAX_ENTRIES:
        raise ValueError("{} contains more than {} JSONC files".format(folder_name, MAX_ENTRIES))
    entries = []
    for path in paths:
        content = path.read_bytes()
        if len(content) > MAX_FILE_BYTES:
            raise ValueError("JSONC file exceeds 512 KiB: {}".format(path))
        content.decode("utf-8")
        digest = hashlib.sha256(content).hexdigest()[:16]
        encoded_path = "/".join(quote(part, safe="-._~") for part in path.relative_to(folder).parts)
        entries.append({"file": "./{}/{}".format(folder_name, encoded_path), "version": digest})
    return entries


def check_existing_catalog(target):
    if not target.exists():
        return
    try:
        current = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError) as error:
        raise ValueError("Existing catalog cannot be read; refusing to overwrite: {}".format(error))
    if not isinstance(current, dict) or current.get("format") != "turnstage-web-catalog":
        raise ValueError("Existing catalog is not a TurnStage Web catalog; refusing to overwrite")
    catalog_id = current.get("id")
    if catalog_id == FOLDER_CATALOG_ID:
        return
    if catalog_id == DEFAULT_CATALOG_ID and all(
        isinstance(entry, dict) and "bundled" in entry
        for kind in ("profiles", "environments")
        for entry in current.get(kind, [])
    ):
        return
    raise ValueError("Existing catalog has custom entries; refusing to overwrite them")


def generate(root):
    target = root / "turnstage-catalog.json"
    check_existing_catalog(target)
    found = {}
    for kind, folder_name, pattern in SOURCES:
        found[kind] = scan(root, folder_name, pattern)
    profiles = found["profiles"] or [
        {"bundled": "basic-sse-chat"},
        {"bundled": "agent-flow"},
        {"bundled": "enterprise-chat"},
    ]
    environments = found["environments"] or [{"bundled": "local"}]
    revision_source = json.dumps([profiles, environments], sort_keys=True, separators=(",", ":")).encode("utf-8")
    catalog = {
        "format": "turnstage-web-catalog",
        "version": 1,
        "id": FOLDER_CATALOG_ID,
        "revision": hashlib.sha256(revision_source).hexdigest()[:16],
        "profiles": profiles,
        "environments": environments,
    }
    output = (json.dumps(catalog, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    if len(output) > MAX_CATALOG_BYTES:
        raise ValueError("Generated catalog exceeds 1 MiB")
    mode = (target.stat().st_mode & 0o777) if target.exists() else 0o644
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=str(root), prefix=".turnstage-catalog-", suffix=".tmp", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(output)
        os.chmod(str(temporary), mode)
        os.replace(str(temporary), str(target))
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()
    return len(found["profiles"]), len(found["environments"]), target


def main():
    if len(sys.argv) > 2:
        print("Usage: python3 update_profiles.py [web-root]", file=sys.stderr)
        return 2
    root = Path(sys.argv[1]).resolve() if len(sys.argv) == 2 else Path(__file__).resolve().parent
    try:
        profiles, environments, target = generate(root)
    except (OSError, UnicodeError, ValueError) as error:
        print("Cannot update official profiles: {}".format(error), file=sys.stderr)
        return 1
    print("Updated {} ({} profiles, {} environments).".format(target, profiles, environments))
    return 0


if __name__ == "__main__":
    sys.exit(main())
