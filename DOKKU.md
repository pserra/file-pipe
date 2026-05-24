# Dokku Deployment

This app is configured for Dokku's Python buildpack using:

- `Procfile` for the web process
- `gunicorn.conf.py` for production Gunicorn settings
- `app.json` for Dokku deploy health checks
- `/health` as an unauthenticated health endpoint

Target:

```text
app: file-pipe
domain: pipe.milkyway.place
host: milkyway.place
```

## First-time server setup

Run from this machine:

```bash
ssh dokku@milkyway.place apps:create file-pipe
ssh dokku@milkyway.place domains:set file-pipe pipe.milkyway.place
ssh dokku@milkyway.place config:set file-pipe \
  FILE_PIPE_AUTH_USERNAME='admin' \
  FILE_PIPE_AUTH_PASSWORD='replace-with-a-strong-password' \
  FILE_PIPE_SECRET_KEY='replace-with-a-generated-secret' \
  FILE_PIPE_AUTH_DISABLED='false' \
  FILE_PIPE_LOGIN_RATE_LIMIT_DISABLED='false' \
  FILE_PIPE_PUBLIC_ACCESS_RATE_LIMIT='120' \
  FILE_PIPE_PUBLIC_ACCESS_RATE_WINDOW_SECONDS='60' \
  FILE_PIPE_PUBLIC_ACCESS_RATE_LIMIT_DISABLED='false' \
  FILE_PIPE_SESSION_COOKIE_SECURE='true' \
  FILE_PIPE_STUN_URLS='stun:stun.l.google.com:19302' \
  FILE_PIPE_TURN_URLS='turn:turn.example.com:3478,turns:turn.example.com:5349' \
  FILE_PIPE_TURN_USERNAME='file-pipe' \
  FILE_PIPE_TURN_CREDENTIAL='replace-with-turn-password'
```

Generate values locally:

```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

If the Let's Encrypt plugin does not already have a global email configured:

```bash
ssh dokku@milkyway.place letsencrypt:set --global email your-email@example.com
```

## Deploy

Push to GitHub:

```bash
git remote add origin git@github.com:pserra/file-pipe.git
git branch -M main
git push -u origin main
```

Deploy to Dokku from GitHub:

```bash
ssh dokku@milkyway.place git:sync --build file-pipe https://github.com/pserra/file-pipe.git main
```

Or deploy directly from this checkout:

```bash
git remote add dokku dokku@milkyway.place:file-pipe
git push dokku main
```

After the first successful deploy, enable or renew Let's Encrypt:

```bash
ssh dokku@milkyway.place letsencrypt:enable file-pipe
```

## Useful checks

```bash
ssh dokku@milkyway.place ps:report file-pipe
ssh dokku@milkyway.place domains:report file-pipe
ssh dokku@milkyway.place letsencrypt:active file-pipe
ssh dokku@milkyway.place logs file-pipe -t
curl -I https://pipe.milkyway.place/health
```

## Notes

- Do not commit `.env`; production configuration belongs in Dokku config.
- The Flask app intentionally fails closed if auth credentials are missing.
- `/health` is public so Dokku can perform startup checks and external monitors can verify the app is alive.
- Watch-room state and WebRTC signaling are in memory. They reset when the web process restarts.
