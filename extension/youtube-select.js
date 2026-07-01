(() => {
  if (window.__ytdlPremiereBatchSelector?.loaded) {
    window.__ytdlPremiereBatchSelector.refreshBatchMode();
    return;
  }

  const HOVER_DELAY_MS = 650;
  const VIDEO_LINK_SELECTOR =
    'a[href*="/watch?"], a[href^="/watch?"], a[href*="youtu.be/"], a[href*="/shorts/"], a[href*="/live/"]';

  let batchModeEnabled = false;
  let hoverTimer = null;
  let pendingAnchor = null;
  let hoverTarget = null;
  let hoverButton = null;
  let selectionMode = false;
  let selectedVideos = new Map();
  let selectionBadges = new Map();
  let badgeRefreshFrame = null;
  let badgeObserver = null;
  let panel = null;

  function normalizeYouTubeUrl(rawUrl) {
    let url;
    try {
      url = new URL(rawUrl, window.location.origin);
    } catch {
      return null;
    }

    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    if (host === "youtu.be") {
      const videoId = url.pathname.split("/").filter(Boolean)[0];
      return videoId ? `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}` : null;
    }

    if (host !== "youtube.com" && host !== "m.youtube.com") {
      return null;
    }

    if (url.pathname === "/watch") {
      const videoId = url.searchParams.get("v");
      return videoId ? `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}` : null;
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
      anchor
        .closest(
          "ytd-rich-grid-media, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer"
        )
        ?.textContent ||
      anchor.textContent ||
      "YouTube video";

    return title.replace(/\s+/g, " ").trim().slice(0, 140) || "YouTube video";
  }

  function visualTargetForAnchor(anchor) {
    return (
      anchor.closest(
        "ytd-thumbnail, ytd-rich-grid-media, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer"
      ) || anchor
    );
  }

  function visibleRectForElement(element) {
    if (!element?.isConnected) return null;

    const rect = element.getBoundingClientRect();
    if (
      rect.width < 24 ||
      rect.height < 24 ||
      rect.bottom <= 0 ||
      rect.right <= 0 ||
      rect.top >= window.innerHeight ||
      rect.left >= window.innerWidth
    ) {
      return null;
    }

    return rect;
  }

  function currentVideoTargets() {
    const seen = new Set();
    const targets = [];

    document.querySelectorAll(VIDEO_LINK_SELECTOR).forEach((anchor) => {
      const url = normalizeYouTubeUrl(anchor.href);
      if (!url || seen.has(url)) return;

      const element = visualTargetForAnchor(anchor);
      const rect = visibleRectForElement(element);
      if (!rect) return;

      seen.add(url);
      targets.push({
        anchor,
        element,
        rect,
        url,
        title: titleFromAnchor(anchor)
      });
    });

    return targets;
  }

  function clearHoverTimer() {
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
  }

  function removeHoverButton() {
    clearHoverTimer();
    pendingAnchor = null;
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
    if (!url || !batchModeEnabled || selectionMode) return;

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
    hoverButton.textContent = "\u2713";
    hoverButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      enterSelectionMode(hoverTarget);
    });

    document.documentElement.appendChild(hoverButton);
    positionHoverButton();
  }

  function scheduleHover(anchor) {
    const url = normalizeYouTubeUrl(anchor.href);
    const pendingUrl = pendingAnchor ? normalizeYouTubeUrl(pendingAnchor.href) : null;
    const activeUrl = hoverTarget?.url || null;

    if (!url) {
      removeHoverButton();
      return;
    }

    if (url === pendingUrl || url === activeUrl) {
      positionHoverButton();
      return;
    }

    removeHoverButton();
    pendingAnchor = anchor;
    hoverTimer = setTimeout(() => {
      hoverTimer = null;
      if (pendingAnchor === anchor) {
        showHoverButton(anchor);
      }
    }, HOVER_DELAY_MS);
  }

  function onPointerMove(event) {
    if (!batchModeEnabled || selectionMode) return;
    if (hoverButton?.contains(event.target)) return;

    const anchor = videoAnchorFromEvent(event);
    if (!anchor) {
      removeHoverButton();
      return;
    }

    scheduleHover(anchor);
  }

  function containsNode(container, node) {
    return node instanceof Node && Boolean(container?.contains(node));
  }

  function onDocumentPointerLeave(event) {
    if (!hoverButton || !hoverTarget?.element) return;

    const leftHoverSurface =
      containsNode(hoverButton, event.target) || containsNode(hoverTarget.element, event.target);
    if (!leftHoverSurface) return;

    const enteredHoverSurface =
      containsNode(hoverButton, event.relatedTarget) ||
      containsNode(hoverTarget.element, event.relatedTarget);
    if (enteredHoverSurface) return;

    removeHoverButton();
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

  function toggleVideoTarget(target) {
    if (selectedVideos.has(target.url)) {
      selectedVideos.delete(target.url);
    } else {
      selectedVideos.set(target.url, {
        url: target.url,
        title: target.title
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

    renderSelectionBadges();
  }

  function removeSelectionBadges() {
    selectionBadges.forEach((button) => button.remove());
    selectionBadges.clear();
  }

  function renderSelectionBadges() {
    if (!selectionMode) {
      removeSelectionBadges();
      return;
    }

    const targets = currentVideoTargets();
    const activeUrls = new Set(targets.map((target) => target.url));

    selectionBadges.forEach((button, url) => {
      if (!activeUrls.has(url)) {
        button.remove();
        selectionBadges.delete(url);
      }
    });

    targets.forEach((target) => {
      let button = selectionBadges.get(target.url);
      const selected = selectedVideos.has(target.url);

      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.className = "ytdp-select-badge";
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          toggleVideoTarget(target);
        });
        selectionBadges.set(target.url, button);
        document.documentElement.appendChild(button);
      }

      button.classList.toggle("selected", selected);
      button.textContent = selected ? "\u2713" : "";
      button.title = selected ? "Remove from YTDL Premiere queue" : "Add to YTDL Premiere queue";
      button.setAttribute("aria-label", button.title);
      button.style.top = `${Math.max(8, target.rect.top + 8)}px`;
      button.style.left = `${Math.max(8, target.rect.right - 42)}px`;
    });
  }

  function scheduleSelectionBadgeRefresh() {
    if (!selectionMode || badgeRefreshFrame) return;

    badgeRefreshFrame = requestAnimationFrame(() => {
      badgeRefreshFrame = null;
      renderSelectionBadges();
    });
  }

  function startBadgeObserver() {
    if (badgeObserver) return;

    badgeObserver = new MutationObserver(scheduleSelectionBadgeRefresh);
    badgeObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  function stopBadgeObserver() {
    badgeObserver?.disconnect();
    badgeObserver = null;
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
        <button type="button" class="ytdp-close" title="Cancel selection">x</button>
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
    const panelMessage = panel?.querySelector(".ytdp-message");
    if (!panelMessage) return;
    panelMessage.textContent = text;
    panelMessage.classList.toggle("error", isError);
  }

  function enterSelectionMode(initialTarget) {
    if (!batchModeEnabled) return;

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
    startBadgeObserver();
  }

  function exitSelectionMode() {
    selectionMode = false;
    selectedVideos.clear();
    panel?.remove();
    panel = null;
    document.documentElement.classList.remove("ytdp-selection-mode");
    stopBadgeObserver();
    removeSelectionBadges();
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

  function setBatchMode(enabled) {
    batchModeEnabled = enabled;
    document.documentElement.classList.toggle("ytdp-batch-mode", enabled);

    if (!enabled) {
      removeHoverButton();
      exitSelectionMode();
    }
  }

  function refreshBatchMode() {
    chrome.storage.local.get(["batchMode"], (saved) => {
      setBatchMode(Boolean(saved.batchMode));
    });
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes.batchMode) {
      setBatchMode(Boolean(changes.batchMode.newValue));
    }
  });

  window.addEventListener("scroll", () => {
    positionHoverButton();
    scheduleSelectionBadgeRefresh();
  }, true);
  window.addEventListener("resize", () => {
    positionHoverButton();
    scheduleSelectionBadgeRefresh();
  });
  document.addEventListener("pointermove", onPointerMove, true);
  document.addEventListener("pointerleave", onDocumentPointerLeave, true);
  document.addEventListener("click", onDocumentClick, true);

  window.__ytdlPremiereBatchSelector = {
    loaded: true,
    refreshBatchMode
  };
  refreshBatchMode();
})();
