'use strict';
const $ = id => document.getElementById(id);
const loginView = $('loginView');
const desktopView = $('desktopView');
const canvas = $('screenCanvas');
const ctx = canvas.getContext('2d', { alpha: false });
const overlay = $('screenOverlay');
let socket = null;
let authenticated = false;
let hostOnline = false;
let frameBusy = false;
let lastFrameAt = 0;
let reconnectTimer = null;
let lastMouseSent = 0;
let heldButtons = new Set();
let heldKeys = new Set();

function setConnection(label, active) {
  $('connectionLabel').textContent = label;
  $('connectionDot').classList.toggle('active', !!active);
}
function setOverlay(title, message, visible) {
  $('overlayTitle').textContent = title;
  $('overlayMessage').textContent = message;
  overlay.hidden = !visible;
  overlay.style.display = visible ? 'flex' : 'none';
  canvas.classList.toggle('connected', !visible);
}
function setView(signedIn) {
  authenticated = signedIn;
  loginView.hidden = signedIn;
  desktopView.hidden = !signedIn;
  $('logoutBtn').hidden = !signedIn;
  if (!signedIn) {
    setConnection('Disconnected', false);
    $('passwordInput').value = '';
  }
}
function send(message) {
  if (socket && socket.readyState === WebSocket.OPEN && hostOnline && $('controlToggle').checked) {
    socket.send(JSON.stringify(message));
  }
}
function releaseAll() {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'releaseAll' }));
  heldButtons.clear();
  heldKeys.clear();
}
async function showFrame(blob) {
  if (frameBusy || !hostOnline) return;
  frameBusy = true;
  try {
    const bitmap = await createImageBitmap(blob);
    if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
    }
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    lastFrameAt = Date.now();
    setOverlay('', '', false);
    $('streamStatus').textContent = 'Live screen';
    $('streamDot').classList.add('active');
    $('lastFrame').textContent = `${canvas.width} × ${canvas.height} preview`;
  } catch (err) {
    console.warn('Unable to decode a screen frame:', err);
  } finally {
    frameBusy = false;
  }
}
function handleStatus(data) {
  hostOnline = !!data.hostOnline;
  $('hostIndicator').textContent = hostOnline ? 'ONLINE' : 'OFFLINE';
  $('hostIndicator').classList.toggle('on', hostOnline);
  $('resolutionLabel').textContent = hostOnline
    ? (data.width ? `Remote monitor: ${data.width} × ${data.height}` : 'Host connected — starting screen capture...')
    : 'Waiting for host application...';
  setConnection(hostOnline ? 'Desktop online' : 'Host offline', hostOnline);
  if (!hostOnline) {
    setOverlay('Waiting for host', 'Start the host program on your other computer to begin.', true);
    $('streamDot').classList.remove('active');
    $('streamStatus').textContent = 'Stream paused';
    $('lastFrame').textContent = 'No active screen';
    releaseAll();
  } else if (!lastFrameAt) {
    setOverlay('Connecting to desktop', 'Host is online. Waiting for the first screen frame...', true);
  }
}
function connectSocket() {
  if (!authenticated) return;
  if (socket) { socket.onclose = null; socket.close(); }
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}/viewer`);
  socket.binaryType = 'blob';
  setConnection('Connecting...', false);
  socket.onmessage = event => {
    if (event.data instanceof Blob) { void showFrame(event.data); return; }
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'status') handleStatus(msg);
    } catch (err) { console.warn('Unknown server status', err); }
  };
  socket.onclose = event => {
    hostOnline = false;
    heldKeys.clear();
    heldButtons.clear();
    setConnection('Reconnecting...', false);
    setOverlay('Connection lost', 'Trying to reconnect to your remote desktop...', true);
    $('streamDot').classList.remove('active');
    if (authenticated) {
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(async () => {
        const res = await fetch('/api/status').catch(() => null);
        if (res?.status === 401) { setView(false); return; }
        connectSocket();
      }, 2500);
    }
  };
  socket.onerror = () => {}; // close event handles user-facing recovery
}
async function checkSession() {
  try {
    const result = await fetch('/api/status', { cache: 'no-store' });
    if (result.ok) { setView(true); connectSocket(); return; }
  } catch {}
  setView(false);
}
$('loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  $('loginError').textContent = '';
  $('loginBtn').disabled = true;
  try {
    const result = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: $('passwordInput').value }),
    });
    const data = await result.json();
    if (!result.ok) throw new Error(data.error || 'Unable to sign in');
    setView(true);
    connectSocket();
  } catch (error) { $('loginError').textContent = error.message || 'Connection failed'; }
  finally { $('loginBtn').disabled = false; }
});
$('showPassword').addEventListener('click', () => {
  const input = $('passwordInput');
  input.type = input.type === 'password' ? 'text' : 'password';
  $('showPassword').textContent = input.type === 'password' ? 'Show' : 'Hide';
});
$('logoutBtn').addEventListener('click', async () => {
  authenticated = false;
  clearTimeout(reconnectTimer);
  releaseAll();
  if (socket) { socket.onclose = null; socket.close(); socket = null; }
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  lastFrameAt = 0;
  setView(false);
});
$('fullscreenBtn').addEventListener('click', async () => {
  const shell = $('screenShell');
  try {
    if (!document.fullscreenElement) await shell.requestFullscreen();
    else await document.exitFullscreen();
    canvas.focus();
  } catch (error) { console.warn('Fullscreen unavailable', error); }
});
$('controlToggle').addEventListener('change', () => {
  releaseAll();
  if ($('controlToggle').checked) canvas.focus();
  canvas.style.cursor = $('controlToggle').checked ? 'crosshair' : 'default';
});
function normalizedPosition(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
  };
}
function mouseButton(button) { return ({ 0: 'left', 1: 'middle', 2: 'right' })[button]; }
canvas.addEventListener('pointermove', event => {
  if (!hostOnline) return;
  const now = performance.now();
  if (now - lastMouseSent < 35) return;
  lastMouseSent = now;
  send({ type: 'mouse', action: 'move', ...normalizedPosition(event) });
});
canvas.addEventListener('pointerdown', event => {
  if (!hostOnline || !$('controlToggle').checked) return;
  event.preventDefault();
  canvas.focus();
  send({ type: 'mouse', action: 'move', ...normalizedPosition(event) });
  const button = mouseButton(event.button);
  if (button) { heldButtons.add(button); send({ type: 'mouse', action: 'down', button }); }
});
window.addEventListener('pointerup', event => {
  const button = mouseButton(event.button);
  if (button && heldButtons.has(button)) { send({ type: 'mouse', action: 'up', button }); heldButtons.delete(button); }
});
canvas.addEventListener('contextmenu', event => event.preventDefault());
canvas.addEventListener('wheel', event => {
  if (!hostOnline || !$('controlToggle').checked) return;
  event.preventDefault();
  const steps = Math.max(-20, Math.min(20, Math.round(-event.deltaY / 80) || (event.deltaY < 0 ? 1 : -1)));
  send({ type: 'scroll', steps });
}, { passive: false });
window.addEventListener('keydown', event => {
  if (!hostOnline || !$('controlToggle').checked ||
      (document.activeElement !== canvas && !document.fullscreenElement)) return;
  // Preserve the local browser's fullscreen escape key.
  if (event.code === 'Escape' && document.fullscreenElement) return;
  event.preventDefault();
  if (!heldKeys.has(event.code)) { heldKeys.add(event.code); send({ type: 'key', action: 'down', code: event.code }); }
}, true);
window.addEventListener('keyup', event => {
  if (!heldKeys.has(event.code)) return;
  event.preventDefault();
  heldKeys.delete(event.code);
  send({ type: 'key', action: 'up', code: event.code });
}, true);
window.addEventListener('blur', releaseAll);
document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });
setInterval(() => {
  if (hostOnline && lastFrameAt && Date.now() - lastFrameAt > 5000) {
    $('streamStatus').textContent = 'Waiting for frames';
    $('streamDot').classList.remove('active');
  }
}, 2500);
void checkSession();
