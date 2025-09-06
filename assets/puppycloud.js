// web/files.ts
function renderHome(root) {
  root.innerHTML = `
    <section class="card">
      <h2>This node</h2>
      <div class="muted">Peer ID:</div>
      <div id="peerId" class="mono" style="word-break: break-all;">…</div>
      <div class="muted" style="margin-top:10px">Listening addresses:</div>
      <ul id="addrs" class="mono"></ul>
    </section>

    <section class="card">
      <h2>Connect to peer</h2>
      <div class="row">
        <input id="addr" type="text" placeholder="/ip4/127.0.0.1/tcp/4001/p2p/12D3KooW…" />
        <button id="dialBtn">Dial</button>
        <button id="scanBtn">Scan QR</button>
      </div>
      <div id="status" class="muted" style="margin-top:10px"></div>
    </section>

    <section class="card">
      <h2>Create invite QR</h2>
      <div class="row">
        <input id="invitePwd" type="text" placeholder="Password" />
        <input id="inviteExp" type="number" placeholder="Minutes" style="max-width:80px" />
        <button id="inviteBtn">Generate</button>
      </div>
      <div class="row" id="inviteError"></div>
      <canvas id="inviteQr" style="margin-top:10px"></canvas>
    </section>
  `;
  const dialBtn = root.querySelector("#dialBtn");
  const scanBtn = root.querySelector("#scanBtn");
  const addrInput = root.querySelector("#addr");
  const status = root.querySelector("#status");
  dialBtn.onclick = () => dial(addrInput, status, dialBtn);
  scanBtn.onclick = () => {
    if (window.PC?.openQRScanner) {
      window.PC.openQRScanner((text) => {
        addrInput.value = parseQRText(text);
        dial(addrInput, status, dialBtn);
      });
    } else {
      status.textContent = "QR scanner unavailable.";
    }
  };
  const inviteBtn = root.querySelector("#inviteBtn");
  inviteBtn.onclick = () => createInvite();
  loadInfo(root);
}
function renderGallery(root) {
  root.innerHTML = `
    <section class="card">
      <h2>Gallery</h2>
      <div class="muted">Nothing here yet. Add items in a future update.</div>
    </section>
  `;
}
function parseQRText(text) {
  try {
    const obj = JSON.parse(text);
    if (obj.expires && Date.now() > obj.expires * 1000) {
      alert("Invite expired");
      return "";
    }
    return obj.addr || text;
  } catch {
    return text;
  }
}
async function loadInfo(root) {
  try {
    const r = await fetch("/p2p/info");
    const j = await r.json();
    const peerId = root.querySelector("#peerId");
    const ul = root.querySelector("#addrs");
    if (peerId)
      peerId.textContent = j.peer_id;
    if (ul) {
      ul.innerHTML = "";
      (j.addrs || []).forEach((a) => {
        const li = document.createElement("li");
        li.textContent = a;
        ul.appendChild(li);
      });
    }
  } catch (e) {
    console.error(e);
  }
}
async function dial(addrInput, statusEl, btn) {
  const addr = addrInput.value.trim();
  if (!addr) {
    statusEl.textContent = "Enter a multiaddr";
    return;
  }
  btn.disabled = true;
  statusEl.textContent = "Dialing…";
  try {
    const r = await fetch("/p2p/dial", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ addr }) });
    const j = await r.json();
    statusEl.textContent = j && j.addr ? "Dialed: " + j.addr : "Dial requested";
  } catch (e) {
    statusEl.textContent = "Error: " + (e?.message || e);
  }
  btn.disabled = false;
}
async function ensureQRCodeLoaded() {
  if (window.QRCode && typeof window.QRCode.toCanvas === "function")
    return;
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed to load QR code library"));
    document.head.appendChild(s);
  });
}
async function createInvite() {
  const pwd = document.getElementById("invitePwd")?.value.trim();
  const minsStr = document.getElementById("inviteExp")?.value;
  const errorDiv = document.getElementById("inviteError");
  const canvas = document.getElementById("inviteQr");
  errorDiv.textContent = "";
  const mins = parseInt(minsStr || "", 10);
  if (!pwd || isNaN(mins)) {
    errorDiv.textContent = "Password and expiry required";
    return;
  }
  const expires = Math.floor(Date.now() / 1000) + mins * 60;
  try {
    const r = await fetch("/p2p/invite", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pwd, expires }) });
    if (!r.ok)
      throw new Error(`${r.status} ${r.statusText}`);
    const j = await r.json();
    await ensureQRCodeLoaded();
    window.QRCode.toCanvas(canvas, JSON.stringify(j), { width: 200 });
  } catch (e) {
    console.error("Error creating invite:", e);
    errorDiv.textContent = e?.message || "Failed to create invite. Please try again.";
  }
}

