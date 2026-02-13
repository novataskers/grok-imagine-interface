const express = require("express");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const WebSocket = require("ws");
const http = require("http");

puppeteer.use(StealthPlugin());

const PORT = process.env.PORT || 4000;
const GROK_URL = "https://grok.com/imagine";
const PROFILE_DIR = process.env.CHROME_PROFILE_DIR || "./.chrome-profile";

// Pixels to crop from top of the Grok page (the "Imagine" header bar)
const CROP_TOP = 56;

async function start() {
  console.log("Launching browser...");
  const launchOpts = {
    headless: process.env.XVFB ? false : "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--disable-blink-features=AutomationControlled",
      "--window-size=1280,900",
    ],
    userDataDir: PROFILE_DIR,
  };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  const browser = await puppeteer.launch(launchOpts);
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.setUserAgent(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  );

  console.log("Navigating to Grok Imagine...");
  await page.goto(GROK_URL, { waitUntil: "networkidle2", timeout: 60000 });
  console.log(`Page title: ${await page.title()}`);

  const cdp = await page.target().createCDPSession();

  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server });

  app.get("/health", (req, res) => res.send("ok"));

  app.get("/", (req, res) => {
    res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Grok Imagine</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0a0a0a; overflow: hidden; width: 100vw; height: 100vh; }
    #crop {
      width: 100vw;
      height: 100vh;
      overflow: hidden;
      position: relative;
    }
    #screen {
      position: absolute;
      top: -${CROP_TOP}px;
      left: 0;
      width: 100vw;
      height: calc(100vh + ${CROP_TOP}px);
      display: block;
    }
    #status {
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
      color: #666; font-family: system-ui; font-size: 14px; z-index: 10;
    }
  </style>
</head>
<body>
  <div id="status">Connecting...</div>
  <div id="crop">
    <img id="screen" alt="">
  </div>
  <script>
    const img = document.getElementById('screen');
    const crop = document.getElementById('crop');
    const status = document.getElementById('status');
    const CROP_TOP = ${CROP_TOP};
    let ws, connected = false;

    function connect() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(proto + '://' + location.host);
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        connected = true;
        status.style.display = 'none';
        ws.send(JSON.stringify({ type: 'resize', width: window.innerWidth, height: window.innerHeight }));
      };

      ws.onmessage = (e) => {
        if (typeof e.data === 'string') return;
        const blob = new Blob([e.data], { type: 'image/jpeg' });
        const url = URL.createObjectURL(blob);
        img.onload = () => URL.revokeObjectURL(url);
        img.src = url;
      };

      ws.onclose = () => {
        connected = false;
        status.textContent = 'Reconnecting...';
        status.style.display = 'block';
        setTimeout(connect, 1500);
      };
    }

    function getCoords(e) {
      const rect = crop.getBoundingClientRect();
      // Map click position within the visible crop area to page coordinates
      const imgW = img.naturalWidth || 1280;
      const imgH = img.naturalHeight || 800;
      const scaleX = imgW / rect.width;
      const scaleY = imgH / rect.height;
      const x = Math.round((e.clientX - rect.left) * scaleX);
      const y = Math.round((e.clientY - rect.top) * scaleY);
      return { x: Math.max(0, x), y: Math.max(0, y) };
    }

    crop.addEventListener('click', (e) => {
      if (!connected) return;
      const c = getCoords(e);
      // The visible area starts at CROP_TOP, so no offset needed -
      // the scale already maps to the full image, and the top is shifted
      ws.send(JSON.stringify({ type: 'click', ...c }));
    });
    crop.addEventListener('mousemove', (e) => {
      if (!connected) return;
      ws.send(JSON.stringify({ type: 'mousemove', ...getCoords(e) }));
    });
    crop.addEventListener('mousedown', (e) => {
      if (!connected) return;
      ws.send(JSON.stringify({ type: 'mousedown', ...getCoords(e), button: e.button }));
    });
    crop.addEventListener('mouseup', (e) => {
      if (!connected) return;
      ws.send(JSON.stringify({ type: 'mouseup', ...getCoords(e), button: e.button }));
    });

    document.addEventListener('keydown', (e) => {
      if (!connected) return;
      e.preventDefault();
      ws.send(JSON.stringify({ type: 'keydown', key: e.key, code: e.code, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey }));
    });
    document.addEventListener('keyup', (e) => {
      if (!connected) return;
      ws.send(JSON.stringify({ type: 'keyup', key: e.key, code: e.code }));
    });

    crop.addEventListener('wheel', (e) => {
      if (!connected) return;
      e.preventDefault();
      ws.send(JSON.stringify({ type: 'scroll', deltaX: e.deltaX, deltaY: e.deltaY }));
    }, { passive: false });

    window.addEventListener('resize', () => {
      if (!connected) return;
      ws.send(JSON.stringify({ type: 'resize', width: window.innerWidth, height: window.innerHeight }));
    });

    img.addEventListener('dragstart', (e) => e.preventDefault());
    connect();
  </script>
</body>
</html>`);
  });

  const clients = new Set();
  let screencastRunning = false;

  async function startScreencast() {
    if (screencastRunning) return;
    screencastRunning = true;
    cdp.on("Page.screencastFrame", async (frame) => {
      const buf = Buffer.from(frame.data, "base64");
      for (const c of clients) {
        if (c.readyState === WebSocket.OPEN) c.send(buf);
      }
      try { await cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }); } catch {}
    });
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 75,
      maxWidth: 1280,
      maxHeight: 800,
    });
  }

  async function stopScreencast() {
    if (!screencastRunning) return;
    try { await cdp.send("Page.stopScreencast"); } catch {}
    screencastRunning = false;
  }

  wss.on("connection", (ws) => {
    console.log("Client connected");
    clients.add(ws);
    startScreencast();

    ws.on("message", async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        switch (msg.type) {
          case "click":
            await page.mouse.click(msg.x, msg.y);
            break;
          case "mousemove":
            await page.mouse.move(msg.x, msg.y);
            break;
          case "mousedown":
            await page.mouse.down({ button: msg.button === 2 ? "right" : "left" });
            break;
          case "mouseup":
            await page.mouse.up({ button: msg.button === 2 ? "right" : "left" });
            break;
          case "keydown":
            if (msg.key.length === 1) {
              await page.keyboard.type(msg.key);
            } else {
              const key = mapKey(msg.key);
              if (key) await page.keyboard.press(key);
            }
            break;
          case "scroll":
            await page.mouse.wheel({ deltaX: msg.deltaX, deltaY: msg.deltaY });
            break;
          case "resize":
            if (msg.width > 0 && msg.height > 0) {
              await page.setViewport({ width: msg.width, height: msg.height });
              if (screencastRunning) {
                await stopScreencast();
                await startScreencast();
              }
            }
            break;
        }
      } catch (err) {}
    });

    ws.on("close", () => {
      clients.delete(ws);
      console.log("Client disconnected");
      if (clients.size === 0) stopScreencast();
    });
  });

  server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

function mapKey(key) {
  const m = {
    Enter: "Enter", Backspace: "Backspace", Tab: "Tab", Escape: "Escape",
    ArrowUp: "ArrowUp", ArrowDown: "ArrowDown", ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight",
    Delete: "Delete", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
    " ": "Space", Control: "Control", Shift: "Shift", Alt: "Alt", Meta: "Meta",
  };
  return m[key] || null;
}

start().catch(console.error);
