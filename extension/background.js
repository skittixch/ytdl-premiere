const API_BASE = "http://127.0.0.1:8787";
const WATCHED_JOBS_KEY = "watchedJobs";
const POLL_ALARM = "pollWatchedJobs";

async function fetchJson(path, options) {
  const response = await fetch(`${API_BASE}${path}`, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.detail || `HTTP ${response.status}`);
  }
  return body;
}

async function createJob(url, outputDir, browserTitle) {
  return fetchJson("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      browser_title: browserTitle || null,
      output_dir: outputDir || null
    })
  });
}

function storageGet(keys) {
  return chrome.storage.local.get(keys);
}

function storageSet(values) {
  return chrome.storage.local.set(values);
}

async function notificationsEnabled() {
  const saved = await storageGet(["notifyOnComplete"]);
  if (!saved.notifyOnComplete) return false;

  if (!chrome.permissions?.contains) return true;
  return chrome.permissions.contains({ permissions: ["notifications"] });
}

async function showJobNotification(job) {
  if (!(await notificationsEnabled())) return;

  const succeeded = job.status === "done";
  const title = succeeded ? "YTDL Premiere complete" : "YTDL Premiere failed";
  const label = job.title || job.browser_title || job.url;
  const body = succeeded
    ? `${label}\n${job.premiere_path || "Premiere file created."}`
    : `${label}\n${job.error || "The job failed."}`;

  if (self.registration?.showNotification) {
    await self.registration.showNotification(title, {
      body,
      tag: `ytdl-premiere-${job.id}`,
      renotify: false
    });
  }
}

async function ensurePollAlarm() {
  const saved = await storageGet([WATCHED_JOBS_KEY]);
  const watchedJobs = saved[WATCHED_JOBS_KEY] || {};

  if (Object.keys(watchedJobs).length === 0) {
    await chrome.alarms.clear(POLL_ALARM);
    return;
  }

  chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 });
}

async function watchJobs(jobIds) {
  const ids = Array.from(new Set(jobIds || [])).filter(Boolean);
  if (ids.length === 0) return;

  const saved = await storageGet([WATCHED_JOBS_KEY]);
  const watchedJobs = saved[WATCHED_JOBS_KEY] || {};
  const now = Date.now();

  ids.forEach((id) => {
    watchedJobs[id] = watchedJobs[id] || { id, createdAt: now };
  });

  await storageSet({ [WATCHED_JOBS_KEY]: watchedJobs });
  await ensurePollAlarm();
}

async function pollWatchedJobs() {
  const saved = await storageGet([WATCHED_JOBS_KEY]);
  const watchedJobs = saved[WATCHED_JOBS_KEY] || {};
  const ids = Object.keys(watchedJobs);

  if (ids.length === 0) {
    await ensurePollAlarm();
    return;
  }

  await Promise.all(
    ids.map(async (id) => {
      try {
        const job = await fetchJson(`/api/jobs/${id}`);
        if (job.status === "done" || job.status === "failed") {
          await showJobNotification(job);
          delete watchedJobs[id];
        }
      } catch (error) {
        if ((watchedJobs[id].errors || 0) >= 3) {
          delete watchedJobs[id];
        } else {
          watchedJobs[id].errors = (watchedJobs[id].errors || 0) + 1;
        }
      }
    })
  );

  await storageSet({ [WATCHED_JOBS_KEY]: watchedJobs });
  await ensurePollAlarm();
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) {
    pollWatchedJobs();
  }
});

chrome.runtime.onStartup.addListener(ensurePollAlarm);
chrome.runtime.onInstalled.addListener(ensurePollAlarm);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "health") {
    fetchJson("/health")
      .then((health) => sendResponse({ ok: true, health }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "createJobs") {
    const urls = Array.from(new Set(message.urls || []));
    const outputDir = message.outputDir || "";
    const title = sender.tab?.title || message.browserTitle || "";

    Promise.all(urls.map((url) => createJob(url, outputDir, title)))
      .then(async (jobs) => {
        await watchJobs(jobs.map((job) => job.id));
        sendResponse({ ok: true, jobs });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "watchJobs") {
    watchJobs(message.jobIds)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});
