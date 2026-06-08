# UAGC WebScraper

A backend-powered, Canvas-enhanced dashboard for crawling published pages from a starting URL and scanning for targeted content across the site.

The app uses the supplied UAGC logo and the provided developer image as the scan-progress hero background. It is intentionally dependency-free, so it runs with Node.js alone.

## What it scans

The dashboard lets you choose content categories and detailed filters for:

- Term and phrase matches
- Images, formats, alt text, and missing alt attributes
- Videos: YouTube embeds, HTML5 videos, transcripts, captions
- PDFs: linked, embedded, downloadable, file size
- Links: internal, external, optional broken-link checks
- Metadata: title, meta description, canonical, robots, optional Open Graph/social metadata
- Forms: inquiry, lead, application, and all forms
- Accessibility checks: empty headings, duplicate IDs, missing labels
- SEO checks: missing title, missing meta description, noindex, optional missing canonical

The paragraph type, standalone heading, structured data, analytics, blocks, tables, and document content filters have been removed from the dashboard and backend scan pipeline.

## Features

- No configured page-count limit. The crawler stops when the discovered same-domain queue is exhausted.
- Starts with the provided URL, reads sitemap locations from `robots.txt`, tries common sitemap URLs, then follows internal links.
- Same-host crawling by default, with an option to include external PDFs.
- Accuracy-first worker defaults with configurable concurrency, request retries, longer timeouts, and bounded link checking for efficient validation.
- Live dashboard updates through Server-Sent Events.
- Pause, resume, cancel, and download progress while the scan runs.
- Cancel stops the current scan, clears the active queue, and aborts in-flight requests where possible. It does not launch a new scan automatically.
- Streaming editable CSV results so large scans do not need to keep every result in memory.
- Matched-content preview cells are editable; changes are saved and applied to the CSV download.
- CSV download is available during and after the scan. The app does not auto-download the CSV when a scan completes.
- Before download, you can edit the CSV file name in the export panel.
- CSV output uses four columns only: `Page URL`, `Content Type`, `Match Detail`, and `Context`.
- CSV filename default: `UAGC_webscrape_MM_DD_YY.csv`.

> Note: the original request used `MM/DD/YY`, but slashes are directory separators on most systems, so the downloadable filename uses underscores.

## Requirements

- Node.js 18 or newer.
- No npm dependencies are required.

## Run locally

```bash
cd uagc-webscraper
npm start
```

Then open:

```text
http://localhost:3000
```

## Configuration

Environment variables:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `PORT` | `3000` | App port |
| `HOST` | `0.0.0.0` | Bind host |
| `CRAWL_WORKERS` | `12` | Default accuracy-first parallel crawler workers |
| `FETCH_TIMEOUT_MS` | `25000` | Page fetch timeout |
| `LINK_TIMEOUT_MS` | `12000` | HEAD/GET timeout for link checks |
| `MAX_LINK_CHECKS_PER_PAGE` | `125` | Safety throttle for broken-link checks per page |
| `USER_AGENT` | `UAGC-WebScraper/1.4 (+https://www.uagc.edu)` | Crawler user agent |
| `MAX_FETCH_RETRIES` | `2` | Retry attempts for transient network, 429, and 5xx errors |
| `RETRY_BASE_DELAY_MS` | `350` | Base retry backoff delay in milliseconds |
| `ALLOW_PRIVATE_NETWORKS` | `false` | Set to `true` to scan localhost/private network URLs during testing |

Example:

```bash
PORT=8080 CRAWL_WORKERS=16 npm start
```

## API endpoints

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/health` | Basic health check |
| `POST` | `/api/scan/start` | Start a scan |
| `GET` | `/api/scan/:id/events` | Server-Sent Events stream |
| `GET` | `/api/scan/:id/status` | Current scan snapshot |
| `POST` | `/api/scan/:id/pause` | Pause a scan |
| `POST` | `/api/scan/:id/resume` | Resume a scan |
| `POST` | `/api/scan/:id/stop` | Cancel/stop a scan |
| `GET` | `/api/scan/:id/progress.json` | Download progress snapshot |
| `POST` | `/api/scan/:id/result-edits` | Save editable CSV field updates from the dashboard preview |
| `GET` | `/api/scan/:id/results.csv` | Download current or completed editable CSV |

## Project structure

```text
uagc-webscraper/
  server.js
  package.json
  README.md
  public/
    index.html
    styles.css
    app.js
    assets/
      uagc-logo.png
      progress-bg.png
      dashboard-reference.png
  data/
    scans/
```

`data/scans/` is used at runtime for per-scan CSV files and is ignored by git.

## Notes for production hardening

This build is ready for local or internal use. For production, consider adding authentication, persistent job storage, distributed workers, a database-backed result store, and stricter allowlists for approved domains.
ved domains.


## v1.5 fix

- Fixed a startup UI error where a missing or cached button reference could cause `Cannot set properties of null (setting disabled)`.
- Added null-safe button state handling.
- Removed default checked states from content filters in the HTML markup.
- Added a cache-busted app script reference so browsers load the latest dashboard JavaScript.
