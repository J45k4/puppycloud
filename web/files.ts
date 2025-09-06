// Renderers for Home (index) and Gallery

export function renderHome(root: HTMLElement) {
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

  // Wire events
  const dialBtn = root.querySelector<HTMLButtonElement>('#dialBtn')!;
  const scanBtn = root.querySelector<HTMLButtonElement>('#scanBtn')!;
  const addrInput = root.querySelector<HTMLInputElement>('#addr')!;
  const status = root.querySelector<HTMLDivElement>('#status')!;

  dialBtn.onclick = () => dial(addrInput, status, dialBtn);
  scanBtn.onclick = () => {
    if (window.PC?.openQRScanner) {
      window.PC.openQRScanner((text) => {
        addrInput.value = parseQRText(text);
        dial(addrInput, status, dialBtn);
      });
    } else {
      status.textContent = 'QR scanner unavailable.';
    }
  };

  const inviteBtn = root.querySelector<HTMLButtonElement>('#inviteBtn')!;
  inviteBtn.onclick = () => createInvite();

  loadInfo(root);
}

export function renderGallery(root: HTMLElement) {
  root.innerHTML = `
    <section class="card">
      <h2>Gallery</h2>
      <div class="muted">Nothing here yet. Add items in a future update.</div>
    </section>
  `;
}

function parseQRText(text: string): string {
  try {
    const obj = JSON.parse(text);
    if (obj.expires && Date.now() > obj.expires * 1000) {
      alert('Invite expired');
      return '';
    }
    return obj.addr || text;
  } catch {
    return text;
  }
}

async function loadInfo(root: HTMLElement) {
  try {
    const r = await fetch('/p2p/info');
    const j = await r.json();
    const peerId = root.querySelector('#peerId');
    const ul = root.querySelector('#addrs');
    if (peerId) peerId.textContent = j.peer_id;
    if (ul) {
      ul.innerHTML = '';
      (j.addrs || []).forEach((a: string) => {
        const li = document.createElement('li'); li.textContent = a; ul.appendChild(li);
      });
    }
  } catch (e) { console.error(e); }
}

async function dial(addrInput: HTMLInputElement, statusEl: HTMLElement, btn: HTMLButtonElement) {
  const addr = addrInput.value.trim();
  if (!addr) { statusEl.textContent = 'Enter a multiaddr'; return; }
  btn.disabled = true; statusEl.textContent = 'Dialing…';
  try {
    const r = await fetch('/p2p/dial', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ addr }) });
    const j = await r.json();
    statusEl.textContent = (j && j.addr) ? ('Dialed: ' + j.addr) : 'Dial requested';
  } catch (e: any) { statusEl.textContent = 'Error: ' + (e?.message || e); }
  btn.disabled = false;
}

// --- Invite QR (optional; backend endpoint may be disabled) ---

declare global { interface Window { QRCode?: any; PC?: any; } }

async function ensureQRCodeLoaded(): Promise<void> {
  if (window.QRCode && typeof window.QRCode.toCanvas === 'function') return;
  await new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load QR code library'));
    document.head.appendChild(s);
  });
}

async function createInvite() {
  const pwd = (document.getElementById('invitePwd') as HTMLInputElement)?.value.trim();
  const minsStr = (document.getElementById('inviteExp') as HTMLInputElement)?.value;
  const errorDiv = document.getElementById('inviteError') as HTMLDivElement;
  const canvas = document.getElementById('inviteQr') as HTMLCanvasElement;
  errorDiv.textContent = '';
  const mins = parseInt(minsStr || '', 10);
  if (!pwd || isNaN(mins)) { errorDiv.textContent = 'Password and expiry required'; return; }
  const expires = Math.floor(Date.now() / 1000) + mins * 60;
  try {
    const r = await fetch('/p2p/invite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pwd, expires }) });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    const j = await r.json();
    await ensureQRCodeLoaded();
    window.QRCode.toCanvas(canvas, JSON.stringify(j), { width: 200 });
  } catch (e: any) {
    console.error('Error creating invite:', e);
    errorDiv.textContent = e?.message || 'Failed to create invite. Please try again.';
  }
}