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

If the active tab is a Google results page or another page with visible YouTube links, the popup tries to detect the first usable YouTube video URL instead of submitting the Google page URL. If it cannot detect one, paste the YouTube video URL into the popup.

## Queue, Progress, And Notifications

The popup shows recent jobs from the local service with progress bars for the queue, download, and transcode phases.

Enable `Notify when jobs finish` in the popup to allow desktop notifications when watched jobs complete or fail. Chrome may ask for notification permission the first time you enable it.

The service processes jobs sequentially, so multiple submitted jobs do not start multiple ffmpeg transcodes at once.

## YouTube Batch Mode

Batch mode is off by default. Enable `Batch mode on YouTube` in the popup when you want the thumbnail checkmark selector on YouTube pages.

When Batch mode is on:

1. Hover over a YouTube video thumbnail until the checkmark appears.
2. Click the checkmark to enter selection mode.
3. Use the checkmarks shown on visible videos to add or remove them.
4. Set one destination folder in the queue panel.
5. Click `Send queue`.

Turn Batch mode off in the popup to remove the checkmark behavior from YouTube pages.

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
