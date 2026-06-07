const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const chromeCandidates = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];
const chrome = chromeCandidates.find(fs.existsSync);
if (!chrome) throw new Error("Google Chrome was not found.");

const port = 9333;
const profile = path.join(os.tmpdir(), `gimmick-smoke-${Date.now()}`);
const browser = spawn(chrome, [
  "--headless=new",
  "--disable-gpu",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--no-first-run",
  "--no-default-browser-check",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getPage() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
      const page = pages.find((entry) => entry.type === "page");
      if (page) return page;
    } catch {
      // Chrome is still starting.
    }
    await sleep(100);
  }
  throw new Error("Chrome DevTools endpoint did not start.");
}

async function run() {
  const page = await getPage();
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let commandId = 0;
  const exceptions = [];

  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    }
    if (message.method === "Runtime.exceptionThrown") {
      exceptions.push(message.params.exceptionDetails.text);
    }
  };
  await new Promise((resolve) => {
    socket.onopen = resolve;
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++commandId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.navigate", {
    url: "http://127.0.0.1:4173/?autoplay=1&speed=20&role=MT",
  });
  await sleep(2200);
  if (process.env.SMOKE_SCREENSHOT) {
    const screenshot = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(process.env.SMOKE_SCREENSHOT, Buffer.from(screenshot.data, "base64"));
  }
  await sleep(5300);

  const result = await send("Runtime.evaluate", {
    expression: `JSON.stringify({
      hidden: document.getElementById("resultModal").classList.contains("hidden"),
      title: document.getElementById("resultTitle").textContent,
      reason: document.getElementById("resultReason").textContent,
      time: document.getElementById("timeDisplay").textContent
    })`,
    returnByValue: true,
  });
  const status = JSON.parse(result.result.value);

  if (exceptions.length) throw new Error(`Browser exceptions: ${exceptions.join(", ")}`);
  if (status.hidden || status.title !== "ミッシング突破") {
    throw new Error(`Simulation did not clear: ${JSON.stringify(status)}`);
  }

  await send("Page.navigate", { url: "http://127.0.0.1:4173/?speed=20" });
  await sleep(300);
  await send("Runtime.evaluate", {
    expression: `document.querySelector(".role-button").click()`,
  });
  await sleep(1500);
  const failureResult = await send("Runtime.evaluate", {
    expression: `JSON.stringify({
      hidden: document.getElementById("resultModal").classList.contains("hidden"),
      title: document.getElementById("resultTitle").textContent,
      reason: document.getElementById("resultReason").textContent
    })`,
    returnByValue: true,
  });
  const failureStatus = JSON.parse(failureResult.result.value);
  socket.close();
  if (failureStatus.hidden || failureStatus.title !== "GAME OVER") {
    throw new Error(`Failure state was not triggered: ${JSON.stringify(failureStatus)}`);
  }
  console.log(`Browser smoke test passed at ${status.time}: ${status.reason}`);
  console.log(`Failure check passed: ${failureStatus.reason}`);
}

run()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    browser.kill();
    await sleep(100);
    fs.rmSync(profile, { recursive: true, force: true });
  });
