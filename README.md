# YTDL Premiere

Minimal local replacement for ytdl-material when the goal is:

1. Send a browser URL to a local downloader.
2. Download the highest available source with `yt-dlp`.
3. Transcode a Premiere-friendly H.264/AAC MP4.
4. Put both files in the project folder you choose in the extension.

This is intentionally not wired into ytdl-material.

## Output Root

Copy `.env.example` to `.env`, then set `HOST_OUTPUT_ROOT` to the broad folder that contains your project directories.

Example:

```env
HOST_OUTPUT_ROOT=X:/Projects
```

Docker Compose mounts that host folder into the service as `/output-root`.

The Chrome extension can then send a destination such as:

```text
X:\Projects\ClientOrShow\incoming
```

The service rejects output folders outside `HOST_OUTPUT_ROOT`.

## Start The Service

```powershell
docker compose up -d --build
```

Health check:

```powershell
curl.exe http://127.0.0.1:8787/health
```

The Compose file binds the API to `127.0.0.1:8787` so it is reachable from the browser extension on the same machine without exposing the service on the local network.

## Install The Chrome Extension

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select the `extension` folder in this repo.

Click the extension on a video page, then click `Download + Transcode`.

Set `Destination folder` in the popup to the project folder where the source and Premiere copy should land. The extension remembers the last value.

## Output Naming

For each job, the service writes into the selected destination folder:

- `Title [id].ext`: original highest-quality source.
- `Title [id]_premiere.mp4`: Premiere-friendly transcode.

The original is kept intact.

## Transcode Settings

Defaults:

```env
CRF=18
PRESET=medium
AUDIO_BITRATE=192k
TARGET_FPS=
```

`TARGET_FPS` is blank by default. That preserves the source frame rate. Set it to `24000/1001` only when you explicitly want ffmpeg to convert the output to 23.976 by dropping/duplicating frames as needed.

## API

Create a job:

```powershell
curl.exe -X POST http://127.0.0.1:8787/api/jobs `
  -H "Content-Type: application/json" `
  -d '{"url":"https://example.com/video","output_dir":"X:\\Projects\\ClientOrShow\\incoming"}'
```

List jobs:

```powershell
curl.exe http://127.0.0.1:8787/api/jobs
```
