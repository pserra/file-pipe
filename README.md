# File Pipe

File Pipe is a local-first media sharing app. It lets a browser browse a DLNA/UPnP media server, play media, and create encrypted peer-to-peer share links, watch rooms, and Bigscreen links.

The browser cannot discover DLNA servers by itself because DLNA discovery uses UDP multicast. File Pipe handles that with two Python processes:

- `app.py` serves the Flask web UI and temporary WebRTC signaling endpoints.
- `local_connector.py` runs on the user's machine and exposes local DLNA/UPnP browsing over `https://127.0.0.1:8765`.

The Flask app does not store plaintext media. Current sharing flows encrypt metadata and file chunks in the browser, put the decryption key in the URL fragment, and use WebRTC to move encrypted data between browsers.

## Requirements

- Python 3.9+
- A browser with Web Crypto and WebRTC support
- A DLNA/UPnP media server on the local network, if using DLNA browsing
- `ffmpeg` and `ffprobe` on the connector machine for automatic browser-friendly audio transcoding
- HTTPS for non-localhost production use

## Quick start

Create a virtual environment and install dependencies:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Create a local environment file and set web-app credentials:

```bash
cp .env.example .env
```

Edit `.env` and change at least:

```text
FILE_PIPE_AUTH_USERNAME=admin
FILE_PIPE_AUTH_PASSWORD=change-this-password
FILE_PIPE_SECRET_KEY=change-this-secret-key
```

Start the web app:

```bash
python app.py --debug
```

Open:

```text
https://127.0.0.1:6500
```

The app creates a reusable local self-signed certificate in `ssl/` by default. Your browser will show a certificate warning the first time. Accept it for local development, or provide a browser-trusted certificate with `--cert` and `--key`.

Start the local connector in a second terminal:

```bash
python local_connector.py --password "choose-a-password"
```

Before using the connector from the web UI, open this URL in the same browser and accept the certificate warning:

```text
https://127.0.0.1:8765/health
```

Then use the Local Connector tab in the web UI to unlock the connector, scan for DLNA servers, choose a server, and browse media from the Explorer tab.

The browser remembers the connector URL, connector session token, and last selected media source/folder in local storage so reloads after a deploy can return to the same browsing context. Connector passwords are not saved.

## Authentication

The Flask web app requires login by default. Credentials are loaded from environment variables or from a local `.env` file:

```text
FILE_PIPE_AUTH_USERNAME=admin
FILE_PIPE_AUTH_PASSWORD=use-a-strong-password
FILE_PIPE_SECRET_KEY=generate-a-long-random-secret
```

Generate a session secret with:

```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

Login attempts are rate limited by client IP:

```text
FILE_PIPE_LOGIN_RATE_LIMIT=5
FILE_PIPE_LOGIN_RATE_WINDOW_SECONDS=300
```

Watch room entry does not require login. Anonymous access to `/watch/<room_id>` and viewer-side watch-room APIs is rate limited by client IP:

```text
FILE_PIPE_PUBLIC_ACCESS_RATE_LIMIT=120
FILE_PIPE_PUBLIC_ACCESS_RATE_WINDOW_SECONDS=60
```

For local testing only, authentication or login rate limiting can be disabled:

```text
FILE_PIPE_AUTH_DISABLED=true
FILE_PIPE_LOGIN_RATE_LIMIT_DISABLED=true
FILE_PIPE_PUBLIC_ACCESS_RATE_LIMIT_DISABLED=true
```

Do not use those bypasses on a LAN or internet-facing deployment.

## Standalone local connector

The local connector can also run as a small standalone desktop-style app for macOS or Windows. It starts the connector, opens a local management UI, and stores settings in the user's app-data folder instead of the project directory.

Run it from source:

```bash
python3 connector_standalone.py
```

On Windows:

```powershell
py connector_standalone.py
```

The UI opens at:

```text
https://127.0.0.1:8765/admin
```

From that UI you can manage the connector host and port, HTTPS, password protection, discovered DLNA connections, and cached transcode files. Host, port, and TLS changes are saved for the next launch. Password and cache-directory changes apply immediately.

Build a standalone executable on the target OS:

```bash
python3 -m pip install -r requirements-standalone.txt
python3 -m PyInstaller file_pipe_connector.spec
```

On Windows:

```powershell
py -m pip install -r requirements-standalone.txt
py -m PyInstaller file_pipe_connector.spec
```

macOS produces `dist/File Pipe Connector.app`. Windows produces `dist/FilePipeConnector.exe`. PyInstaller does not cross-compile, so build the Mac app on macOS and the Windows executable on Windows.

Standalone runtime files are written to:

- macOS: `~/Library/Application Support/File Pipe/`
- Windows: `%APPDATA%\File Pipe\`
- Override for testing or portable builds: set `FILE_PIPE_HOME`.

## Common commands

Run the web app with the default local HTTPS certificate:

```bash
python app.py
```

Run the web app on plain HTTP for same-machine testing only:

```bash
python app.py --no-tls --debug
```

Run the connector with password protection:

```bash
python local_connector.py --password "choose-a-password"
```

Run the connector with a certificate trusted by your browser:

```bash
python local_connector.py \
  --cert /path/to/cert.pem \
  --key /path/to/key.pem \
  --password "choose-a-password"
