# Screenshots

These images are captures of the real dashboard in dark mode at a 1440 px wide viewport and 2x scale, with the default email blur on.

To refresh them:

1. Build the app and start it against an empty temporary `DATA_DIR` on a spare port, with `HOST=127.0.0.1`, a matching `PUBLIC_URL` and a throwaway `ADMIN_TOKEN`. Never point a second process at a data directory that holds real accounts.
2. Produce an anonymized copy of `/api/state` and `/api/requests?page=1`. Replace emails, account and key IDs, key names and prefixes, and set `publicUrl` to `https://funnel.example.com`. Keep connection IDs `codex` and `claude`. Keep the copy outside the repository.
3. With Playwright, route those two endpoints and `/api/session` to the anonymized copy, reject other API calls, wait for fonts, move the pointer out of the page, and capture `/usage`, `/keys`, `/activity`, the Codex **URL & setup** dialog and the **Settings** dialog.
4. Open every image at full size and check that no real names, emails, hostnames or key values are visible before committing.
