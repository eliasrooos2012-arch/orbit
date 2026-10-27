"""Visible opt-in screen-sharing agent for computers you own/control.

Requires a running relay (server/) and explicit foreground YES confirmation.
Stop the session by closing this window or pressing Ctrl+C here.
"""
import ctypes
import io
import json
import os
import platform
import re
import signal
import sys
import threading
import time
from pathlib import Path

import mss
from PIL import Image
import pyautogui
import websocket

CONFIG_PATH = Path(__file__).with_name('config.json')
STOP = threading.Event()
WATCHERS = 0
WATCHER_LOCK = threading.Lock()
INPUT_LOCK = threading.Lock()
PRESSED_KEYS = set()
PRESSED_BUTTONS = set()

# A physical corner motion can still trigger PyAutoGUI's built-in fail-safe.
pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0

if platform.system() == 'Windows':
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass

KEY_ALIASES = {
    'Space': 'space', 'Enter': 'enter', 'NumpadEnter': 'enter',
    'Escape': 'esc', 'Backspace': 'backspace', 'Tab': 'tab',
    'Delete': 'delete', 'Insert': 'insert', 'Home': 'home', 'End': 'end',
    'PageUp': 'pageup', 'PageDown': 'pagedown',
    'ArrowLeft': 'left', 'ArrowRight': 'right', 'ArrowUp': 'up', 'ArrowDown': 'down',
    'ShiftLeft': 'shift', 'ShiftRight': 'shift',
    'ControlLeft': 'ctrl', 'ControlRight': 'ctrl',
    'AltLeft': 'alt', 'AltRight': 'alt',
    'MetaLeft': 'win', 'MetaRight': 'win',
    'CapsLock': 'capslock', 'NumLock': 'numlock', 'ScrollLock': 'scrolllock',
    'PrintScreen': 'printscreen', 'Pause': 'pause', 'ContextMenu': 'apps',
    'Minus': '-', 'Equal': '=', 'BracketLeft': '[', 'BracketRight': ']',
    'Backslash': '\\', 'Semicolon': ';', 'Quote': "'", 'Comma': ',',
    'Period': '.', 'Slash': '/', 'Backquote': '`',
    'NumpadAdd': '+', 'NumpadSubtract': '-', 'NumpadMultiply': '*',
    'NumpadDivide': '/', 'NumpadDecimal': '.',
}


def get_key(code):
    if code in KEY_ALIASES:
        return KEY_ALIASES[code]
    if re.fullmatch(r'Key[A-Z]', code):
        return code[-1].lower()
    if re.fullmatch(r'Digit[0-9]', code):
        return code[-1]
    if re.fullmatch(r'Numpad[0-9]', code):
        return code[-1]
    if re.fullmatch(r'F(?:[1-9]|1[0-9]|2[0-4])', code):
        return code.lower()
    return None


def release_all():
    with INPUT_LOCK:
        for key in list(PRESSED_KEYS):
            try:
                pyautogui.keyUp(key)
            except Exception:
                pass
        PRESSED_KEYS.clear()
        for button in list(PRESSED_BUTTONS):
            try:
                pyautogui.mouseUp(button=button)
            except Exception:
                pass
        PRESSED_BUTTONS.clear()


def handle_input(msg, monitor):
    kind = msg.get('type')
    if kind == 'releaseAll':
        release_all()
        return
    with INPUT_LOCK:
        try:
            if kind == 'mouse':
                action = msg.get('action')
                if action == 'move':
                    x, y = float(msg['x']), float(msg['y'])
                    if not (0 <= x <= 1 and 0 <= y <= 1):
                        return
                    # Monitor #1 is the primary display. Normalized positions
                    # map correctly even when the video is scaled down.
                    pyautogui.moveTo(monitor['left'] + round(x * (monitor['width'] - 1)),
                                     monitor['top'] + round(y * (monitor['height'] - 1)), _pause=False)
                elif action in ('down', 'up') and msg.get('button') in ('left', 'right', 'middle'):
                    button = msg['button']
                    if action == 'down' and button not in PRESSED_BUTTONS:
                        pyautogui.mouseDown(button=button, _pause=False)
                        PRESSED_BUTTONS.add(button)
                    elif action == 'up' and button in PRESSED_BUTTONS:
                        pyautogui.mouseUp(button=button, _pause=False)
                        PRESSED_BUTTONS.discard(button)
            elif kind == 'key':
                key = get_key(msg.get('code', ''))
                if key:
                    action = msg.get('action')
                    if action == 'down' and key not in PRESSED_KEYS:
                        pyautogui.keyDown(key, _pause=False)
                        PRESSED_KEYS.add(key)
                    elif action == 'up' and key in PRESSED_KEYS:
                        pyautogui.keyUp(key, _pause=False)
                        PRESSED_KEYS.discard(key)
            elif kind == 'scroll':
                steps = msg.get('steps')
                if type(steps) is int and -20 <= steps <= 20:
                    pyautogui.scroll(steps, _pause=False)
        except pyautogui.FailSafeException:
            print('\n[LOCAL SAFETY] Mouse entered the fail-safe corner. Releasing inputs.')
            # Must release outside INPUT_LOCK to avoid locking ourselves.
            for key in list(PRESSED_KEYS):
                try: pyautogui.keyUp(key)
                except Exception: pass
            PRESSED_KEYS.clear()
            for button in list(PRESSED_BUTTONS):
                try: pyautogui.mouseUp(button=button)
                except Exception: pass
            PRESSED_BUTTONS.clear()
        except Exception as exc:
            print(f'[input warning] {exc}')


