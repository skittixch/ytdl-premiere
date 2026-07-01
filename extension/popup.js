const API_BASE = "http://127.0.0.1:8787";

const serviceState = document.getElementById("serviceState");
const urlInput = document.getElementById("urlInput");
const outputInput = document.getElementById("outputInput");
const submitButton = document.getElementById("submitButton");
const jobPanel = document.getElementById("jobPanel");
const jobStatus = document.getElementById("jobStatus");
const jobStep = document.getElementById("jobStep");
const jobOutput = document.getElementById("jobOutput");
const message = document.getElementById("message");

let pollTimer = null;

function setMessage(text, isError = false) {
  message.textContent = text || "";
  message.classList.toggle("error", isError);
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

async function loadCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url) {
    urlInput.value = tab.url;
  }
}

async function loadSavedOutputDir() {
  const saved = await chrome.storage.local.get(["outputDir"]);
  if (saved.outputDir) {
    outputInput.value = saved.outputDir;
  }
}

async function checkService() {
  try {
    const health = await fetchJson(`${API_BASE}/health`);
    setServiceState("Ready", "ok");
    const root = health.host_output_root || health.output_root;
    setMessage(`Root: ${root}`);
    submitButton.disabled = false;
  } catch (error) {
    setServiceState("Offline", "fail");
    setMessage("Start the local service, then reopen this popup.", true);
    submitButton.disabled = true;
  }
}

function renderJob(job) {
  jobPanel.hidden = false;
  jobStatus.textContent = job.status;
  jobStep.textContent = job.step;

  if (job.status === "done") {
    jobOutput.textContent = job.premiere_path ? `Premiere file: ${job.premiere_path}` : "Done.";
    submitButton.disabled = false;
  } else if (job.status === "failed") {
    jobOutput.textContent = job.error || "Failed.";
    setMessage(job.error || "Download failed.", true);
    submitButton.disabled = false;
  } else {
    jobOutput.textContent = job.source_path ? `Source: ${job.source_path}` : "";
  }
}

async function pollJob(jobId) {
  try {
    const job = await fetchJson(`${API_BASE}/api/jobs/${jobId}`);
    renderJob(job);
    if (job.status === "done" || job.status === "failed") {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  } catch (error) {
    clearInterval(pollTimer);
    pollTimer = null;
    setMessage(error.message, true);
    submitButton.disabled = false;
  }
}

async function createJob() {
  const url = urlInput.value.trim();
  const outputDir = outputInput.value.trim();
  if (!url) {
    setMessage("Enter a URL.", true);
    return;
  }

  if (outputDir) {
    await chrome.storage.local.set({ outputDir });
  }

  submitButton.disabled = true;
  setMessage("");
  jobPanel.hidden = false;
  jobStatus.textContent = "queued";
  jobStep.textContent = "starting";
  jobOutput.textContent = "";

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

    renderJob(job);
    pollTimer = setInterval(() => pollJob(job.id), 1500);
    await pollJob(job.id);
  } catch (error) {
    setMessage(error.message, true);
    submitButton.disabled = false;
  }
}

submitButton.addEventListener("click", createJob);

loadCurrentTab();
loadSavedOutputDir();
checkService();
