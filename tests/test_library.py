"""Project/history acceptance uses fake generation and isolated output/catalog roots."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
from fastapi.testclient import TestClient
from test_generation import FakeService, configured_app, submit, wait_for_job
from backend.main import create_app
from backend.services.jobs import write_json
from backend.settings import SettingsStore


def complete(client):
    return wait_for_job(client, submit(client, title="Original", style=" piano\r\n", lyrics=" Exact\nlyrics ", seed="9223372036854775807")["id"])


def test_projects_assignment_filters_export_and_restart(tmp_path):
    app = configured_app(tmp_path)
    with TestClient(app, base_url="http://127.0.0.1") as client:
        project = client.post("/api/projects", json={"name": "Album", "tags": ["pop"], "notes": "notes"}).json()
        assert client.patch(f"/api/projects/{project['id']}", json={"name": "New Album"}).json()["name"] == "New Album"
        job = complete(client)
        original_bytes = {path.name: path.read_bytes() for path in Path(job["output_directory"]).glob("*.json")}
        identifier = job["id"]
        response = client.patch(f"/api/history/{identifier}", json={"project_id": project["id"], "display_name": "New take", "favorite": True, "notes": "Lovely"})
        assert response.status_code == 200, response.text
        for query in ("q=Lovely", "favorite=true", f"project_id={project['id']}", "seed=9223372036854775807", "model=m-a-p%2FYuE2-3B", "cot=full", "date_from=2000-01-01&date_to=2100-01-01"):
            assert len(client.get("/api/history?" + query).json()["generations"]) == 1
        assert client.get("/api/history?project_id=unassigned").json()["generations"] == []
        export = client.get(f"/api/projects/{project['id']}/export")
        assert export.headers["content-disposition"].startswith("attachment")
        assert identifier in export.json()["generations"]
        assert original_bytes == {path.name: path.read_bytes() for path in Path(job["output_directory"]).glob("*.json")}
    with TestClient(configured_app(tmp_path), base_url="http://127.0.0.1") as client:
        entry = client.get("/api/history").json()["generations"][0]
        assert entry["favorite"] and entry["display_name"] == "New take"
        assert entry["project_id"] == project["id"]
        assert client.get(entry["job"]["audio_url"], headers={"Range": "bytes=4-7"}).content == b"0123"


def test_cross_output_root_persistence_and_explicit_library_switch(tmp_path):
    path = tmp_path / "settings.json"
    with TestClient(configured_app(tmp_path), base_url="http://127.0.0.1") as client:
        job = complete(client)
        settings = client.get("/api/settings").json()
        settings["outputs_directory"] = str(tmp_path / "new-outputs")
        assert client.put("/api/settings", json=settings).status_code == 200
    with TestClient(create_app(path, service_factory=FakeService), base_url="http://127.0.0.1") as client:
        entry = client.get("/api/history").json()["generations"][0]
        assert entry["job"]["id"] == job["id"]
        assert client.get(entry["job"]["audio_url"]).status_code == 200
        settings["projects_directory"] = str(tmp_path / "different-library")
        assert client.put("/api/settings", json=settings).status_code == 200
        assert client.get("/api/history").json()["generations"] == []


def test_adopts_existing_outputs_without_rewriting_request(tmp_path):
    with TestClient(configured_app(tmp_path), base_url="http://127.0.0.1") as client:
        job = complete(client)
    catalog = tmp_path / "projects/catalog.json"
    catalog.rename(catalog.with_suffix(".backup"))
    directory = Path(job["output_directory"])
    before = {str(path.relative_to(directory)): path.read_bytes() for path in directory.rglob("*") if path.is_file()}
    with TestClient(configured_app(tmp_path), base_url="http://127.0.0.1") as client:
        history = client.get("/api/history").json()
        assert len(history["generations"]) == 1
        assert history["generations"][0]["project_id"] is None
        assert len(client.get("/api/history").json()["generations"]) == 1
    assert before == {str(path.relative_to(directory)): path.read_bytes() for path in directory.rglob("*") if path.is_file()}


def test_reuse_lineage_and_missing_provenance_rejects_rerun(tmp_path):
    with TestClient(configured_app(tmp_path), base_url="http://127.0.0.1") as client:
        job = complete(client)
        identifier = job["id"]
        manifest = client.get(f"/api/history/{identifier}/reproduction").json()
        assert manifest["request"]["style"] == " piano\r\n"
        assert any("commit is unknown" in warning for warning in manifest["warnings"])
        assert client.post(f"/api/history/{identifier}/rerun").status_code == 409
        reused = client.get(f"/api/history/{identifier}/reuse").json()
        assert reused["request"]["seed"] == "9223372036854775807"
        child = wait_for_job(client, client.post("/api/jobs", json=reused["request"]).json()["id"])
        entry = next(entry for entry in client.get("/api/history").json()["generations"] if entry["job"]["id"] == child["id"])
        assert entry["parent_generation_id"] == identifier and entry["relation"] == "derived"
        assert "project_id" not in client.app.state.job_manager.service.requests[-1]


def test_artifact_hash_mismatch_missing_preview_and_path_guards(tmp_path):
    with TestClient(configured_app(tmp_path), base_url="http://127.0.0.1") as client:
        job = complete(client)
        directory = Path(job["output_directory"]) / "artifacts"
        original = (directory / "audio.flac").read_bytes()
        result = {"artifacts": {"audio.flac": {"bytes": len(original), "sha256": hashlib.sha256(original).hexdigest()}}}
        write_json(directory / "result.json", result)
        url = f"/api/history/{job['id']}"
        artifacts = {item["name"]: item for item in client.get(url + "/artifacts").json()["artifacts"]}
        assert artifacts["artifacts/audio.flac"]["integrity"] == "verified"
        assert artifacts["artifacts/semantic.npy"]["integrity"] == "missing"
        (directory / "audio.flac").write_bytes(b"changed")
        artifacts = client.get(url + "/artifacts").json()
        assert any("mismatch" in warning for warning in artifacts["warnings"])
        (directory / "score.abc").write_text("x" * 20000)
        items = {item["name"]: item for item in client.get(url + "/artifacts").json()["artifacts"]}
        assert len(items["artifacts/score.abc"]["text_preview"]) == 16384
        (directory / "secret.txt").write_text("never serve")
        assert client.get(url + "/files/artifacts/secret.txt").status_code == 404
        (directory / "score.abc").unlink()
        (directory / "score.abc").symlink_to(tmp_path / "settings.json")
        assert client.get(url + "/files/artifacts/score.abc").status_code == 404


def test_corrupt_catalog_is_preserved_and_can_switch_library(tmp_path):
    app = configured_app(tmp_path)
    with TestClient(app, base_url="http://127.0.0.1") as client:
        client.post("/api/projects", json={"name": "Original"})
        catalog = tmp_path / "projects/catalog.json"
        catalog.write_text("broken")
        assert client.get("/api/history").status_code == 409
        assert client.post("/api/projects", json={"name": "Replacement"}).status_code == 409
        assert catalog.read_text() == "broken"
        settings = client.get("/api/settings").json()
        settings["projects_directory"] = str(tmp_path / "new-library")
        assert client.put("/api/settings", json=settings).status_code == 200
        assert client.get("/api/projects").json() == {"projects": []}


def test_invalid_references_and_unsafe_project_storage_precede_reservation(tmp_path):
    with TestClient(configured_app(tmp_path), base_url="http://127.0.0.1") as client:
        for field in ("project_id", "parent_generation_id"):
            response = client.post("/api/jobs", json={"style": "x", "lyrics": "y", field: "a" * 32})
            assert response.status_code in {404, 422}
        assert not (tmp_path / "outputs").exists()
        settings = client.get("/api/settings").json()
        settings["projects_directory"] = str(tmp_path / "upstream/projects")
        assert client.put("/api/settings", json=settings).status_code == 409
        assert not (tmp_path / "upstream/projects").exists()


def test_registration_failure_does_not_run_inference(tmp_path, monkeypatch):
    app = configured_app(tmp_path)
    with TestClient(app, base_url="http://127.0.0.1") as client:
        def fail(catalog):
            raise PermissionError("catalog read-only")
        monkeypatch.setattr(app.state.library, "_save", fail)
        response = client.post("/api/jobs", json={"style": "x", "lyrics": "y"})
        assert response.status_code == 409
        assert not app.state.job_manager.service.entered.wait(.1)
        jobs = client.get("/api/jobs").json()["jobs"]
        assert jobs[0]["status"] == "failed"
        assert not app.state.job_manager.queue


def test_reuse_rejects_native_request_disagreement_and_external_abc(tmp_path):
    with TestClient(configured_app(tmp_path), base_url="http://127.0.0.1") as client:
        job = complete(client)
        directory = Path(job["output_directory"]) / "artifacts"
        request = {key: job["request"][key] for key in ("style", "lyrics", "cot", "cfg_scale")}
        request.update(id=job["id"], seed=int(job["request"]["seed"]), abc="X:1")
        write_json(directory / "request.json", request)
        url = f"/api/history/{job['id']}/reuse"
        assert "ABC input" in client.get(url).json()["detail"]
        request.update(abc=None, lyrics="changed")
        write_json(directory / "request.json", request)
        assert "differs" in client.get(url).json()["detail"]


def test_saved_rerun_keeps_inference_settings_and_current_output_root(tmp_path, monkeypatch):
    app = configured_app(tmp_path)
    commit = "b" * 40
    identity = {"commit": commit, "dirty": False, "status": "verified"}
    monkeypatch.setattr("backend.services.library.upstream_identity", lambda repository: identity)
    with TestClient(app, base_url="http://127.0.0.1") as client:
        job = complete(client)
        directory = Path(job["output_directory"])
        settings = json.loads((directory / "settings.json").read_text())
        settings.update(model_revision="a" * 40, vae_revision="c" * 40, huggingface_cache=str(tmp_path / "cache"))
        for model, revision in ((settings["model"], settings["model_revision"]), (settings["vae"], settings["vae_revision"])):
            snapshot = tmp_path / "cache" / ("models--" + model.replace("/", "--")) / "snapshots" / revision
            snapshot.mkdir(parents=True)
            (snapshot / "config.json").write_text("{}")
            (snapshot / "model.safetensors").write_bytes(b"fixture")
            (snapshot / "qwen.tiktoken").write_bytes(b"fixture")
        write_json(directory / "settings.json", settings)
        write_json(directory / "runtime.json", {"upstream": identity})
        write_json(directory / "artifacts/config.json", {"generation": "saved"})
        write_json(directory / "artifacts/result.json", {"weights": {"mot": "original"}})
        current = client.get("/api/settings").json()
        current.update(model="different/model", outputs_directory=str(tmp_path / "new-outputs"))
        assert client.put("/api/settings", json=current).status_code == 200
        response = client.post(f"/api/history/{job['id']}/rerun")
        assert response.status_code == 202, response.text
        child = wait_for_job(client, response.json()["id"])
        assert child["status"] == "complete"
        assert Path(child["output_directory"]).parent == tmp_path / "new-outputs"
        saved_child = json.loads((Path(child["output_directory"]) / "settings.json").read_text())
        assert saved_child["model"] == settings["model"]
        assert saved_child["model_revision"] == "a" * 40
        assert client.get("/api/settings").json()["model"] == "different/model"
        assert json.loads((Path(child["output_directory"]) / "lineage.json").read_text())["relation"] == "rerun"


def test_malformed_nested_provenance_is_actionable(tmp_path):
    with TestClient(configured_app(tmp_path), base_url="http://127.0.0.1") as client:
        job = complete(client)
        directory = Path(job["output_directory"])
        write_json(directory / "runtime.json", {"upstream": None})
        write_json(directory / "artifacts/result.json", {"timing": [], "weights": []})
        manifest = client.get(f"/api/history/{job['id']}/reproduction")
        assert manifest.status_code == 200
        assert any("commit is unknown" in warning for warning in manifest.json()["warnings"])
        response = client.post(f"/api/history/{job['id']}/rerun")
        assert response.status_code == 409
        assert "Reuse inputs" in response.json()["detail"]


def test_reproduction_guard_rejects_loaded_config_drift_before_native_call(monkeypatch):
    from types import SimpleNamespace
    import sys
    import pytest
    from backend.services.yue2_service import YuE2Service
    from backend.settings import Settings
    calls = []
    pipeline = SimpleNamespace(weights={"mot": "same"}, effective_config=lambda *args: {"steps": 32})
    monkeypatch.setitem(sys.modules, "yue2.protocol", SimpleNamespace(SongRequest=lambda **request: request))
    service = YuE2Service(Settings(), lambda repository: lambda *args, **kwargs: pipeline)
    service.expected_reproduction = {"config": {"steps": 16}, "weights": {"mot": "same"}}
    with pytest.raises(ValueError, match="Saved configuration or weights differ"):
        service.generate(style="exact", lyrics="exact", seed=42)


def test_interrupted_historical_root_remains_visible_without_receipt_mutation(tmp_path):
    path = tmp_path / "settings.json"
    with TestClient(configured_app(tmp_path), base_url="http://127.0.0.1") as client:
        job = complete(client)
        client.get("/api/history")
        settings = client.get("/api/settings").json()
        settings["outputs_directory"] = str(tmp_path / "new-outputs")
        assert client.put("/api/settings", json=settings).status_code == 200
    receipt = Path(job["output_directory"]) / "job.json"
    job.update(status="running", stage="semantic", finished_at=None, audio_url=None)
    write_json(receipt, job)
    original = receipt.read_bytes()
    with TestClient(create_app(path, service_factory=FakeService), base_url="http://127.0.0.1") as client:
        history = client.get("/api/history").json()
        assert history["generations"][0]["job"]["status"] == "failed"
        assert any("Interrupted historical" in warning for warning in history["warnings"])
    assert receipt.read_bytes() == original