// web/peers.ts
function renderPeers(root) {
  root.innerHTML = `
    <section class="card">
      <h2>Known peers</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Peer ID</th><th>Last Address</th><th>Last Seen</th></tr>
          </thead>
          <tbody id="peers"></tbody>
        </table>
      </div>
      <div class="muted">Up to 100 most recent entries.</div>
    </section>

    <section class="card">
      <h2>Connect to peer</h2>
      <div class="row">
        <input id="addr" type="text" placeholder="/ip4/127.0.0.1/tcp/4001/p2p/12D3KooW…" />
        <button id="dialBtn">Dial</button>
        <button id="scanBtn">Scan QR</button>
      </div>
      <div id="status" class="muted" style="margin-top:10px"></div>
    </section>
  `;
  const tb = root.querySelector("#peers");
  const dialBtn = root.querySelector("#dialBtn");
  const scanBtn = root.querySelector("#scanBtn");
  const addrInput = root.querySelector("#addr");
  const status = root.querySelector("#status");
  dialBtn.onclick = () => dial2(addrInput, status, dialBtn);
  scanBtn.onclick = () => {
    if (window.PC?.openQRScanner) {
      window.PC.openQRScanner((text) => {
        addrInput.value = text;
        dial2(addrInput, status, dialBtn);
      });
    } else {
      status.textContent = "QR scanner unavailable.";
    }
  };
  loadPeers(tb);
}
async function loadPeers(tb) {
  try {
    const r = await fetch("/p2p/peers");
    const j = await r.json();
    tb.innerHTML = "";
    for (const p of j) {
      const tr = document.createElement("tr");
      const td1 = document.createElement("td");
      td1.textContent = p.peer_id;
      td1.className = "mono";
      td1.title = p.peer_id;
      const td2 = document.createElement("td");
      td2.textContent = p.last_addr || "";
      td2.className = "mono";
      td2.title = p.last_addr || "";
      const td3 = document.createElement("td");
      td3.textContent = new Date(p.last_seen * 1000).toLocaleString();
      tr.append(td1, td2, td3);
      tb.appendChild(tr);
    }
  } catch (e) {
    console.error(e);
  }
}
async function dial2(addrInput, statusEl, btn) {
  const addr = addrInput.value.trim();
  if (!addr) {
    statusEl.textContent = "Enter a multiaddr";
    return;
  }
  btn.disabled = true;
  statusEl.textContent = "Dialing…";
  try {
    const r = await fetch("/p2p/dial", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ addr }) });
    const j = await r.json();
    statusEl.textContent = "Dialed: " + j.addr;
  } catch (e) {
    statusEl.textContent = "Error: " + (e?.message || e);
  }
  btn.disabled = false;
}

