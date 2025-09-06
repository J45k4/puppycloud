export function renderPeers(root: HTMLElement) {
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

  const tb = root.querySelector<HTMLTableSectionElement>('#peers')!;
  const dialBtn = root.querySelector<HTMLButtonElement>('#dialBtn')!;
  const scanBtn = root.querySelector<HTMLButtonElement>('#scanBtn')!;
  const addrInput = root.querySelector<HTMLInputElement>('#addr')!;
  const status = root.querySelector<HTMLDivElement>('#status')!;

  dialBtn.onclick = () => dial(addrInput, status, dialBtn);
  scanBtn.onclick = () => {
    if (window.PC?.openQRScanner) {
      window.PC.openQRScanner((text: string) => { addrInput.value = text; dial(addrInput, status, dialBtn); });
    } else { status.textContent = 'QR scanner unavailable.'; }
  };

  loadPeers(tb);
}

async function loadPeers(tb: HTMLTableSectionElement) {
  try {
    const r = await fetch('/p2p/peers');
    const j = await r.json();
    tb.innerHTML = '';
    for (const p of j) {
      const tr = document.createElement('tr');
      const td1 = document.createElement('td'); td1.textContent = p.peer_id; td1.className = 'mono'; td1.title = p.peer_id;
      const td2 = document.createElement('td'); td2.textContent = p.last_addr || ''; td2.className = 'mono'; td2.title = p.last_addr || '';
      const td3 = document.createElement('td'); td3.textContent = new Date(p.last_seen * 1000).toLocaleString();
      tr.append(td1, td2, td3); tb.appendChild(tr);
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
    statusEl.textContent = 'Dialed: ' + j.addr;
  } catch (e: any) { statusEl.textContent = 'Error: ' + (e?.message || e); }
  btn.disabled = false;
}
