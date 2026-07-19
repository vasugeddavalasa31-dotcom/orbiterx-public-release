import os
from pathlib import Path

PACKAGE_NAME = "openai-orbiterx-cli-bin"
PACKAGE_METADATA_FILENAME = "orbiterx-package.json"


def bundled_package_dir() -> Path:
    path = Path(__file__).resolve().parent
    metadata_path = path / PACKAGE_METADATA_FILENAME
    if not metadata_path.is_file():
        raise FileNotFoundError(
            f"{PACKAGE_NAME} is installed but missing its package metadata at {metadata_path}"
        )
    return path


def bundled_orbiterx_path() -> Path:
    exe = "orbiterx.exe" if os.name == "nt" else "orbiterx"
    path = bundled_package_dir() / "bin" / exe
    if not path.is_file():
        raise FileNotFoundError(
            f"{PACKAGE_NAME} is installed but missing its packaged orbiterx binary at {path}"
        )
    return path


def bundled_path_dir() -> Path | None:
    path = bundled_package_dir() / "orbiterx-path"
    return path if path.is_dir() else None


__all__ = [
    "PACKAGE_NAME",
    "bundled_orbiterx_path",
    "bundled_package_dir",
    "bundled_path_dir",
]
