const API_BASE = "http://127.0.0.1:8787";

const serviceState = document.getElementById("serviceState");
const urlInput = document.getElementById("urlInput");
const urlHint = document.getElementById("urlHint");
const outputInput = document.getElementById("outputInput");
const notifyInput = document.getElementById("notifyInput");
const submitButton = document.getElementById("submitButton");
const jobList = document.getElementById("jobList");
const message = document.getElementById("message");

let jobsPollTimer = null;

function setMessage(text, isError = false) {
  message.textContent = text || "";
  message.classList.toggle("error", isError);
}

function setUrlHint(text, isError = false) {
  urlHint.textContent = text || "";
  urlHint.classList.toggle("error", isError);
}

function setServiceState(text, state) {
  serviceState.textContent = text;
  serviceState.classList.remove("ok", "fail");
  if (state) serviceState.classList.add(state);
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.detail || `HTTP ${response.status}`);
  }
  return body;
}

function normalizeVideoUrl(rawUrl, depth = 0) {
  if (!rawUrl || depth > 2) return null;

  let url;
  try {
    url = new URL(rawUrl.trim(), "https://www.youtube.com");
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  const nestedKeys = ["url", "q", "u"];

  if (host === "google.com" || host.endsWith(".google.com") || host === "youtube.com") {
    for (const key of nestedKeys) {
      const nested = url.searchParams.get(key);
      const normalized = normalizeVideoUrl(nested, depth + 1);
      if (normalized) return normalized;
    }
  }

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

function isGooglePageUrl(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === "google.com" || host.endsWith(".google.com");
  } catch {
    return false;
  }
}

function prepareSubmittedUrl(rawUrl) {
  const trimmed = rawUrl.trim();
  const normalized = normalizeVideoUrl(trimmed);
  if (normalized) return normalized;

  if (isGooglePageUrl(trimmed)) {
    throw new Error("That is a Google page URL. Open, copy, or paste the actual YouTube video URL.");
  }

  return trimmed;
}

function collectVideoCandidatesFromPage() {
  const candidates = [];
  const selectedText = window.getSelection?.().toString().trim();
  if (selectedText) {
    candidates.push({ href: selectedText, label: "selected text", source: "selection", score: 0 });
  }

  const activeLink = document.activeElement?.closest?.("a[href]");
  if (activeLink) {
    candidates.push({
      href: activeLink.href,
      label: activeLink.textContent?.replace(/\s+/g, " ").trim() || activeLink.href,
      source: "focused link",
      score: 1
    });
  }

  Array.from(document.querySelectorAll("a[href]")).forEach((anchor, index) => {
    const href = anchor.href || anchor.getAttribute("href") || "";
    if (!/youtu\.be|youtube\.com/i.test(href)) return;

    const rect = anchor.getBoundingClientRect();
    const visible =
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom >= 0 &&
      rect.right >= 0 &&
      rect.top <= window.innerHeight &&
      rect.left <= window.innerWidth;

    candidates.push({
      href,
      label:
        anchor.getAttribute("aria-label") ||
        anchor.getAttribute("title") ||
        anchor.textContent?.replace(/\s+/g, " ").trim() ||
        href,
      source: visible ? "visible page link" : "page link",
      score: visible ? 10 + Math.max(0, rect.top) + index / 1000 : 10000 + index
    });
  });

  return candidates.slice(0, 80);
}

async function detectYouTubeUrlFromPage(tabId) {
  if (!tabId || !chrome.scripting?.executeScript) return null;

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: collectVideoCandidatesFromPage
    });
    const candidates = results?.[0]?.result || [];
    const seen = new Set();

    return candidates
      .map((candidate) => ({
        ...candidate,
        url: normalizeVideoUrl(candidate.href)
      }))
      .filter((candidate) => candidate.url && !seen.has(candidate.url) && seen.add(candidate.url))
      .sort((a, b) => a.score - b.score)[0] || null;
  } catch {
    return null;
  }
}

async function loadCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const normalized = normalizeVideoUrl(tab?.url || "");

  if (normalized) {
    urlInput.value = normalized;
    setUrlHint("Using the current YouTube video URL.");
    return;
  }

  const detected = await detectYouTubeUrlFromPage(tab?.id);
  if (detected?.url) {
    urlInput.value = detected.url;
    setUrlHint(`Detected YouTube URL from ${detected.source}.`);
    return;
  }

  urlInput.value = "";
  setUrlHint("No YouTube video URL detected on this page. Paste the video URL.", true);
}

async function loadSavedSettings() {
  const saved = await chrome.storage.local.get(["outputDir", "notifyOnComplete"]);
  if (saved.outputDir) {
    outputInput.value = saved.outputDir;
  }
  notifyInput.checked = Boolean(saved.notifyOnComplete);
}

