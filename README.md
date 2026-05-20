# test-mystmd-deckgl-raster

Render Cloud-Optimized GeoTIFFs (COGs) inline in a [MyST Markdown](https://mystmd.org) document using [anywidget](https://anywidget.dev/) modules backed by [deck.gl](https://deck.gl), [MapLibre GL](https://maplibre.org), [geotiff.js](https://geotiffjs.github.io/), and [proj4](http://proj4js.org/).

Two small widgets live under [widgets/](widgets/):

- **[widgets/cog-viewer.mjs](widgets/cog-viewer.mjs)** — renders a single COG into a deck.gl + MapLibre map.
- **[widgets/cog-selector.mjs](widgets/cog-selector.mjs)** — a `<select>` dropdown that broadcasts the chosen COG URL to subscribed viewers.

Both are loaded via mystmd's built-in `{anywidget}` directive — no custom MyST plugin.

## Usage

### Single COG, hardcoded URL

````markdown
```{anywidget} ./widgets/cog-viewer.mjs
{
  "url": "https://example.com/path/to/cog.tif",
  "height": 600
}
```
````

### Linked selector + viewer

````markdown
```{anywidget} ./widgets/cog-selector.mjs
{
  "label": "Source:",
  "event": "cog-url-change",
  "urls": [
    { "label": "Site A", "url": "https://example.com/a.tif" },
    { "label": "Site B", "url": "https://example.com/b.tif" }
  ]
}
```

```{anywidget} ./widgets/cog-viewer.mjs
{
  "listen": "cog-url-change",
  "height": 600
}
```
````

The selector dispatches a `window` `CustomEvent` named by `event` (default `cog-url-change`). Any viewer with a matching `listen` value reloads when the dropdown changes.

### Widget parameters

`cog-viewer.mjs`:

| Param | Type | Default | Meaning |
|---|---|---|---|
| `url` | `string` | – | COG URL to load immediately. |
| `listen` | `string` | – | Event name to subscribe to. Reloads the map on each event. |
| `height` | `number` | `500` | Map height in pixels. |

At least one of `url` and `listen` must be set. They can both be set — `url` loads immediately, then any later event replaces it.

`cog-selector.mjs`:

| Param | Type | Default | Meaning |
|---|---|---|---|
| `urls` | `(string \| {label, url})[]` | required | Options. Bare strings used as both label and URL. |
| `event` | `string` | `"cog-url-change"` | Name of the `CustomEvent` to dispatch. |
| `label` | `string` | `"COG:"` | Label shown next to the `<select>`. |
| `initial` | `number \| string \| null` | `0` | Initially-selected option (index or URL). Pass `null` to skip the initial broadcast. |

## How it works

### Anywidget modules

Each `{anywidget}` directive instantiates one widget by loading the referenced ESM module and calling its `render({ model, el })` export. `el` is a fresh open shadow root attached to the article DOM. `model.get(key)` returns values parsed from the directive's JSON body. The `render` function can return a cleanup callback that runs when the widget is torn down.

Both of our widgets follow this pattern:

- Build all DOM by appending to `el` (never `document.querySelector` — the shadow root is isolated).
- Inject MapLibre's stylesheet as a `<style>` element into `el` (document-level stylesheets don't reach the shadow root).
- Return a cleanup function that removes any `window` listeners and disposes the MapLibre map.

### COG rendering

`cog-viewer.mjs` opens the COG with `geotiff.js` (HTTP range requests, no tile server) and inspects the GeoKeys. Based on whether the source CRS is geographic or projected, it picks one of two `TileLayer` strategies:

- **Geographic source (EPSG:4326)** — for each tile, compute the source-pixel window from the tile's lng/lat bbox, read it via `geotiff.readRasters`, and hand the result to a `BitmapLayer` whose `bounds` are the window's lng/lat. No reprojection: source and BitmapLayer are both lng/lat, and MapLibre's renderer warps the lng/lat rectangle into Web Mercator natively.
- **Projected source (UTM, NZTM, Web Mercator, …)** — for each tile, sample `proj4` on a 17×17 grid of lng/lat positions across the tile, then bilinear-interpolate source-CRS coordinates for every output pixel. Read the source window once with `geotiff.readRasters`, then nearest-neighbor sample to produce the output bitmap. The 17×17 grid keeps proj4 to ~290 calls per tile instead of 65 536.

`projStr()` is a small hand-rolled lookup that returns a proj4 string for each supported EPSG code. Adding a new CRS is a one-line addition; codes outside the set fail with a clear error message.

### Inter-widget communication

The two widgets are intentionally separate directives so the selector can be placed anywhere in the article (sidebar, intro, etc.). MyST's anywidget integration gives each widget an **isolated** `model` — there is no shared store across directives — so we use a `window` `CustomEvent` bus instead.

1. The selector renders a `<select>` and adds a `change` handler. On change, it stashes the URL at `window.__cogSelectorLatest[eventName]` and dispatches a `CustomEvent` of the configured name with `detail: { url }`.
2. It also fires once on mount via `queueMicrotask` so subscribed viewers can load the initial COG without user interaction.
3. The viewer subscribes synchronously at the top of its `render()` — before any `await` — so it doesn't miss a live event from a sibling that mounted earlier. Events that arrive while the viewer is still doing async setup are buffered into `pendingUrl` and consumed when setup completes.
4. If the viewer mounts *after* the selector's initial broadcast (so the live event was already lost), it reads `window.__cogSelectorLatest[eventName]` as a fallback. Both mount orders work.

The viewer's cleanup function removes the `window` listener and disposes the MapLibre map, so re-renders and page navigations don't leak.

## Architectural decisions

