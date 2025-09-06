import { renderHome, renderGallery } from './files';
import { renderPeers } from './peers';

// Simple SPA router + shared layout/styles + reusable QR scanner

type QRHandler = (text: string) => void;

declare global {
  interface Window {
    PC?: {
      openQRScanner: (onResult: QRHandler) => void;
      closeQRScanner: () => void;
    };
    jsQR?: (data: Uint8ClampedArray, width: number, height: number, opts?: any) => { data: string } | null;
  }
}

const styles = `
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
  // Inject styles once
  if (!document.getElementById('pc-styles')) {
    const style = document.createElement('style');
    style.id = 'pc-styles';
    style.textContent = styles;
    document.head.appendChild(style);
  }

  // Base layout
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

  // Nav SPA handling
  document.querySelectorAll('a[data-link]').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const href = (e.currentTarget as HTMLAnchorElement).getAttribute('href') || '/';
      if (href !== location.pathname) {
        history.pushState({}, '', href);
        renderRoute();
      }
    });
  });

  window.addEventListener('popstate', renderRoute);
}

async function loadScript(src: string) {
  if (document.querySelector(`script[src="${src}"]`)) return;
  await new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load ' + src));
    document.head.appendChild(s);
  });
}

// Reusable QR scanner
let qrStream: MediaStream | null = null;
let qrRaf: number | null = null;
let onQRResult: QRHandler | null = null;

async function ensureJsQRLoaded() {
  if (window.jsQR) return;
  await loadScript('https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js');
}

function closeQRScanner() {
  const modal = document.getElementById('qrModal');
  modal?.classList.remove('open');
  if (qrRaf) { cancelAnimationFrame(qrRaf); qrRaf = null; }
  const video = document.getElementById('qrVideo') as HTMLVideoElement | null;
  if (video) { try { video.pause(); } catch {}
  }
  if (qrStream) { qrStream.getTracks().forEach(t => t.stop()); qrStream = null; }
  onQRResult = null;
}

function scanLoop() {
  const video = document.getElementById('qrVideo') as HTMLVideoElement;
  const canvas = document.getElementById('qrCanvas') as HTMLCanvasElement;
  const err = document.getElementById('qrError') as HTMLDivElement;
  const w = video.videoWidth | 0, h = video.videoHeight | 0;
  if (w > 0 && h > 0) {
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(video, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    try {
      const code = window.jsQR && window.jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
      if (code && code.data) {
        const text = code.data.trim();
        closeQRScanner();
        if (onQRResult) onQRResult(text);
        return;
      }
    } catch (e: any) { err.textContent = 'Decode error: ' + e; }
  }
  qrRaf = requestAnimationFrame(scanLoop);
}

async function openQRScanner(handler: QRHandler) {
  onQRResult = handler;
  await ensureJsQRLoaded();
  const modal = document.getElementById('qrModal');
  const video = document.getElementById('qrVideo') as HTMLVideoElement;
  const err = document.getElementById('qrError') as HTMLDivElement;
  const cancelBtn = document.getElementById('qrCancel') as HTMLButtonElement;
  err.textContent = '';
  cancelBtn.onclick = () => closeQRScanner();
  window.addEventListener('keydown', escToCloseOnce, { once: true });

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    err.textContent = 'Camera not supported in this browser.';
    modal?.classList.add('open');
    return;
  }

  modal?.classList.add('open');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    qrStream = stream; video.srcObject = stream; await video.play(); scanLoop();
  } catch (e: any) {
    err.textContent = 'Camera error: ' + e;
  }
}

function escToCloseOnce(e: KeyboardEvent) { if (e.key === 'Escape') closeQRScanner(); }

function setActiveNav() {
  const path = location.pathname || '/';
  document.querySelectorAll('header nav a').forEach(a => {
    const href = (a as HTMLAnchorElement).getAttribute('href');
    if (href === path) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

function renderRoute() {
  const root = document.getElementById('app') as HTMLElement;
  const path = location.pathname || '/';
  setActiveNav();
  if (path === '/' || path === '/index.html') {
    renderHome(root);
  } else if (path === '/gallery') {
    renderGallery(root);
  } else if (path === '/peers') {
    renderPeers(root);
  } else {
    root.innerHTML = `<section class="card"><h2>Not found</h2><div class="muted">Unknown path: ${path}</div></section>`;
  }
}

window.onload = () => {
  mountBaseLayout();
  // Expose QR scanner for pages
  window.PC = { openQRScanner, closeQRScanner };
  renderRoute();
};