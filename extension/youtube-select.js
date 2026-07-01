const HOVER_DELAY_MS = 650;
const VIDEO_LINK_SELECTOR = 'a[href*="/watch?"], a[href^="/watch?"], a[href*="/shorts/"], a[href*="/live/"]';

let hoverTimer = null;
let hoverTarget = null;
let hoverButton = null;
let selectionMode = false;
let selectedVideos = new Map();
let panel = null;

function normalizeYouTubeUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl, window.location.origin);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./, "");
  if (host !== "youtube.com" && host !== "m.youtube.com") {
    return null;
  }

  if (url.pathname === "/watch") {
    const videoId = url.searchParams.get("v");
    if (!videoId) return null;
    return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  }

  const shortMatch = url.pathname.match(/^\/shorts\/([^/?#]+)/);
  if (shortMatch) {
    return `https://www.youtube.com/shorts/${encodeURIComponent(shortMatch[1])}`;
  }

  const liveMatch = url.pathname.match(/^\/live\/([^/?#]+)/);
  if (liveMatch) {
    return `https://www.youtube.com/live/${encodeURIComponent(liveMatch[1])}`;
  }

  return null;
}

function videoAnchorFromNode(node) {
  if (!(node instanceof Element)) return null;

  const anchor = node.matches?.(VIDEO_LINK_SELECTOR)
    ? node
    : node.closest?.(VIDEO_LINK_SELECTOR);

  if (!anchor || !normalizeYouTubeUrl(anchor.href)) {
    return null;
  }

  return anchor;
}

function videoAnchorFromEvent(event) {
  for (const item of event.composedPath()) {
    const anchor = videoAnchorFromNode(item);
    if (anchor) return anchor;
  }
  return videoAnchorFromNode(event.target);
}

function titleFromAnchor(anchor) {
  const title =
    anchor.getAttribute("aria-label") ||
    anchor.getAttribute("title") ||
    anchor.closest("ytd-rich-grid-media, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer")?.textContent ||
    anchor.textContent ||
    "YouTube video";

  return title.replace(/\s+/g, " ").trim().slice(0, 140) || "YouTube video";
}

function visualTargetForAnchor(anchor) {
  return (
    anchor.closest("ytd-thumbnail, ytd-rich-grid-media, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer") ||
    anchor
  );
}

function clearHoverTimer() {
  if (hoverTimer) {
    clearTimeout(hoverTimer);
    hoverTimer = null;
  }
}

function removeHoverButton() {
  clearHoverTimer();
  hoverTarget = null;
  hoverButton?.remove();
  hoverButton = null;
}

function positionHoverButton() {
  if (!hoverButton || !hoverTarget?.element?.isConnected) return;

  const rect = hoverTarget.element.getBoundingClientRect();
  hoverButton.style.top = `${Math.max(8, rect.top + 8)}px`;
  hoverButton.style.left = `${Math.max(8, rect.right - 42)}px`;
}

function showHoverButton(anchor) {
  const url = normalizeYouTubeUrl(anchor.href);
  if (!url || selectionMode) return;

  hoverTarget = {
    anchor,
    url,
    title: titleFromAnchor(anchor),
    element: visualTargetForAnchor(anchor)
  };

  hoverButton?.remove();
  hoverButton = document.createElement("button");
  hoverButton.type = "button";
  hoverButton.className = "ytdp-hover-check";
  hoverButton.title = "Select videos for YTDL Premiere";
  hoverButton.textContent = "✓";
  hoverButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    enterSelectionMode(hoverTarget);
  });

  document.documentElement.appendChild(hoverButton);
  positionHoverButton();
}

function onMouseOver(event) {
  if (selectionMode) return;

  const anchor = videoAnchorFromEvent(event);
  if (!anchor) return;

  clearHoverTimer();
  hoverTimer = setTimeout(() => showHoverButton(anchor), HOVER_DELAY_MS);
}

function onMouseOut(event) {
  if (selectionMode) return;
  if (hoverButton && event.relatedTarget === hoverButton) return;
  clearHoverTimer();
  if (hoverButton) {
    setTimeout(() => {
      if (!hoverButton?.matches(":hover")) {
        removeHoverButton();
      }
    }, 120);
  }
}

function toggleVideo(anchor) {
  const url = normalizeYouTubeUrl(anchor.href);
  if (!url) return;

  if (selectedVideos.has(url)) {
    selectedVideos.delete(url);
  } else {
    selectedVideos.set(url, {
      url,
      title: titleFromAnchor(anchor)
    });
  }

  renderSelectionMarks();
  renderPanel();
}

function renderSelectionMarks() {
  document.querySelectorAll(".ytdp-selected-video").forEach((node) => {
    node.classList.remove("ytdp-selected-video");
  });

  document.querySelectorAll(VIDEO_LINK_SELECTOR).forEach((anchor) => {
    const url = normalizeYouTubeUrl(anchor.href);
    if (!url || !selectedVideos.has(url)) return;
    visualTargetForAnchor(anchor).classList.add("ytdp-selected-video");
  });
}

async function getSavedOutputDir() {
  const saved = await chrome.storage.local.get(["outputDir"]);
  return saved.outputDir || "";
}

async function saveOutputDir(value) {
  if (value) {
    await chrome.storage.local.set({ outputDir: value });
  }
}

function ensurePanel() {
  if (panel) return panel;

  panel = document.createElement("section");
  panel.className = "ytdp-panel";
  panel.innerHTML = `
    <header>
      <strong>YTDL Premiere Queue</strong>
      <button type="button" class="ytdp-close" title="Cancel selection">×</button>
    </header>
    <label>
      Destination folder
      <input type="text" class="ytdp-output" placeholder="X:\\Projects\\ClientOrShow\\incoming">
    </label>
    <div class="ytdp-count">0 selected</div>
    <ol class="ytdp-list"></ol>
    <div class="ytdp-actions">
      <button type="button" class="ytdp-send">Send queue</button>
      <button type="button" class="ytdp-cancel">Cancel</button>
    </div>
    <p class="ytdp-message"></p>
  `;

  panel.querySelector(".ytdp-close").addEventListener("click", exitSelectionMode);
  panel.querySelector(".ytdp-cancel").addEventListener("click", exitSelectionMode);
  panel.querySelector(".ytdp-send").addEventListener("click", sendQueue);
  document.documentElement.appendChild(panel);

  getSavedOutputDir().then((outputDir) => {
    const input = panel?.querySelector(".ytdp-output");
    if (input && !input.value) input.value = outputDir;
  });

  return panel;
}

function renderPanel() {
  ensurePanel();

  const videos = Array.from(selectedVideos.values());
  panel.querySelector(".ytdp-count").textContent = `${videos.length} selected`;

  const list = panel.querySelector(".ytdp-list");
  list.replaceChildren(
    ...videos.slice(0, 8).map((video) => {
      const item = document.createElement("li");
      item.textContent = video.title;
      return item;
    })
  );

  if (videos.length > 8) {
    const item = document.createElement("li");
    item.textContent = `+ ${videos.length - 8} more`;
    list.appendChild(item);
  }

  panel.querySelector(".ytdp-send").disabled = videos.length === 0;
}

function setPanelMessage(text, isError = false) {
  const message = panel?.querySelector(".ytdp-message");
  if (!message) return;
  message.textContent = text;
  message.classList.toggle("error", isError);
}

function enterSelectionMode(initialTarget) {
  removeHoverButton();
  selectionMode = true;
  document.documentElement.classList.add("ytdp-selection-mode");

  if (initialTarget?.url) {
    selectedVideos.set(initialTarget.url, {
      url: initialTarget.url,
      title: initialTarget.title || "YouTube video"
    });
  }

  ensurePanel();
  renderSelectionMarks();
  renderPanel();
}

function exitSelectionMode() {
  selectionMode = false;
  selectedVideos.clear();
  panel?.remove();
  panel = null;
  document.documentElement.classList.remove("ytdp-selection-mode");
  renderSelectionMarks();
}

async function sendQueue() {
  const videos = Array.from(selectedVideos.values());
  if (!videos.length) return;

  const outputInput = panel.querySelector(".ytdp-output");
  const outputDir = outputInput.value.trim();
  await saveOutputDir(outputDir);

  const sendButton = panel.querySelector(".ytdp-send");
  sendButton.disabled = true;
  setPanelMessage(`Sending ${videos.length} job${videos.length === 1 ? "" : "s"}...`);

  chrome.runtime.sendMessage(
    {
      type: "createJobs",
      urls: videos.map((video) => video.url),
      outputDir
    },
    (response) => {
      if (chrome.runtime.lastError) {
        setPanelMessage(chrome.runtime.lastError.message, true);
        sendButton.disabled = false;
        return;
      }

      if (!response?.ok) {
        setPanelMessage(response?.error || "Failed to send queue.", true);
        sendButton.disabled = false;
        return;
      }

      setPanelMessage(`Queued ${response.jobs.length} job${response.jobs.length === 1 ? "" : "s"}.`);
      setTimeout(exitSelectionMode, 1200);
    }
  );
}

function onDocumentClick(event) {
  if (!selectionMode) return;
  if (panel?.contains(event.target)) return;

  const anchor = videoAnchorFromEvent(event);
  if (!anchor) return;

  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  toggleVideo(anchor);
}

window.addEventListener("scroll", positionHoverButton, true);
window.addEventListener("resize", positionHoverButton);
document.addEventListener("mouseover", onMouseOver, true);
document.addEventListener("mouseout", onMouseOut, true);
document.addEventListener("click", onDocumentClick, true);