A few alternatives were tried and reverted along the way. The notes below capture **why** we landed where we did.

### Why anywidget instead of a custom MyST plugin?

The original implementation was a custom MyST plugin that emitted an `iframe` with `src="data:text/html;base64,…"` containing a full HTML viewer. That worked but had problems:

- **Workers don't run in `data:` URL iframes.** The iframe has a null/opaque origin and the browser refuses to construct workers whose script URL doesn't match. We had to use main-thread decoding.
- **Custom MyST plugin to maintain.** Build-time HTML templating, base64 encoding, manual option parsing.
- **No shared styling or theming.** Each iframe re-fetches MapLibre's CSS in isolation.
- **Hard to pass dynamic state.** Parameters were baked into the HTML at build time; there was no model API.

Anywidget gives us a shadow-DOM mount inside the article document, isolated styling and import maps but not iframe-isolated, a JSON parameter API via `model.get(key)`, and a proper teardown lifecycle.

### Why a hand-rolled `TileLayer` instead of `@developmentseed/deck.gl-geotiff`'s `COGLayer`?

`COGLayer` does GPU-side reprojection via WebGL shader modules and is the right tool in principle — but loading it from a CDN (the only option without a build step) has problems:

- esm.sh's `?bundle-deps` aggressively tree-shakes proj4's projection-class registrations. Bundled proj4 ends up with only `merc` / `longlat` / `tmerc`, so any UTM or LCC COG fails inside the bundle with `Could not get projection name from: [object Object]`.
- The workaround that does work — `?bundle-deps&external=proj4` plus a `<script type="importmap">` pointing both the page and the bundle at the same full proj4 — requires control over the article HTML's `<head>`, which anywidget widgets do not have.

For now the hand-rolled `TileLayer` uses pure JS (no GPU warp) but works for every CRS that proj4 knows, with no import-map dependency. An upstream fix has been filed against [`@developmentseed/deck.gl-raster`](https://github.com/developmentseed/deck.gl-raster) — see issue [#2](https://github.com/tylere/test-mystmd-deckgl-raster/issues/2) and [`docs/anywidget-experiment.md`](docs/anywidget-experiment.md) for the follow-up.

### Why event-bus communication instead of a composite widget?

A single widget could combine the selector and viewer into one bounding box. We chose two widgets + a window event for these reasons:

- The selector can live anywhere in the article — sidebar, intro paragraph, separate section. A composite widget couldn't.
- Multiple viewers could subscribe to the same selector (e.g. side-by-side maps).
- Each widget stays small and single-purpose.

Tradeoff: the global `window.__cogSelectorLatest` map is shared mutable state, and the contract between selector and viewer (`detail: { url }`) is informal rather than typed.

## Caveats

### CRS coverage

`projStr()` in [widgets/cog-viewer.mjs](widgets/cog-viewer.mjs) currently covers EPSG:4326, EPSG:3857, all WGS84 UTM zones (32601–32660 N, 32701–32760 S), and EPSG:2193 (NZTM2000). Other projected CRSs fail with `Unsupported EPSG:N. Add a proj4 string to projStr().` Add a new line per CRS as needed.

### CORS

The browser fetches the COG directly via HTTP range requests, so the COG host must serve `Access-Control-Allow-Origin` and allow the `Range` header. Public hosts like `data.source.coop`, `sentinel-cogs.s3.us-west-2.amazonaws.com`, and `nz-imagery.s3-ap-southeast-2.amazonaws.com` do this correctly. Self-hosted COGs may need explicit configuration.

### CDN dependencies

All JS/CSS dependencies (maplibre-gl, deck.gl, geotiff, proj4) are loaded from esm.sh and unpkg at viewer runtime. No build step is required, but the page won't work offline and is sensitive to those CDNs' availability. A future fully-offline mode would need an esbuild bundle of the same modules served alongside the article.

### Basemap

The MapLibre basemap is fetched from `basemaps.cartocdn.com`. Swap to a blank style if you need to drop that dependency.

### Decoding is single-threaded

For now the viewer decodes COG tiles on the main thread. This wasn't a choice — it's a consequence of the upstream issues described in *Why a hand-rolled `TileLayer`*. Moderate COGs are fine; very large COGs can cause UI stalls during decode. Worker-pool decoding is an open follow-up.

## Running locally

```bash
pixi run -- myst start
```

Then open [http://localhost:3000](http://localhost:3000).

## Deploying to GitHub Pages

The workflow at [.github/workflows/deploy.yml](.github/workflows/deploy.yml) builds the static site with `myst build --html` and publishes `_build/html/` to GitHub Pages on every push to `main` (and on manual dispatch).

One-time setup in the GitHub repo: **Settings → Pages → Build and deployment → Source: "GitHub Actions"**.

The workflow sets `BASE_URL: /test-mystmd-deckgl-raster` so internal links work under the GitHub Pages subpath. If you fork the repo under a different name, update that value in the workflow.

## Files

| Path | Purpose |
| ---- | ------- |
| [myst.yml](myst.yml) | MyST project config. |
| [article.md](article.md) | Test article exercising both widgets. |
| [widgets/cog-viewer.mjs](widgets/cog-viewer.mjs) | Map widget. Loads a COG and renders it. |
| [widgets/cog-selector.mjs](widgets/cog-selector.mjs) | Dropdown widget. Broadcasts the chosen URL. |
| [pixi.toml](pixi.toml) | Pixi environment with mystmd. |
| [.github/workflows/deploy.yml](.github/workflows/deploy.yml) | GitHub Pages deployment. |
| [docs/anywidget-experiment.md](docs/anywidget-experiment.md) | Follow-up tracking notes. |