// web/app.ts
var styles = `
:root { color-scheme: light dark; }
body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, Helvetica, Arial, sans-serif; margin: 0; padding: 0; }
header { padding: 16px 20px; border-bottom: 1px solid #ddd; position: sticky; top: 0; background: color-mix(in oklab, Canvas 96%, transparent); backdrop-filter: blur(6px); display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; }
header nav { display:flex; gap:14px; }
header nav a { color: inherit; text-decoration: none; padding: 8px 10px; border-radius: 8px; }
header nav a:hover { background: color-mix(in oklab, Canvas 92%, transparent); }
header h1 { margin: 0; font-size: 1.4rem; }
header h1 a { color: inherit; text-decoration: none; border-radius: 8px; padding: 4px 6px; display: inline-block; }
header h1 a:hover { background: color-mix(in oklab, Canvas 92%, transparent); }
main { padding: 20px; max-width: 900px; margin: 0 auto; }
section { margin: 20px 0; padding: 16px; border: 1px solid #e0e0e0; border-radius: 12px; scroll-margin-top: 80px; }
.muted { color: #666; font-size: .92rem; }
.card { background: color-mix(in oklab, Canvas 98%, transparent); }
.row { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
input[type=text], input[type=number] { padding: 10px 12px; border: 1px solid #ccc; border-radius: 8px; min-width: 280px; flex: 1; }
button { padding: 10px 14px; border: 0; border-radius: 8px; background: #4f46e5; color: white; cursor: pointer; }
button:disabled { background: #a8a29e; cursor: not-allowed; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #eee; font-variant-numeric: tabular-nums; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace; }
th:nth-child(1), td:nth-child(1) { width: 38%; }
th:nth-child(2), td:nth-child(2) { width: 42%; }
th:nth-child(3), td:nth-child(3) { width: 20%; white-space: nowrap; }
td.mono { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* QR scanner modal */
.qr-modal { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: none; align-items: center; justify-content: center; z-index: 1000; }
.qr-modal.open { display: flex; }
.qr-box { width: min(92vw, 520px); background: color-mix(in oklab, Canvas 98%, transparent); border: 1px solid #e0e0e0; border-radius: 12px; padding: 16px; }
`;
function mountBaseLayout() {
  if (!document.getElementById("pc-styles")) {
    const style = document.createElement("style");
    style.id = "pc-styles";
    style.textContent = styles;
    document.head.appendChild(style);
  }
  document.body.innerHTML = `
    <header>
      <h1><a href="/" data-link> PuppyCloud </a></h1>
      <nav aria-label="Primary">
        <a href="/peers" data-link>Peers</a>
        <a href="/gallery" data-link>Gallery</a>
      </nav>
    </header>
    <main id="app"></main>
    <div id="qrModal" class="qr-modal" aria-hidden="true" role="dialog">
      <div class="qr-box">
        <h3>Scan QR code</h3>
        <video id="qrVideo" playsinline autoplay muted style="width:100%; border-radius:8px; background:#000; aspect-ratio:3/4; object-fit:cover;"></video>
        <canvas id="qrCanvas" hidden></canvas>
        <div class="row" style="margin-top:10px; justify-content:flex-end;">
          <button id="qrCancel">Cancel</button>
        </div>
        <div id="qrError" class="muted"></div>
      </div>
    </div>
  `;
  document.querySelectorAll("a[data-link]").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const href = e.currentTarget.getAttribute("href") || "/";
      if (href !== location.pathname) {
        history.pushState({}, "", href);
        renderRoute();
      }
    });
  });
  window.addEventListener("popstate", renderRoute);
}
async function loadScript(src) {
  if (document.querySelector(`script[src="${src}"]`))
    return;
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed to load " + src));
    document.head.appendChild(s);
  });
}
var qrStream = null;
var qrRaf = null;
var onQRResult = null;
async function ensureJsQRLoaded() {
  if (window.jsQR)
    return;
  await loadScript("https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js");
}
function closeQRScanner() {
  const modal = document.getElementById("qrModal");
  modal?.classList.remove("open");
  if (qrRaf) {
    cancelAnimationFrame(qrRaf);
    qrRaf = null;
  }
  const video = document.getElementById("qrVideo");
  if (video) {
    try {
      video.pause();
    } catch {}
  }
  if (qrStream) {
    qrStream.getTracks().forEach((t) => t.stop());
    qrStream = null;
  }
  onQRResult = null;
}
function scanLoop() {
  const video = document.getElementById("qrVideo");
  const canvas = document.getElementById("qrCanvas");
  const err = document.getElementById("qrError");
  const w = video.videoWidth | 0, h = video.videoHeight | 0;
  if (w > 0 && h > 0) {
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    try {
      const code = window.jsQR && window.jsQR(img.data, w, h, { inversionAttempts: "dontInvert" });
      if (code && code.data) {
        const text = code.data.trim();
        closeQRScanner();
        if (onQRResult)
          onQRResult(text);
        return;
      }
    } catch (e) {
      err.textContent = "Decode error: " + e;
    }
  }
  qrRaf = requestAnimationFrame(scanLoop);
}
async function openQRScanner(handler) {
  onQRResult = handler;
  await ensureJsQRLoaded();
  const modal = document.getElementById("qrModal");
  const video = document.getElementById("qrVideo");
  const err = document.getElementById("qrError");
  const cancelBtn = document.getElementById("qrCancel");
  err.textContent = "";
  cancelBtn.onclick = () => closeQRScanner();
  window.addEventListener("keydown", escToCloseOnce, { once: true });
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    err.textContent = "Camera not supported in this browser.";
    modal?.classList.add("open");
    return;
  }
  modal?.classList.add("open");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
    qrStream = stream;
    video.srcObject = stream;
    await video.play();
    scanLoop();
  } catch (e) {
    err.textContent = "Camera error: " + e;
  }
}
function escToCloseOnce(e) {
  if (e.key === "Escape")
    closeQRScanner();
}
function setActiveNav() {
  const path = location.pathname || "/";
  document.querySelectorAll("header nav a").forEach((a) => {
    const href = a.getAttribute("href");
    if (href === path)
      a.setAttribute("aria-current", "page");
    else
      a.removeAttribute("aria-current");
  });
}
function renderRoute() {
  const root = document.getElementById("app");
  const path = location.pathname || "/";
  setActiveNav();
  if (path === "/" || path === "/index.html") {
    renderHome(root);
  } else if (path === "/gallery") {
    renderGallery(root);
  } else if (path === "/peers") {
    renderPeers(root);
  } else {
    root.innerHTML = `<section class="card"><h2>Not found</h2><div class="muted">Unknown path: ${path}</div></section>`;
  }
}
window.onload = () => {
  mountBaseLayout();
  window.PC = { openQRScanner, closeQRScanner };
  renderRoute();
};
