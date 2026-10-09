"""Provenance probes are mocked: tests never initialize CUDA or access live jobs."""
import subprocess
from backend.services import provenance
from backend.settings import Settings


def test_gpu_identity_records_multiple_devices_with_units(monkeypatch):
    def probe(command, **options):
        assert command == ["nvidia-smi", "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader,nounits"]
        assert options["timeout"] == 5 and options["check"] is True
        return subprocess.CompletedProcess(command, 0, 'RTX 4080, 16376, 581.01\nRTX 4090, 24564, 581.01\n')
    monkeypatch.setattr(provenance.subprocess, "run", probe)
    result = provenance.gpu_identity()
    assert result["status"] == "verified"
    assert result["devices"] == [
        {"name": "RTX 4080", "memory_total_mib": 16376, "driver_version": "581.01"},
        {"name": "RTX 4090", "memory_total_mib": 24564, "driver_version": "581.01"},
    ]


def test_gpu_probe_unavailable_or_malformed_is_explicitly_unknown(monkeypatch):
    def unavailable(*args, **kwargs):
        raise subprocess.TimeoutExpired('nvidia-smi', 5, stderr='secret')
    monkeypatch.setattr(provenance.subprocess, "run", unavailable)
    result = provenance.gpu_identity()
    assert result["status"] == "unknown" and result["devices"] == []
    assert "secret" not in result["detail"]
    for response in ('', 'GPU, N/A, driver', 'GPU, 0, driver', 'x' * 65537):
        monkeypatch.setattr(provenance.subprocess, "run", lambda *args, **kwargs: subprocess.CompletedProcess([], 0, response))
        assert provenance.gpu_identity()["status"] == "unknown"


def test_source_package_reads_checkout_without_imports(tmp_path):
    (tmp_path / 'pyproject.toml').write_text('[project]\nname="yue2-infer"\nversion="0.1.6"\n')
    assert provenance.source_package_identity(tmp_path) == {"status": "verified", "name": "yue2-infer", "version": "0.1.6"}
    (tmp_path / 'pyproject.toml').write_text('invalid toml')
    assert provenance.source_package_identity(tmp_path)["status"] == "unknown"
    assert provenance.source_package_identity(None)["version"] is None
    assert provenance.source_package_identity(tmp_path / 'missing')["status"] == "unknown"


def test_collector_preserves_fields_and_records_cuda_distribution_versions(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(provenance, "upstream_identity", lambda path: {"status": "unknown"})
    monkeypatch.setattr(provenance, "gpu_identity", lambda: {"status": "unknown", "devices": []})
    monkeypatch.setattr(provenance.metadata, "version", lambda package: "12.8.90" if package == "nvidia-cuda-runtime-cu12" else "test-version")
    result = provenance.collect_provenance(Settings(outputs_directory=tmp_path / 'outputs', projects_directory=tmp_path / 'projects'))
    assert result["schema_version"] == 1 and result["captured_at"] and result["note"]
    assert result["runtime"]["dependencies"]["nvidia-cuda-runtime-cu12"] == "12.8.90"
    assert result["source_package"]["status"] == "unknown"
    assert result["gpu"]["status"] == "unknown"
