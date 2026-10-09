"""All tests use temporary working directories, including relative default storage."""
import pytest

@pytest.fixture(autouse=True)
def isolated_storage(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
