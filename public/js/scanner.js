// Lecteur de codes-barres par la caméra.
// BarcodeDetector natif quand le navigateur l'a (Android, macOS), sinon la même API
// fournie par ZXing (WebAssembly embarqué dans vendor/, donc disponible hors ligne).
// La saisie manuelle reste toujours possible : douchette USB/Bluetooth ou clavier.

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'code_93', 'itf', 'codabar', 'qr_code', 'data_matrix'];
const REPEAT_MS = 1000; // un code doit quitter l'image ce temps-là pour être compté à nouveau
const SCAN_EVERY = 120;

let detectorPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Lecteur de codes-barres introuvable'));
    document.head.append(s);
  });
}

async function createDetector() {
  if ('BarcodeDetector' in globalThis) {
    try {
      const supported = await globalThis.BarcodeDetector.getSupportedFormats();
      const formats = FORMATS.filter((f) => supported.includes(f));
      if (formats.includes('ean_13')) return new globalThis.BarcodeDetector({ formats });
    } catch { /* on passe à ZXing */ }
  }
  await loadScript(new URL('../vendor/barcode-detector.js', import.meta.url).href);
  const api = globalThis.BarcodeDetectionAPI;
  const wasm = new URL('../vendor/zxing_reader.wasm', import.meta.url).href;
  api.setZXingModuleOverrides({ locateFile: (path, prefix) => (path.endsWith('.wasm') ? wasm : prefix + path) });
  return new api.BarcodeDetector({ formats: FORMATS });
}

const detector = () => (detectorPromise ??= createDetector().catch((err) => { detectorPromise = null; throw err; }));

// Bip court : aigu si le code est reconnu, grave sinon.
let audio = null;
function beep(ok) {
  try {
    audio ??= new AudioContext();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = ok ? 1320 : 330;
    gain.gain.setValueAtTime(0.15, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + (ok ? 0.12 : 0.3));
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.3);
  } catch { /* pas de son : tant pis */ }
  if (navigator.userActivation?.hasBeenActive !== false) navigator.vibrate?.(ok ? 60 : [80, 60, 80]);
}

function cameraError(err) {
  if (!navigator.mediaDevices?.getUserMedia) return 'Caméra indisponible ici : il faut l’app Android, HTTPS ou localhost. Saisissez le code ci-dessous.';
  if (err?.name === 'NotAllowedError') return 'Accès à la caméra refusé. Autorisez-le dans les réglages du navigateur, ou saisissez le code.';
  if (err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError') return 'Aucune caméra trouvée. Utilisez une douchette ou saisissez le code.';
  return `Caméra indisponible (${err?.message ?? err}). Saisissez le code ci-dessous.`;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Ouvre le lecteur.
 * @param {object} o
 * @param {string} o.title
 * @param {string} [o.hint]
 * @param {boolean} [o.continuous]  rester ouvert après chaque lecture (caisse, inventaire)
 * @param {(code: string) => {ok: boolean, message: string} | Promise<{ok: boolean, message: string}>} o.onCode
 * @param {() => void} [o.onClose]
 */
export function openScanner({ title, hint = '', continuous = false, onCode, onClose }) {
  document.getElementById('scan-dlg')?.remove();
  const dlg = document.createElement('dialog');
  dlg.id = 'scan-dlg';
  dlg.className = 'scanner';
  dlg.innerHTML = `<h2>${esc(title)}</h2>
    <div class="scan-view"><video playsinline muted></video><div class="scan-frame"></div>
      <p class="scan-status">Ouverture de la caméra…</p></div>
    ${hint ? `<p class="muted small">${esc(hint)}</p>` : ''}
    <p class="scan-result" aria-live="polite"></p>
    <form class="scan-manual"><input name="code" placeholder="Code (douchette ou clavier)" autocomplete="off" inputmode="text" aria-label="Code-barres">
      <button class="btn" type="submit">Valider</button></form>
    <div class="row"><button class="btn" type="button" data-scan="torch" hidden>Lampe</button>
      <button class="btn primary" type="button" data-scan="close">${continuous ? 'Terminer' : 'Fermer'}</button></div>`;
  document.body.append(dlg);

  const video = dlg.querySelector('video');
  const status = dlg.querySelector('.scan-status');
  const result = dlg.querySelector('.scan-result');
  const input = dlg.querySelector('input');
  let stream = null;
  let timer = null;
  let closed = false;
  let last = { code: '', at: 0 };
  let busy = false;

  const stop = () => {
    closed = true;
    clearTimeout(timer);
    stream?.getTracks().forEach((t) => t.stop());
  };

  async function handle(raw) {
    const code = String(raw).trim();
    if (!code || busy) return;
    const now = Date.now();
    // Tant que le même code reste devant la caméra, il n'est compté qu'une fois :
    // il faut l'écarter un instant pour compter l'article suivant identique.
    if (code === last.code && now - last.at < REPEAT_MS) { last.at = now; return; }
    last = { code, at: now };
    busy = true;
    try {
      const out = (await onCode(code)) ?? { ok: true, message: code };
      beep(out.ok);
      result.textContent = out.message;
      result.className = `scan-result ${out.ok ? 'ok' : 'bad'}`;
      if (out.ok && !continuous) dlg.close();
    } finally {
      busy = false;
    }
  }

  async function loop(det) {
    if (closed) return;
    if (video.readyState >= 2 && !busy) {
      try {
        const [hit] = await det.detect(video);
        if (hit?.rawValue) await handle(hit.rawValue);
      } catch { /* image illisible : on continue */ }
    }
    timer = setTimeout(() => loop(det), SCAN_EVERY);
  }

  async function start() {
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('no-media');
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
      });
      if (closed) return stop();
      video.srcObject = stream;
      await video.play();
      const track = stream.getVideoTracks()[0];
      if (track.getCapabilities?.().torch) dlg.querySelector('[data-scan=torch]').hidden = false;
      status.textContent = 'Chargement du lecteur…';
      const det = await detector();
      status.textContent = 'Visez le code-barres';
      loop(det);
    } catch (err) {
      dlg.querySelector('.scan-view').classList.add('off');
      status.textContent = err?.message === 'no-media' ? cameraError(null) : err?.name ? cameraError(err) : err.message;
      input.focus();
    }
  }

  let torch = false;
  dlg.addEventListener('click', (e) => {
    const act = e.target.closest('[data-scan]')?.dataset.scan;
    if (act === 'close') dlg.close();
    if (act === 'torch') {
      torch = !torch;
      stream?.getVideoTracks()[0]?.applyConstraints({ advanced: [{ torch }] }).catch(() => {});
    }
  });
  dlg.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = input.value;
    input.value = '';
    last = { code: '', at: 0 }; // une saisie volontaire compte toujours
    await handle(code);
    if (!closed) input.focus();
  });
  dlg.addEventListener('close', () => {
    stop();
    dlg.remove();
    onClose?.();
  });

  dlg.showModal();
  start();
  return { close: () => dlg.close() };
}
