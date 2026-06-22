# Deploying ScalpX on a DigitalOcean droplet

End-to-end in ~30 minutes. Cost: **$4/month** (Bangalore region, recommended for NSE).

## 1. Create the droplet

1. Sign in to <https://cloud.digitalocean.com>.
2. **Create → Droplets**.
3. Region: **Bangalore (BLR1)** — best latency to NSE.
4. Image: **Ubuntu 24.04 (LTS) x64**.
5. Size: **Basic → Regular SSD → $4/mo (1 vCPU, 512 MB RAM, 10 GB)** — enough for personal use. Bump to $6/mo if you'll add other apps.
6. Authentication: **SSH key** (paste your public key) — never password.
7. Hostname: e.g. `scalpx`.
8. Click **Create Droplet**. Note the **public IPv4** — that's your forever-IP.

## 2. (Optional but recommended) Point a domain at it

In your DNS provider, create an `A` record:

```
scalpx.yourdomain.com  →  <droplet IP>
```

If you don't have a domain, skip this — Caddy will serve plain HTTP via the IP.

## 3. SSH in and run the installer

```bash
ssh root@<droplet-ip>

# One-shot bootstrap (edit REPO_URL + DOMAIN to your values first).
export REPO_URL=https://github.com/<you>/<repo>.git
export DOMAIN=scalpx.yourdomain.com   # or leave empty for IP-only

curl -fsSL https://raw.githubusercontent.com/<you>/<repo>/main/deploy/install.sh \
  | bash
```

That script:

- installs Docker + Compose,
- clones the repo,
- creates `deploy/.env` with a randomly generated `SCALPX_PEPPER`,
- runs `docker compose up -d --build`,
- prints the droplet's egress IP at the end.

## 4. Whitelist the droplet IP on Groww

1. Open `groww.in → Profile → Trading API → IP Restrictions`.
2. Add the droplet's public IP. **This is the IP that Groww will see for every order** — it never rotates.
3. Save.

## 5. Point the app at your server

In your local Expo project, set `frontend/.env`:

```env
EXPO_PUBLIC_BACKEND_URL=https://scalpx.yourdomain.com
# or:  http://<droplet-ip>
```

Reload Expo Go and you're live.

## 6. Verify

```bash
# From your laptop:
curl https://scalpx.yourdomain.com/api/
# → {"status":"ok","service":"scalpx"}

curl https://scalpx.yourdomain.com/api/auth/server-ip
# → {"ip":"<your droplet ip>","cached":false}
```

## Day-to-day commands (on the droplet)

```bash
cd /opt/scalpx/deploy

# View live logs
docker compose logs -f backend

# Update to latest code
git -C /opt/scalpx pull
docker compose up -d --build backend

# Restart everything
docker compose restart

# Stop everything
docker compose down
```

## Backup

The only state that matters lives in the `mongo_data` Docker volume (presets, settings, saved credential profiles, demo state, opening-capital snapshots).

```bash
# One-off backup to ~/scalpx-backup.tar.gz
docker run --rm -v scalpx_mongo_data:/data -v ~/:/backup busybox \
  tar czf /backup/scalpx-backup.tar.gz -C /data .
```

## Cost summary

| Item | Cost |
|---|---|
| DigitalOcean droplet (Bangalore, 1 vCPU, 512 MB) | $4/mo |
| Domain (optional) | $10–12/yr |
| HTTPS cert | $0 (Caddy + Let's Encrypt) |
| **Total** | **~₹340/mo** |
