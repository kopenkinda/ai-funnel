# Private deployment with Coolify

Use a GitHub App application in the target Coolify project and environment:

- Repository branch: `main`, with automatic deployments enabled.
- Build pack: Dockerfile, using `/Dockerfile` at the repository root.
- Container port: `4310`.
- Host port mapping: `127.0.0.1:4310:4310`.
- Persistent volume mounted at `/app/data`.
- Runtime `PUBLIC_URL`: the HTTPS URL served by Tailscale.
- HTTP health check: `/healthz` on port `4310`.
- Runtime limits: 1 GB memory and two CPUs.
- Public domains and preview deployments disabled.

Coolify's API validator does not accept a host address in port mappings. Configure the application mapping directly when provisioning, then verify that the generated Compose file and running container bind only to `127.0.0.1`. Do not substitute `4310:4310`, which binds every host interface.

On the server, configure Tailscale without accepting DNS changes, subnet routes, or an exit node. Use Tailscale Serve for private HTTPS:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:4310
tailscale serve status
```

Keep Tailscale Funnel disabled. The proxy serves only the tailnet and does not change the existing public reverse proxy. Disable device key expiry in the Tailscale admin console for unattended operation.

If the server also advertises as an exit node, persist IPv4 and IPv6 forwarding in `/etc/sysctl.d/99-tailscale.conf` and apply that file with `sysctl -p`. Both `net.ipv4.ip_forward` and `net.ipv6.conf.all.forwarding` must be `1`. Exit-node approval is separate from the app's private HTTPS configuration.

## State and updates

Pushes to `main` reach Coolify through the registered GitHub App webhook. Coolify rebuilds the Dockerfile and restarts only this application. Loopback port mapping requires a brief stop/start rather than a rolling update. The named data volume survives replacement containers.

Preserve `state.enc`, `master.key`, and `admin-token` together. The master key is required to decrypt account credentials and settings. Back up these files privately; never add them to Git or an image. Stop the source instance before copying state, and keep only one instance refreshing the imported accounts.

Read the dashboard key from `/app/data/admin-token` inside the running application container. Account imports and API keys persist in the encrypted volume. Keep client keys in the client environment or credential manager.

After an update, verify `/healthz`, dashboard authentication, account inventory, and native client routing. Verify that port `4310` has no public listener and the other server services retain their previous health and port bindings. To roll back, redeploy a known-good Git revision using the same data volume; preserve a state backup before downgrading across schema changes.