```

Use an environment variable instead of putting the connector password in shell history:

```bash
export FILE_PIPE_CONNECTOR_PASSWORD="choose-a-password"
python local_connector.py
```

## How sharing works

File Pipe has three sharing modes:

- File share: creates a `/share/<id>#key=...` link for a DLNA file or manually selected local file.
- Watch room: creates a `/watch/<id>#key=...` link and browser-generated QR code for synchronized video watching.
- Bigscreen link: creates a `/bigscreen/<id>#key=...` link for Bigscreen's web browser.

For file shares and watch rooms:

1. The sender browser reads the selected media.
2. The sender browser generates an AES-GCM key with Web Crypto.
3. File metadata is encrypted before it is published to the Flask app.
4. The decryption key is placed in the URL fragment after `#key=`.
5. URL fragments are not sent to the server in HTTP requests.
6. WebRTC signaling goes through Flask, but encrypted media data moves browser-to-browser.
7. Recipients acknowledge file name, size, type, and MD5 checksum before saving or playback.
8. The recipient browser verifies the MD5 after decryption.

The sender tab must stay open until transfers complete.

When a DLNA video's default audio track is not browser-playable, the local connector can transcode it once to a cached MP4/AAC file under `instance/transcodes/`. The standalone connector uses its configured cache folder instead. Completed transcodes keep a stable source-key cache path and, once the source MD5 is known, an MD5-keyed cache alias so the same cached file can be reused across connector restarts. The player, watch rooms, and Bigscreen links then use that stable cached file for checksum and range-based streaming.

## Security model

File Pipe is designed so the hosted Flask app never receives the decryption key and never needs plaintext media.

Important details:

- The local connector can be password protected.
- Password login over plain HTTP is blocked unless `--allow-insecure-password` is explicitly passed.
- Connector login returns an in-memory bearer token, so later requests do not resend the password.
- The Flask web app is protected by username/password login unless explicitly disabled for local testing.
- Failed login attempts are rate limited by default.
- The reusable development certificate and private key live under `ssl/` for source runs, or under the standalone app-data folder for packaged connector runs.
- Generated certificates, virtualenvs, local share data, logs, dotenv files, and credentials are ignored by Git.
- The Flask signaling state is in memory. Restarting the Flask process loses active share, watch room, and Bigscreen sessions.
- Internet-to-home and cellular watch-room sessions may require a TURN relay. Configure one with `FILE_PIPE_TURN_URLS`, `FILE_PIPE_TURN_USERNAME`, and `FILE_PIPE_TURN_CREDENTIAL`.

This is still development software. Before production use, add lifecycle cleanup, request size limits, and a deployment-specific authentication model if the Flask app is public.

## TLS notes

By default, both `app.py` and `local_connector.py` create and reuse:

```text
ssl/file-pipe-local.crt
ssl/file-pipe-local.key
```

Delete the `ssl/` directory to force regeneration.

Use `--adhoc-tls` for a throwaway self-signed certificate:

```bash
python app.py --adhoc-tls
python local_connector.py --adhoc-tls --password "choose-a-password"
```

