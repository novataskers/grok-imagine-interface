const express = require("express");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const WebSocket = require("ws");
const http = require("http");

puppeteer.use(StealthPlugin());

const PORT = process.env.PORT || 4000;
const GROK_URL = "https://grok.com/imagine";

// Cookies from the user's session
const COOKIES_STRING = process.env.GROK_COOKIES || "";

function parseCookies(cookieStr) {
  if (!cookieStr) return [];
  return cookieStr.split(";").map((c) => {
    const [name, ...rest] = c.trim().split("=");
    return {
      name: name.trim(),
      value: rest.join("=").trim(),
      domain: ".grok.com",
      path: "/",
    };
  });
}

async function start() {
  console.log("Launching browser...");
  const launchOpts = {
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-zygote",
      "--single-process",
    ],
    userDataDir: "./.chrome-profile",
  };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  const browser = await puppeteer.launch(launchOpts);

  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setUserAgent(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  );

  // Set cookies if provided
  const cookies = parseCookies(COOKIES_STRING);
  if (cookies.length > 0) {
    await page.setCookie(...cookies);
    console.log(`Set ${cookies.length} cookies`);
  }

  console.log("Navigating to Grok Imagine...");
  await page.goto(GROK_URL, { waitUntil: "networkidle2", timeout: 60000 });

  const title = await page.title();
  console.log(`Page title: ${title}`);

  // Check if logged in
  const url = page.url();
  console.log(`Current URL: ${url}`);
  if (title.includes("Imagine")) {
    console.log("Logged in!");
  } else {
    console.log("Not logged in or blocked by Cloudflare");
  }

  // Express app serves a page that shows live screenshots via WebSocket
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
    body { background: #000; overflow: hidden; width: 100vw; height: 100vh; }
    canvas {
      width: 100vw;
      height: 100vh;
      display: block;
      cursor: default;
      image-rendering: auto;
    }
    #status {
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
      color: #888; font-family: system-ui; font-size: 16px; z-index: 10;
    }
  </style>
</head>
<body>
  <div id="status">Connecting...</div>
  <canvas id="screen"></canvas>
  <script>
    const canvas = document.getElementById('screen');
    const ctx = canvas.getContext('2d');
    const status = document.getElementById('status');
    let ws;
    let connected = false;

    function connect() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(proto + '://' + location.host);

      ws.onopen = () => {
        connected = true;
        status.style.display = 'none';
        // Request initial viewport size sync
        ws.send(JSON.stringify({ type: 'resize', width: window.innerWidth, height: window.innerHeight }));
      };

      ws.onmessage = (e) => {
        if (e.data instanceof Blob) {
          const img = new Image();
          img.onload = () => {
            canvas.width = img.width;
            canvas.height = img.height;
            ctx.drawImage(img, 0, 0);
            URL.revokeObjectURL(img.src);
          };
          img.src = URL.createObjectURL(e.data);
        }
      };

      ws.onclose = () => {
        connected = false;
        status.textContent = 'Reconnecting...';
        status.style.display = 'block';
        setTimeout(connect, 2000);
      };
    }

    // Scale mouse coordinates from canvas to viewport
    function scaleCoords(e) {
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      return {
        x: Math.round((e.clientX - rect.left) * scaleX),
        y: Math.round((e.clientY - rect.top) * scaleY)
      };
    }

    canvas.addEventListener('click', (e) => {
      if (!connected) return;
      const { x, y } = scaleCoords(e);
      ws.send(JSON.stringify({ type: 'click', x, y }));
    });

    canvas.addEventListener('mousemove', (e) => {
      if (!connected) return;
      const { x, y } = scaleCoords(e);
      ws.send(JSON.stringify({ type: 'mousemove', x, y }));
    });

    canvas.addEventListener('mousedown', (e) => {
      if (!connected) return;
      const { x, y } = scaleCoords(e);
      ws.send(JSON.stringify({ type: 'mousedown', x, y, button: e.button }));
    });

    canvas.addEventListener('mouseup', (e) => {
      if (!connected) return;
      const { x, y } = scaleCoords(e);
      ws.send(JSON.stringify({ type: 'mouseup', x, y, button: e.button }));
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

    canvas.addEventListener('wheel', (e) => {
      if (!connected) return;
      e.preventDefault();
      ws.send(JSON.stringify({ type: 'scroll', deltaX: e.deltaX, deltaY: e.deltaY }));
    }, { passive: false });

    window.addEventListener('resize', () => {
      if (!connected) return;
      ws.send(JSON.stringify({ type: 'resize', width: window.innerWidth, height: window.innerHeight }));
    });

    connect();
  </script>
</body>
</html>`);
  });

  // WebSocket handles input/output streaming
  wss.on("connection", (ws) => {
    console.log("Client connected");
    let streaming = true;

    // Screenshot loop
    const sendFrame = async () => {
      if (!streaming) return;
      try {
        const screenshot = await page.screenshot({
          type: "jpeg",
          quality: 80,
          encoding: "binary",
        });
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(screenshot, { binary: true });
        }
      } catch (err) {
        // page might be navigating
      }
      if (streaming) setTimeout(sendFrame, 100); // ~10fps
    };
    sendFrame();

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
            await page.setViewport({ width: msg.width, height: msg.height });
            break;
        }
      } catch (err) {
        // ignore input errors
      }
    });

    ws.on("close", () => {
      streaming = false;
      console.log("Client disconnected");
    });
  });

  server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

function mapKey(key) {
  const keyMap = {
    Enter: "Enter",
    Backspace: "Backspace",
    Tab: "Tab",
    Escape: "Escape",
    ArrowUp: "ArrowUp",
    ArrowDown: "ArrowDown",
    ArrowLeft: "ArrowLeft",
    ArrowRight: "ArrowRight",
    Delete: "Delete",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    " ": "Space",
    Control: "Control",
    Shift: "Shift",
    Alt: "Alt",
    Meta: "Meta",
  };
  return keyMap[key] || null;
}

start().catch(console.error);
