# Deployment

## Storage

`DATA_DIR` holds three files that belong together:

- `state.enc`: AES-256-GCM encrypted credentials, account state, key policies, settings, quota snapshots, sessions and request metadata.
- `master.key`: decrypts `state.enc`. Losing it makes the state unreadable.
- `admin-token`: the generated dashboard key, unless `ADMIN_TOKEN` is set.

The SDK uses the encrypted store for login and token refresh, so no persistent plaintext credential files are created. Temporary OAuth callback files live in the private `oauth-sessions` directory until the SDK consumes them. All files use owner-only permissions. A lock file allows one process per data directory.

Back up the whole directory while the service is stopped. Dashboard sessions use HTTP-only cookies, and dashboard mutations reject foreign origins. Runtime data, environment files and local notes are excluded from Git and Docker build contexts.

## Docker

The image runs a single Go process. `compose.yaml` publishes `127.0.0.1:4310` and keeps state in the `funnel-data` named volume mounted at `/app/data`. Do not bind `4310:4310`, which listens on every host interface, and do not run two containers against the same volume.

Set `PUBLIC_URL` to the canonical HTTPS origin. To keep a second dashboard origin, such as a private Tailscale hostname next to a public domain, list it in `DASHBOARD_ORIGINS`.

## Coolify

Use a GitHub App application in the target Coolify project and environment:

- Repository branch: `main`, with automatic deployments enabled.
- Build pack: Dockerfile, using `/Dockerfile` at the repository root.
- Container port: `4310`.
- Host port mapping: `127.0.0.1:4310:4310`.
- Persistent volume mounted at `/app/data`.
- Runtime `PUBLIC_URL`: the canonical HTTPS dashboard URL.
- HTTP health check: `/healthz` on port `4310`.
- Runtime limits: 1 GB memory and two CPUs.
- Preview deployments disabled.

Coolify's API validator does not accept a host address in port mappings. Configure the application mapping directly when provisioning, then verify that the generated Compose file and running container bind only to `127.0.0.1`. Do not substitute `4310:4310`, which binds every host interface.

## Private HTTPS

Leave the application's public domain empty. On the server, configure Tailscale without accepting DNS changes, subnet routes, or an exit node. Use Tailscale Serve for private HTTPS:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:4310
tailscale serve status
```

Keep Tailscale Funnel disabled. The proxy serves only the tailnet and does not change the existing public reverse proxy. Disable device key expiry in the Tailscale admin console for unattended operation.

If the server also advertises as an exit node, persist IPv4 and IPv6 forwarding in `/etc/sysctl.d/99-tailscale.conf` and apply that file with `sysctl -p`. Both `net.ipv4.ip_forward` and `net.ipv6.conf.all.forwarding` must be `1`. Exit-node approval is separate from the app's private HTTPS configuration.

## Public HTTPS

Point the hostname at the server and add its `https://` URL to the application's Coolify domains. Coolify's reverse proxy routes to container port 4310 and issues and renews the certificate through its existing Let's Encrypt resolver. Keep the host port mapping on loopback.

Set `PUBLIC_URL` to the public HTTPS origin. To retain dashboard access through Tailscale too, set `DASHBOARD_ORIGINS` to the private HTTPS origin. This optional comma-separated list adds exact allowed origins for dashboard mutations and browser WebSockets. Other browser origins remain blocked. Existing native clients can continue using the tailnet endpoint.

The login page and static assets are public. Dashboard operations require a dashboard session or dashboard key; provider calls require a granted client key. The scoped usage hub requires its management key. Raw CLIProxyAPI management routes remain blocked.

## State and updates

Pushes to `main` reach Coolify through the registered GitHub App webhook. Coolify rebuilds the Dockerfile and restarts only this application. Loopback port mapping requires a brief stop/start rather than a rolling update. The named data volume survives replacement containers.

Preserve `state.enc`, `master.key`, and `admin-token` together. The master key is required to decrypt account credentials and settings. Back up these files privately; never add them to Git or an image. Stop the source instance before copying state, and keep only one instance refreshing the imported accounts.

Read the dashboard key from `/app/data/admin-token` inside the running application container. Account imports and API keys persist in the encrypted volume. Keep client keys in the client environment or credential manager.

After an update, verify `/healthz`, dashboard authentication, account inventory, and native client routing. Verify that port `4310` has no public listener and the other server services retain their previous health and port bindings. To roll back, redeploy a known-good Git revision using the same data volume; preserve a state backup before downgrading across schema changes.
