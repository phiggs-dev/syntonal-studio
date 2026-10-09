"""Inspect native YuE2 artifacts without inference or modifying the recording.

PCM means pulse-code modulation. RMS is root-mean-square sample amplitude.
This validates file integrity and signal structure, not perceived musical quality.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def verify_generation(directory: Path) -> dict[str, Any]:
    import numpy as np
    import soundfile as sf

    directory = directory.resolve()
    metadata = json.loads((directory / "result.json").read_text(encoding="utf-8"))
    if metadata.get("status") != "complete":
        raise ValueError("Native result is not complete")
    required = {"audio.flac", "request.json", "config.json", "plan.json", "plan_manifest.json",
                "abc_tokens.npy", "prefix.npy", "semantic.npy", "latent.npy"}
    artifacts = metadata.get("artifacts", {})
    if not required.issubset(artifacts):
        raise ValueError("Native result is missing required artifact entries")
    for name, expected in artifacts.items():
        path = directory / name
        if path.is_symlink() or not path.resolve().is_relative_to(directory):
            raise ValueError(f"Unsafe artifact path: {name}")
        if not path.is_file() or path.stat().st_size != expected["bytes"]:
            raise ValueError(f"Missing or wrong-size artifact: {name}")
        if file_sha256(path) != expected["sha256"]:
            raise ValueError(f"Artifact hash mismatch: {name}")
    audio, sample_rate = sf.read(directory / "audio.flac", dtype="float32", always_2d=True)
    if sample_rate != 48000 or audio.shape[1] != 2 or audio.shape[0] == 0:
        raise ValueError("Expected nonempty native 48 kHz stereo audio")
    if not np.isfinite(audio).all() or not np.any(audio):
        raise ValueError("Audio is nonfinite or completely silent")
    semantic = np.load(directory / "semantic.npy", allow_pickle=False)
    latents = np.load(directory / "latent.npy", allow_pickle=False)
    if semantic.ndim != 1 or semantic.dtype != np.int32 or semantic.size == 0:
        raise ValueError("Expected nonempty int32 semantic tokens")
    valid_latents = (latents.ndim == 2 and latents.shape[1] == 64) or (
        latents.ndim == 3 and latents.shape[0] == 1 and latents.shape[1] == 64
    )
    if not valid_latents or latents.size == 0 or latents.dtype != np.float32 or not np.isfinite(latents).all():
        raise ValueError("Expected finite float32 native acoustic latents")
    request = json.loads((directory / "request.json").read_text(encoding="utf-8"))
    duration = len(audio) / sample_rate
    if abs(duration - metadata["audio_seconds"]) > 1 / sample_rate:
        raise ValueError("Native duration metadata disagrees with the FLAC")
    return {
        "artifact_directory": str(directory), "verified_artifact_count": len(artifacts),
        "sample_rate": sample_rate, "channels": audio.shape[1], "duration_seconds": duration,
        "subtype": sf.info(directory / "audio.flac").subtype,
        "peak_amplitude": float(np.max(np.abs(audio))),
        "rms_amplitude": float(np.sqrt(np.mean(audio.astype(np.float64) ** 2))),
        "semantic_tokens": int(semantic.size), "latent_shape": list(latents.shape),
        "truncated": metadata["truncated"], "request": request,
        "audio_sha256": file_sha256(directory / "audio.flac"),
        "musical_quality_evaluated": False,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path, help="Native artifacts directory containing result.json")
    arguments = parser.parse_args()
    print(json.dumps(verify_generation(arguments.directory), indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
