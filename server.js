const express = require("express");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const WebSocket = require("ws");
const http = require("http");

puppeteer.use(StealthPlugin());

const PORT = process.env.PORT || 4000;
const GROK_URL = "https://grok.com/imagine";
const PROFILE_DIR = process.env.CHROME_PROFILE_DIR || "./.chrome-profile";

async function start() {
  console.log("Launching browser...");
  const launchOpts = {
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-zygote",
      "--single-process",
      "--disable-blink-features=AutomationControlled",
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

  console.log(`Chrome profile: ${PROFILE_DIR}`);
  console.log("Navigating to Grok Imagine...");
  await page.goto(GROK_URL, { waitUntil: "networkidle2", timeout: 60000 });
  console.log(`Page title: ${await page.title()}`);
  console.log(`URL: ${page.url()}`);

  // Create CDP session for high-performance screencast
  const cdp = await page.createCDPSession();

  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server });

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
    #screen {
      width: 100vw;
      height: 100vh;
      display: block;
      object-fit: contain;
      background: #0a0a0a;
    }
    #status {
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
      color: #666; font-family: system-ui; font-size: 14px; z-index: 10;
    }
  </style>
</head>
<body>
  <div id="status">Connecting...</div>
  <img id="screen" alt="">
  <script>
    const img = document.getElementById('screen');
    const status = document.getElementById('status');
    let ws, connected = false;
    let currentBlob = null;

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
        if (e.data instanceof ArrayBuffer) {
          if (currentBlob) URL.revokeObjectURL(currentBlob);
          const blob = new Blob([e.data], { type: 'image/jpeg' });
          currentBlob = URL.createObjectURL(blob);
          img.src = currentBlob;
        }
      };

      ws.onclose = () => {
        connected = false;
        status.textContent = 'Reconnecting...';
        status.style.display = 'block';
        setTimeout(connect, 1500);
      };
    }

    function getCoords(e) {
      const rect = img.getBoundingClientRect();
      // Account for object-fit: contain
      const imgAspect = img.naturalWidth / img.naturalHeight;
      const boxAspect = rect.width / rect.height;
      let renderW, renderH, offsetX, offsetY;
      if (imgAspect > boxAspect) {
        renderW = rect.width;
        renderH = rect.width / imgAspect;
        offsetX = 0;
        offsetY = (rect.height - renderH) / 2;
      } else {
        renderH = rect.height;
        renderW = rect.height * imgAspect;
        offsetX = (rect.width - renderW) / 2;
        offsetY = 0;
      }
      const x = Math.round(((e.clientX - rect.left - offsetX) / renderW) * img.naturalWidth);
      const y = Math.round(((e.clientY - rect.top - offsetY) / renderH) * img.naturalHeight);
      return { x: Math.max(0, x), y: Math.max(0, y) };
    }

    img.addEventListener('click', (e) => {
      if (!connected) return;
      ws.send(JSON.stringify({ type: 'click', ...getCoords(e) }));
    });
    img.addEventListener('mousemove', (e) => {
      if (!connected) return;
      ws.send(JSON.stringify({ type: 'mousemove', ...getCoords(e) }));
    });
    img.addEventListener('mousedown', (e) => {
      if (!connected) return;
      ws.send(JSON.stringify({ type: 'mousedown', ...getCoords(e), button: e.button }));
    });
    img.addEventListener('mouseup', (e) => {
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

    img.addEventListener('wheel', (e) => {
      if (!connected) return;
      e.preventDefault();
      ws.send(JSON.stringify({ type: 'scroll', deltaX: e.deltaX, deltaY: e.deltaY }));
    }, { passive: false });

    window.addEventListener('resize', () => {
      if (!connected) return;
      ws.send(JSON.stringify({ type: 'resize', width: window.innerWidth, height: window.innerHeight }));
    });

    // Prevent default drag on the img
    img.addEventListener('dragstart', (e) => e.preventDefault());

    connect();
  </script>
</body>
</html>`);
  });

  // Track active clients for frame broadcasting
  const clients = new Set();

  // Use CDP screencast for high-performance frame delivery
  cdp.on("Page.screencastFrame", async ({ data, sessionId }) => {
    // ACK immediately so Chrome sends the next frame
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    const buf = Buffer.from(data, "base64");
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(buf, { binary: true });
      }
    }
  });

  async function startScreencast(width, height) {
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 85,
      maxWidth: width || 1280,
      maxHeight: height || 800,
      everyNthFrame: 1,
    });
  }

  await startScreencast(1280, 800);
  console.log("Screencast started");

  wss.on("connection", (ws) => {
    console.log("Client connected");
    clients.add(ws);

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
              await cdp.send("Page.stopScreencast");
              await startScreencast(msg.width, msg.height);
            }
            break;
        }
      } catch (err) {
        // ignore input errors during navigation
      }
    });

    ws.on("close", () => {
      clients.delete(ws);
      console.log("Client disconnected");
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
