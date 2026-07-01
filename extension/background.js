const API_BASE = "http://127.0.0.1:8787";

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
      .then((jobs) => sendResponse({ ok: true, jobs }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});
