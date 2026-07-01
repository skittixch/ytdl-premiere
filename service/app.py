import json
import os
import queue
import re
import shutil
import subprocess
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, HttpUrl


OUTPUT_ROOT = Path(os.environ.get("OUTPUT_ROOT", "/output-root"))
HOST_OUTPUT_ROOT = os.environ.get("HOST_OUTPUT_ROOT", "").strip()
DEFAULT_OUTPUT_DIR = os.environ.get("DEFAULT_OUTPUT_DIR", "").strip()
WORK_DIR = Path(os.environ.get("WORK_DIR", "/tmp/ytdl-premiere-work"))
CRF = os.environ.get("CRF", "18")
PRESET = os.environ.get("PRESET", "medium")
AUDIO_BITRATE = os.environ.get("AUDIO_BITRATE", "192k")
TARGET_FPS = os.environ.get("TARGET_FPS", "").strip()

MEDIA_EXTENSIONS = {".mp4", ".mov", ".mkv", ".webm", ".m4v"}
JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()
JOB_QUEUE: queue.Queue[str] = queue.Queue()


class CreateJobRequest(BaseModel):
    url: HttpUrl
    browser_title: str | None = Field(default=None, max_length=300)
    output_dir: str | None = Field(default=None, max_length=1000)


class JobResponse(BaseModel):
    id: str
    status: Literal["queued", "running", "done", "failed"]
    step: str
    url: str
    created_at: str
    updated_at: str
    source_path: str | None = None
    premiere_path: str | None = None
    output_dir: str | None = None
    error: str | None = None


