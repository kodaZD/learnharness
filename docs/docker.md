# Docker and Tailscale

LearnHarness can run as a web server in Docker. This deployment is intended for
a trusted private tailnet, not public or multi-user hosting: the application
does not provide per-user authentication or data isolation.

## Start

From the repository root:

```sh
cp .env.example .env
# Edit .env and set SUNSILK_API_KEY.
docker compose up -d --build
```

The Compose file binds the service to `127.0.0.1:3001` on the host by default.
Persistent application data and `auth.json` are stored on the HDD under
`/srv/learnharness/app-data`. The read-only human knowledge base is mounted at
`/knowledge` from `/srv/learnharness/human-knowledge-base`.

Open the app locally at <http://127.0.0.1:3000>, then configure the custom
provider in **Settings → Providers → Add a provider → Custom endpoint**:

```text
Base URL: https://cliproxy.sunsilk.id.vn/v1
Authentication: API key
Model ID: gpt-6-luna
```

The container passes `SUNSILK_API_KEY` to LearnHarness as
`CUSTOM_OPENAI_API_KEY`. The app still performs its own endpoint discovery and
stores the custom-provider binding in its persistent auth/settings data.

Search uses the existing gateway on the Docker network:

```text
SEARCHAPI_ENDPOINT=http://searchapi:8000
```

`SEARCH_API_BEARER_TOKEN` is read only from the container environment. It is
not part of `/api/keys`, the Settings key list, or `auth.json`.

For the web deployment, enable **Settings → Agent → Tools → Restrict to listed
folders** and add `/knowledge`. This keeps `read`, `ls`, `find`, and `grep`
inside the mounted knowledge base instead of the container's home directory.

## Tailscale Serve

Install and authenticate Tailscale on the Docker host, then publish the local
service to the tailnet:

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:3001
tailscale serve status
```

Use `https://<host>.tail<tailnet>.ts.net:8443/` from another tailnet machine.
The host already has another Tailscale Serve listener on HTTPS 443, so
LearnHarness uses 8443 to preserve that existing configuration. Stop the
LearnHarness publication with:

```sh
sudo tailscale serve --https=8443 off
```

Do not change the Compose port binding to `0.0.0.0` unless you intentionally
want the service reachable outside Tailscale. Any tailnet device that can
reach this app shares its chats, graph, settings, and provider credentials.

## Operations

```sh
docker compose ps
docker compose logs -f learnharness
docker compose restart learnharness
docker compose down
```

The application data is a host directory, so `docker compose down` does not
remove it. Remove stored data explicitly only when intended:

```sh
sudo rm -rf /srv/learnharness/app-data
```

## Files from the host

The web server reads paths from the machine/container where it runs. A file
selected on a remote browser is not automatically available inside the
container. Mount a dedicated host directory read-only if the agent needs to
read server-side files; avoid mounting a whole home directory.
