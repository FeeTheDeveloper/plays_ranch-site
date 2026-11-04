# Plays Ranch public site

The first website draft for Plays Ranch. It presents the proposed mission and operating framework as a public overview; it is not a live dashboard, product catalog, or claim that integrations or services are currently available.

## Preview

Open `index.html` in a browser or serve this folder with any static web server. The site has no build step, server, contact form, analytics, or tracking code. The only supplied brand image is the original Plays Ranch logo copied unchanged to `plays-ranch-logo.png`.

## Foundation

The working mission, audience, product structure, page map, and open decisions are in [docs/brand-foundation.md](docs/brand-foundation.md).

## Release status

This repository contains a local draft. No hosting project, custom domain, public release, or third-party integration has been configured from this repository.

## MCP connector (separate service)

`connector/` contains the Plays Ranch MCP Connector v1: a private, read-only, OAuth-protected MCP server that ChatGPT uses as a custom connector. It is deployed separately from this static site and shares no runtime with it. See [connector/README.md](connector/README.md) and the [v1 handoff](docs/mcp-connector-v1-handoff.md). It has not been deployed.