app = FastAPI(title="YTDL Premiere Local", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def start_worker() -> None:
    threading.Thread(target=worker_loop, daemon=True).start()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def update_job(job_id: str, **changes) -> None:
    with JOBS_LOCK:
        job = JOBS[job_id]
        job.update(changes)
        job["updated_at"] = now_iso()


def get_job(job_id: str) -> dict:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")
        return dict(job)


def run_command(args: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        args,
        cwd=str(cwd) if cwd else None,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def sanitize_filename(value: str, fallback: str) -> str:
    value = value.strip() or fallback
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", value)
    value = re.sub(r"\s+", " ", value).strip(" .")
    return value[:180] or fallback


def normalize_host_path(path_value: str) -> str:
    return path_value.strip().replace("\\", "/").rstrip("/")


def looks_like_windows_absolute_path(path_value: str) -> bool:
    return bool(re.match(r"^[A-Za-z]:/", normalize_host_path(path_value)))


def map_requested_output_dir(requested_output_dir: str | None) -> tuple[Path, str]:
    requested = (requested_output_dir or DEFAULT_OUTPUT_DIR or "").strip()

    if not requested:
        return OUTPUT_ROOT, display_path(OUTPUT_ROOT)

    normalized = normalize_host_path(requested)

    if HOST_OUTPUT_ROOT and looks_like_windows_absolute_path(normalized):
        host_root = normalize_host_path(HOST_OUTPUT_ROOT)
        if normalized.casefold() != host_root.casefold() and not normalized.casefold().startswith(
            f"{host_root.casefold()}/"
        ):
            raise ValueError(f"Output folder must be inside {HOST_OUTPUT_ROOT}")

        relative = normalized[len(host_root) :].lstrip("/")
        container_path = OUTPUT_ROOT / relative
        return container_path, host_display_path(container_path)

    if looks_like_windows_absolute_path(normalized) and not HOST_OUTPUT_ROOT:
        raise ValueError("HOST_OUTPUT_ROOT must be set to use full Windows output paths")

    relative = normalized.lstrip("/")
    if ".." in Path(relative).parts:
        raise ValueError("Output folder cannot contain '..'")

    container_path = OUTPUT_ROOT / relative
    return container_path, host_display_path(container_path)


def host_display_path(container_path: Path) -> str:
    try:
        relative = container_path.resolve().relative_to(OUTPUT_ROOT.resolve())
    except ValueError:
        return str(container_path)

    if HOST_OUTPUT_ROOT:
        host_root = normalize_host_path(HOST_OUTPUT_ROOT)
        combined = f"{host_root}/{relative.as_posix()}" if str(relative) != "." else host_root
        return combined.replace("/", "\\") if re.match(r"^[A-Za-z]:/", combined) else combined

    return str(container_path)


def display_path(path: Path) -> str:
    try:
        path.resolve().relative_to(OUTPUT_ROOT.resolve())
        return host_display_path(path)
    except ValueError:
        return str(path)


def unique_path(path: Path) -> Path:
    if not path.exists():
        return path

    stem = path.stem
    suffix = path.suffix
    for index in range(2, 1000):
        candidate = path.with_name(f"{stem} ({index}){suffix}")
        if not candidate.exists():
            return candidate

    raise RuntimeError(f"Could not create a unique filename for {path}")


def probe_metadata(url: str) -> tuple[str, str]:
    completed = run_command(["yt-dlp", "--no-playlist", "--dump-single-json", url])
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or "yt-dlp metadata probe failed")

    data = json.loads(completed.stdout)
    title = str(data.get("title") or "download")
    video_id = str(data.get("id") or uuid.uuid4().hex[:8])
    return title, video_id


def find_downloaded_media(job_dir: Path) -> Path:
    candidates = [
        path
        for path in job_dir.iterdir()
        if path.is_file()
        and path.suffix.lower() in MEDIA_EXTENSIONS
        and not path.name.endswith(".part")
    ]

    if not candidates:
        raise RuntimeError("yt-dlp finished but no media file was found")

    return max(candidates, key=lambda path: path.stat().st_size)


def download_source(job_id: str, url: str, job_dir: Path) -> tuple[Path, str, str]:
    update_job(job_id, status="running", step="reading metadata")
    title, video_id = probe_metadata(url)

    update_job(job_id, step="downloading highest available source")
    completed = run_command(
        [
            "yt-dlp",
            "--no-playlist",
            "-f",
            "bv*+ba/b",
            "--merge-output-format",
            "mp4",
            "-o",
            str(job_dir / "source.%(ext)s"),
            url,
        ]
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or "yt-dlp download failed")

    source = find_downloaded_media(job_dir)
    return source, title, video_id


def ffmpeg_args(source_path: Path, temp_output: Path) -> list[str]:
    args = [
        "ffmpeg",
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(source_path),
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-map_metadata",
        "0",
    ]

    if TARGET_FPS:
        args.extend(["-vf", f"fps={TARGET_FPS}"])

    args.extend(
        [
            "-c:v",
            "libx264",
            "-preset",
            PRESET,
            "-crf",
            CRF,
            "-pix_fmt",
            "yuv420p",
            "-fps_mode",
            "cfr",
            "-c:a",
            "aac",
            "-b:a",
            AUDIO_BITRATE,
            "-movflags",
            "+faststart",
            str(temp_output),
        ]
    )
    return args


def transcode_for_premiere(job_id: str, source_path: Path, premiere_path: Path) -> None:
    update_job(job_id, step="transcoding for Premiere")
    temp_output = premiere_path.with_suffix(".tmp.mp4")
    temp_output.unlink(missing_ok=True)

    completed = run_command(ffmpeg_args(source_path, temp_output))
    if completed.returncode != 0:
        temp_output.unlink(missing_ok=True)
        raise RuntimeError(completed.stderr.strip() or "ffmpeg transcode failed")

    temp_output.replace(premiere_path)


def process_job(job_id: str) -> None:
    job = get_job(job_id)
    url = job["url"]
    requested_output_dir = job.get("requested_output_dir")
    job_dir = WORK_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    try:
        output_dir, output_display_dir = map_requested_output_dir(requested_output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        update_job(job_id, output_dir=output_display_dir)

        source_temp, title, video_id = download_source(job_id, url, job_dir)
        base_name = sanitize_filename(f"{title} [{video_id}]", f"download-{job_id}")
        source_path = unique_path(output_dir / f"{base_name}{source_temp.suffix.lower()}")
        premiere_path = unique_path(output_dir / f"{base_name}_premiere.mp4")

        update_job(job_id, step="moving source into output folder")
        shutil.move(str(source_temp), source_path)
        update_job(job_id, source_path=display_path(source_path))

        transcode_for_premiere(job_id, source_path, premiere_path)
        update_job(
            job_id,
            status="done",
            step="complete",
            source_path=display_path(source_path),
            premiere_path=display_path(premiere_path),
        )
    except Exception as exc:
        update_job(job_id, status="failed", step="failed", error=str(exc))
    finally:
        shutil.rmtree(job_dir, ignore_errors=True)


def worker_loop() -> None:
    while True:
        job_id = JOB_QUEUE.get()
        try:
            process_job(job_id)
        finally:
            JOB_QUEUE.task_done()


@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "output_root": str(OUTPUT_ROOT),
        "host_output_root": HOST_OUTPUT_ROOT or None,
        "default_output_dir": DEFAULT_OUTPUT_DIR or None,
        "target_fps": TARGET_FPS or None,
        "crf": CRF,
        "preset": PRESET,
        "queued_jobs": JOB_QUEUE.qsize(),
    }


@app.post("/api/jobs", response_model=JobResponse)
def create_job(request: CreateJobRequest) -> JobResponse:
    job_id = uuid.uuid4().hex
    job = {
        "id": job_id,
        "status": "queued",
        "step": "queued",
        "url": str(request.url),
        "browser_title": request.browser_title,
        "requested_output_dir": request.output_dir,
        "created_at": now_iso(),
        "updated_at": now_iso(),
        "source_path": None,
        "premiere_path": None,
        "output_dir": None,
        "error": None,
    }

    with JOBS_LOCK:
        JOBS[job_id] = job

    JOB_QUEUE.put(job_id)

    return JobResponse(**job)


@app.get("/api/jobs", response_model=list[JobResponse])
def list_jobs() -> list[JobResponse]:
    with JOBS_LOCK:
        jobs = sorted(JOBS.values(), key=lambda item: item["created_at"], reverse=True)
        return [JobResponse(**dict(job)) for job in jobs]


@app.get("/api/jobs/{job_id}", response_model=JobResponse)
def read_job(job_id: str) -> JobResponse:
    return JobResponse(**get_job(job_id))
