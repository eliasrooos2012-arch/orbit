# ◈ Orbit Remote — remote desktop in a web browser

A small, self-hosted, opt-in remote desktop project. **Install the agent only on the computer you own or have permission to control.** From another computer you open a website, enter your password, and control the host's screen, mouse, and keyboard. Nothing needs to be installed on the viewing computer.

## What is included

- `server/` — Node.js website + WebSocket relay; can be hosted publicly with HTTPS.
- `host/` — foreground Python agent for the computer being controlled. It prompts for local permission every time it starts.
- Browser website — live JPEG desktop at 1–12 FPS (6 default), left/right click, drag, scrolling, keyboard input and fullscreen.
- Password for browser users, separate secret for the host connection, short-lived login session cookies, login rate limits and authenticated WebSockets.
- Host sends its screen **only while at least one authenticated browser viewer is connected**.
- A **local stop switch**: close the host console or press Ctrl+C. The agent does not auto-start with Windows, hide itself, execute shell commands or transfer files.

**Important:** To access your home computer from a school laptop, you must put `server/` on a publicly reachable HTTPS hosting service. Merely opening `index.html` locally won't work. School administrators may block the site or WebSocket traffic; this project doesn't disable or bypass those controls.

## Setup — recommended (remote access over the internet)

### Step 1 — Make two different long secrets

Use Python on your own PC to generate secrets (twice, for example):

```powershell
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

Pick:

- `VIEWER_PASSWORD`: a long password you type on the website (at least 12 characters).
- `HOST_TOKEN`: a **different** long random token (at least 24 characters), known to the host and relay.

Never put either secret into the website's HTML or public GitHub repository. Keep `host/config.json` private.

### Step 2 — Deploy the website/relay

One option is a Node.js web service at [Render](https://render.com/) (an account and potentially hosting charges are required):

1. Upload the project source to a private GitHub repository, excluding `host/config.json` and `.env` as directed by `.gitignore`.
2. Create a new **Web Service** connected to the repository.
3. Set **Root Directory** to `server`.
4. Set **Build Command** to `npm install`.
5. Set **Start Command** to `npm start`.
6. Add environment variables `VIEWER_PASSWORD` and `HOST_TOKEN` with the secrets from Step 1. Do not quote the values in the hosting settings.
7. Deploy. Your service should give you an HTTPS address such as `https://your-service.onrender.com`.

Equivalent Node.js services that support long-lived WebSockets also work. The server listens on the hosting platform's `PORT` variable, or port `3000` locally.

**Do not** run the relay on the public internet over plain HTTP; use HTTPS so the login and screen traffic are encrypted in transit. Anyone who runs the relay has technical access to the relayed screen data; choose a host you trust.

### Step 3 — Install the agent on the computer to control

Do these steps on **your home computer**, not the school laptop:

1. Install [Python 3](https://www.python.org/downloads/) if it is not already installed.
2. Extract the ZIP and open its `host` folder.
3. Double-click `install_windows.bat` to set up the Python packages. A virtual environment is created under `host/.venv/`.
4. Open `host/config.json` in Notepad. The installer copied this file from `config.example.json`. Change these two fields:

   ```json
   {
     "server_url": "wss://your-service.onrender.com/agent",
     "host_token": "YOUR_SAME_HOST_TOKEN_FROM_STEP_1",
     "fps": 6,
     "max_width": 1280,
     "jpeg_quality": 60
   }
   ```

5. Double-click `start_windows.bat`. **Read the warnings** and type **YES** in the host window to activate remote access. Leave it open.
6. Keep the PC awake and connected to the internet.

If you can't run batch files, open a terminal in `host` and run `python -m pip install -r requirements.txt` followed by `python agent.py`. Keep the terminal visible.

### Step 4 — Connect from the browser

1. On the viewing computer, open `https://your-service.onrender.com` (use your actual service URL).
2. Type `VIEWER_PASSWORD` — **not** `HOST_TOKEN`.
3. When the host is online, its display appears. Click the screen to focus it, then use your mouse and keyboard. The `Mouse & keyboard` toggle lets you switch to view-only mode.
4. To end the session, sign out on the website and **stop the host program on the home PC**. Signing out only closes your browser session; the host stays available until its program is closed.

## Local test before deployment (one PC)

Install Node.js 20 or newer. In PowerShell:

```powershell
cd .\server
$env:VIEWER_PASSWORD = "a-very-long-test-password"
$env:HOST_TOKEN = "test-host-token-at-least-24-characters"
npm install
npm start
```

Open `http://localhost:3000` in your browser. Configure the host's `server_url` as `ws://localhost:3000/agent` and its `host_token` with the same token as above. Run the host app and confirm YES. You can now test the viewer locally. The agent refuses non-local unencrypted `ws://` servers.

## Features and limitations

- Windows is the main supported host platform. Linux and macOS may need system screen-recording, accessibility or display-server permissions. Windows UAC secure desktops and locked login screens cannot be controlled.
- The app captures the **primary monitor**. It resizes the streamed image to the configured `max_width` while keeping mouse coordinates accurate.
- This is a simple MJPEG-style WebSocket desktop, **not** a high-performance gaming/streaming protocol: 6 FPS is suitable for basic desktop tasks but not gaming or video playback.
- Keys based on physical key codes may have punctuation/layout differences (for example, Finnish/US keyboards). Browser-reserved shortcuts such as Ctrl+W might not be forwarded. The viewer does not provide system clipboard synchronization.
- Browser and network policies, including WebSocket blocking, may prevent access. Respect the policies of devices and networks you do not administer.
- No file transfer, command runner, stealth service, or persistence. The host requires an explicit **YES** each launch.
- `host/config.json` contains your host secret. Don't share that file, upload it or commit it to Git.
- Change both secrets if you suspect someone learned them. Sessions in the relay expire automatically after eight hours; the site also supports Sign out.

## Folder structure

```text
browser-remote-desktop/
  README.md
  .gitignore
  server/
    package.json
    server.js
    public/
      index.html
      app.js
      style.css
      favicon.svg
  host/
    requirements.txt
    config.example.json
    install_windows.bat
    start_windows.bat
    agent.py
```