Use `--no-tls` only for isolated localhost testing. Do not use it for LAN or internet-facing access.

## Troubleshooting

If connector requests fail in the browser, first open:

```text
https://127.0.0.1:8765/health
```

Accept the certificate warning in that browser, then retry the Local Connector tab.

If the connector logs HTTP 400 errors with binary-looking text like `\x16\x03\x01`, the browser is sending HTTPS to a connector running plain HTTP. Fix the URL scheme in the UI, or restart the connector with HTTPS enabled.

If DLNA discovery finds no servers:

- Confirm the DLNA server is on the same local network.
- Confirm the connector is running on a machine that can reach that network.
- Check local firewall rules for UDP multicast discovery and HTTP access to the DLNA server.
- Run discovery again from the Local Connector tab.

If WebRTC peers cannot connect after the answer is sent, the network likely needs a TURN relay. This is common when a phone is on cellular and the host is behind a home router.

Configure TURN with simple environment variables:

```bash
FILE_PIPE_STUN_URLS=stun:stun.l.google.com:19302
FILE_PIPE_TURN_URLS=turn:turn.example.com:3478,turns:turn.example.com:5349
FILE_PIPE_TURN_USERNAME=file-pipe
FILE_PIPE_TURN_CREDENTIAL=replace-with-turn-password
```

For advanced providers that return a complete WebRTC config, use `FILE_PIPE_ICE_SERVERS_JSON` instead:

```bash
FILE_PIPE_ICE_SERVERS_JSON='[{"urls":"stun:stun.l.google.com:19302"},{"urls":["turn:turn.example.com:3478","turns:turn.example.com:5349"],"username":"file-pipe","credential":"replace-with-turn-password"}]'
```

Set `FILE_PIPE_ICE_TRANSPORT_POLICY=relay` temporarily if you want to force all WebRTC media/data through TURN while testing.

## Deployment

Deploy these files to a Flask-capable host:

- `app.py`
- `app.json`
- `Procfile`
- `gunicorn.conf.py`
- `local_tls.py`
- `requirements.txt`
- `.env.example` as a template only, not as production secrets
- `static/`
- `templates/`

Each user still needs to run `local_connector.py` on the same machine as their browser or on a trusted machine that can reach their DLNA server. The hosted Flask app cannot discover or access private LAN DLNA devices directly.

Serve the deployed site over HTTPS. Browser Web Crypto, service workers, microphone capture, and cross-origin private-network access all depend on secure browser contexts.

For HTTPS deployments, set:

```text
FILE_PIPE_SESSION_COOKIE_SECURE=true
FILE_PIPE_AUTH_DISABLED=false
FILE_PIPE_LOGIN_RATE_LIMIT_DISABLED=false
```

For the Dokku deployment to `pipe.milkyway.place`, see `DOKKU.md`.

## Project layout

```text
app.py               Flask web UI and WebRTC signaling API
app.json             Dokku health check metadata
Procfile             Dokku/Herokuish web process
gunicorn.conf.py     Production Gunicorn settings
local_connector.py   Local DLNA/UPnP bridge
local_tls.py         Local certificate generation helper
connector_standalone.py Browser-launched standalone connector wrapper
standalone_admin.py  Connector management UI and admin API
standalone_config.py Cross-platform standalone settings paths
file_pipe_connector.spec PyInstaller build recipe
requirements.txt     Python dependencies
requirements-standalone.txt Build dependencies for the standalone app
.env.example         Local environment variable template
static/              Browser JavaScript, service worker, and CSS
templates/           Flask HTML templates
ssl/                 Generated local TLS material, ignored by Git
instance/            Local runtime data, ignored by Git
```

## Git hygiene

The `.gitignore` is intentionally strict. It excludes generated TLS private keys, real dotenv files, virtualenvs, runtime share data, logs, build output, and common editor/OS noise. `.env.example` is intentionally allowed so required configuration is documented without committing secrets.

If any ignored secret or generated file was already committed before these rules existed, remove it from Git history or at least untrack it:

```bash
git rm --cached -r ssl instance .venv
```

Only run that command inside an initialized Git repository after reviewing what will be removed from version control.