def capture_loop(ws, config, monitor):
    fps = max(1, min(12, int(config.get('fps', 6))))
    max_width = max(320, min(1920, int(config.get('max_width', 1280))))
    jpeg_quality = max(30, min(85, int(config.get('jpeg_quality', 60))))
    delay = 1 / fps
    with mss.mss() as sct:
        while not STOP.is_set() and ws.keep_running and ws.sock and ws.sock.connected:
            with WATCHER_LOCK:
                count = WATCHERS
            if not count:
                time.sleep(.5)
                continue
            start = time.monotonic()
            try:
                shot = sct.grab(monitor)
                frame = Image.frombytes('RGB', shot.size, shot.rgb)
                if frame.width > max_width:
                    scaled_height = max(1, round(frame.height * max_width / frame.width))
                    frame = frame.resize((max_width, scaled_height), Image.Resampling.BILINEAR)
                output = io.BytesIO()
                frame.save(output, format='JPEG', quality=jpeg_quality)
                ws.send(output.getvalue(), opcode=websocket.ABNF.OPCODE_BINARY)
            except Exception as exc:
                print(f'[screen warning] {exc}')
                break
            STOP.wait(max(0, delay - (time.monotonic() - start)))


def main():
    if not CONFIG_PATH.exists():
        print('Missing host/config.json. Copy config.example.json to config.json and fill it in.')
        sys.exit(1)
    try:
        config = json.loads(CONFIG_PATH.read_text(encoding='utf-8'))
        server_url = config['server_url'].strip()
        token = config['host_token'].strip()
        if not server_url.startswith(('wss://', 'ws://')) or len(token) < 24:
            raise ValueError('Invalid server_url or host_token')
    except (ValueError, KeyError) as exc:
        print(f'Configuration error: {exc}')
        sys.exit(1)
    if server_url.startswith('ws://') and not server_url.startswith('ws://localhost:') and not server_url.startswith('ws://127.0.0.1:'):
        print('Refusing insecure ws:// connection. Use wss:// for internet access.')
        sys.exit(1)
    with mss.mss() as sct:
        if len(sct.monitors) < 2:
            print('No display found on this computer.')
            sys.exit(1)
        monitor = dict(sct.monitors[1])
    print('\n' + '=' * 61)
    print('              ORBIT REMOTE - HOST COMPUTER')
    print('=' * 61)
    print(f'Relay:     {server_url}')
    print(f'Monitor:   {monitor["width"]} x {monitor["height"]} (primary)')
    print('\nWARNING: Anyone signed into the matching website can SEE your')
    print('screen and CONTROL your mouse and keyboard while this runs.')
    print('Close this terminal / press Ctrl+C to stop sharing.')
    print('Only do this on computers you own or may administer.')
    print('=' * 61)
    if input('Type YES to start remote control: ').strip() != 'YES':
        print('Canceled. No screen was shared.')
        return

    print('\nConnecting. Leave this window open. Ctrl+C stops the host.\n')

    def on_open(ws):
        global WATCHERS
        with WATCHER_LOCK:
            WATCHERS = 0
        ws.send(json.dumps({'type': 'meta', 'width': monitor['width'], 'height': monitor['height']}))
        thread = threading.Thread(target=capture_loop, args=(ws, config, monitor), daemon=True)
        thread.start()
        print('[online] Host is connected; screen share starts when a viewer opens the website.')

    def on_message(ws, raw):
        global WATCHERS
        if isinstance(raw, bytes):
            return
        try:
            message = json.loads(raw)
            if message.get('type') == 'watchers':
                with WATCHER_LOCK:
                    WATCHERS = max(0, int(message.get('count', 0)))
            elif message.get('type') in ('mouse', 'key', 'scroll', 'releaseAll'):
                handle_input(message, monitor)
        except (TypeError, ValueError, KeyError) as exc:
            print(f'[protocol warning] {exc}')

    def on_close(ws, code, reason):
        global WATCHERS
        with WATCHER_LOCK:
            WATCHERS = 0
        release_all()
        print(f'[offline] Disconnected: {code or ""} {reason or ""}')

    def on_error(ws, error):
        print(f'[network] {error}')

    active_ws = [None]

    def stop_handler(signum, frame):
        STOP.set()
        if active_ws[0] is not None:
            active_ws[0].close()

    signal.signal(signal.SIGINT, stop_handler)
    if hasattr(signal, 'SIGTERM'):
        signal.signal(signal.SIGTERM, stop_handler)

    try:
        while not STOP.is_set():
            ws = websocket.WebSocketApp(
                server_url,
                header={'Authorization': f'Bearer {token}'},
                on_open=on_open,
                on_message=on_message,
                on_error=on_error,
                on_close=on_close,
            )
            active_ws[0] = ws
            ws.run_forever(ping_interval=25, ping_timeout=10)
            if not STOP.is_set():
                print('Reconnecting after a short pause...')
                STOP.wait(3)
    except KeyboardInterrupt:
        print('\nStopping remote access...')
    finally:
        STOP.set()
        release_all()
        print('Host stopped.')


if __name__ == '__main__':
    main()
