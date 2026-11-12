# One origin: the API serves the web app

`onrender.com` is on the Public Suffix List, so separate Render subdomains for the web app and the API count as different sites, and Safari blocks the third-party cookies that owner and buyer sessions depend on. One Render web service therefore serves the built web app and the API, with API routes under `/api`. This removes CORS and per-service origin settings, and costs us the free static site.

## Consequences

The service must run as a single instance, because the live feed fans out in memory and the repair loop runs in process.