async function setNotificationPreference(enabled) {
  if (!enabled) {
    await chrome.storage.local.set({ notifyOnComplete: false });
    notifyInput.checked = false;
    return;
  }

  if (!chrome.permissions?.request) {
    await chrome.storage.local.set({ notifyOnComplete: true });
    notifyInput.checked = true;
    return;
  }

  const granted = await chrome.permissions.request({ permissions: ["notifications"] });
  await chrome.storage.local.set({ notifyOnComplete: granted });
  notifyInput.checked = granted;

  if (!granted) {
    setMessage("Notifications were not enabled.", true);
  }
}

function statusLabel(job) {
  if (job.status === "done") return "Done";
  if (job.status === "failed") return "Failed";
  if (job.status === "running") return "Running";
  return "Queued";
}

function clampProgress(value) {
  const progress = Number(value);
  if (!Number.isFinite(progress)) return 0;
  return Math.max(0, Math.min(100, progress));
}

function jobTitle(job) {
  return job.title || job.browser_title || job.url;
}

function renderJobList(jobs) {
  jobList.replaceChildren();

  if (!jobs.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No jobs yet.";
    jobList.appendChild(empty);
    return;
  }

  jobs.slice(0, 8).forEach((job) => {
    const progress = clampProgress(job.progress);
    const item = document.createElement("article");
    item.className = `job ${job.status}`;

    const header = document.createElement("div");
    header.className = "jobHeader";

    const title = document.createElement("strong");
    title.className = "jobTitle";
    title.textContent = jobTitle(job);

    const status = document.createElement("span");
    status.className = "jobStatus";
    status.textContent = `${statusLabel(job)} ${Math.round(progress)}%`;

    header.append(title, status);

    const bar = document.createElement("div");
    bar.className = "progress";
    bar.setAttribute("aria-label", `${statusLabel(job)} ${Math.round(progress)} percent`);

    const fill = document.createElement("span");
    fill.style.width = `${progress}%`;
    bar.appendChild(fill);

    const meta = document.createElement("p");
    meta.className = "jobMeta";
    meta.textContent = job.step || job.status;

    const detail = document.createElement("p");
    detail.className = "jobDetail";
    if (job.status === "done") {
      detail.textContent = job.premiere_path ? `Premiere: ${job.premiere_path}` : "Premiere file created.";
    } else if (job.status === "failed") {
      detail.textContent = job.error || "Job failed.";
    } else if (job.output_dir) {
      detail.textContent = `Output: ${job.output_dir}`;
    }

    item.append(header, bar, meta);
    if (detail.textContent) item.appendChild(detail);
    jobList.appendChild(item);
  });
}

async function loadJobs() {
  const jobs = await fetchJson(`${API_BASE}/api/jobs`);
  renderJobList(jobs);
  return jobs;
}

function startJobPolling() {
  if (jobsPollTimer) return;
  jobsPollTimer = setInterval(() => {
    loadJobs().catch(() => {
      clearInterval(jobsPollTimer);
      jobsPollTimer = null;
    });
  }, 1500);
}

async function checkService() {
  try {
    const health = await fetchJson(`${API_BASE}/health`);
    setServiceState("Ready", "ok");
    const root = health.host_output_root || health.output_root;
    setMessage(`Root: ${root}`);
    submitButton.disabled = false;
    await loadJobs();
    startJobPolling();
  } catch (error) {
    setServiceState("Offline", "fail");
    setMessage("Start the local service, then reopen this popup.", true);
    submitButton.disabled = true;
  }
}

async function watchJob(jobId) {
  try {
    await chrome.runtime.sendMessage({ type: "watchJobs", jobIds: [jobId] });
  } catch {
    // The popup still polls while open; background watch is only for notifications.
  }
}

async function createJob() {
  const outputDir = outputInput.value.trim();
  let url;

  try {
    url = prepareSubmittedUrl(urlInput.value);
  } catch (error) {
    setMessage(error.message, true);
    return;
  }

  if (!url) {
    setMessage("Enter a URL.", true);
    return;
  }

  if (outputDir) {
    await chrome.storage.local.set({ outputDir });
  }

  submitButton.disabled = true;
  setMessage("");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const job = await fetchJson(`${API_BASE}/api/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        browser_title: tab?.title || null,
        output_dir: outputDir || null
      })
    });

    urlInput.value = url;
    await watchJob(job.id);
    await loadJobs();
    startJobPolling();
    setMessage("Queued.");
  } catch (error) {
    setMessage(error.message, true);
  } finally {
    submitButton.disabled = false;
  }
}

submitButton.addEventListener("click", createJob);
notifyInput.addEventListener("change", () => {
  setNotificationPreference(notifyInput.checked).catch((error) => {
    setMessage(error.message, true);
    notifyInput.checked = false;
  });
});

loadSavedSettings();
loadCurrentTab();
checkService();
