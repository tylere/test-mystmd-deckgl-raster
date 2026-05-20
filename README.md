# test-mystmd-deckgl-raster

Render Cloud-Optimized GeoTIFFs (COGs) inline in a [MyST Markdown](https://mystmd.org) document using a custom directive backed by [deck.gl](https://deck.gl) and [MapLibre GL](https://maplibre.org).

## Usage

````markdown
```{deckgl-raster} https://example.com/path/to/cog.tif
:height: 600
```
````

The directive takes the COG URL as its argument and one optional option (`height`, in px or a CSS value).

## How it works

### 1. The MyST plugin ([myst-plugins/deckgl-raster.mjs](myst-plugins/deckgl-raster.mjs))

A directive plugin loaded via `project.plugins` in [myst.yml](myst.yml). At build time the plugin:

1. Reads the viewer template HTML from [myst-plugins/deckgl-raster-viewer.html](myst-plugins/deckgl-raster-viewer.html).
2. Substitutes `__COG_URL__` with the directive's argument.
3. Base64-encodes the entire viewer and emits an `iframe` AST node with `src="data:text/html;base64,…"`.

The whole interactive viewer lives inside one `data:` URL — no static asset hosting is needed. This is important because mystmd's dev server (`myst start`) doesn't have a generic mechanism to serve arbitrary static files alongside the site: the book-theme Remix app on port 3000 only exposes a hardcoded set of routes, and although a content CDN on port 3100 does serve `_build/site/public/`, that port isn't stable and isn't reachable from an iframe placed in a published article.

### 2. The viewer ([myst-plugins/deckgl-raster-viewer.html](myst-plugins/deckgl-raster-viewer.html))

A self-contained HTML page that loads its libraries from `esm.sh` and `unpkg` via an [import map](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/script/type/importmap). It:

1. Opens the COG with [`geotiff.js`](https://geotiffjs.github.io/) (HTTP range requests, no server needed).
2. Reads the COG's GeoKeys to determine the source CRS.
3. Branches on whether the CRS is **projected** or **geographic** (see below).
4. Renders into a MapLibre map with deck.gl's `MapboxOverlay`.

## Projection handling

The viewer takes two different paths depending on the COG's CRS.

### Projected COGs (UTM, Web Mercator, etc.)

Rendered via [`COGLayer`](https://github.com/developmentseed/deck.gl-raster/blob/main/packages/deck.gl-geotiff/src/cog-layer.ts) from `@developmentseed/deck.gl-geotiff`. This:

- Fetches native COG tiles in the source CRS (no read-time reprojection).
- Uploads tiles as GPU textures.
- Warps them to Web Mercator via deck.gl-raster's WebGL shader modules.

GPU-side reprojection makes this fast even for large COGs.

### Geographic COGs (EPSG:4326)

`COGLayer` does not handle geographic source CRSs — its `metersPerUnit` helper rejects units of `degrees`. So for these, the viewer uses a hand-rolled deck.gl `TileLayer` that:

1. Receives each tile's lng/lat bbox from deck.gl.
2. Picks the best COG overview level for the current zoom.
3. Reads a windowed range of pixels from that overview with `geotiff.js`.
4. Renders them with a `BitmapLayer`, using the window's exact lng/lat bounds (no reprojection — the source and the BitmapLayer both use lng/lat).

This path requires no proj4 calls per pixel and is fast.

### Custom `epsgResolver` for COGLayer

`COGLayer` takes an `epsgResolver(epsgCode)` callback to translate an EPSG code into a proj4 projection definition. The package's default resolver fetches PROJJSON from [epsg.io](https://epsg.io) and parses it with `wkt-parser`. That fails for any code whose modern PROJJSON uses a `datum_ensemble` group instead of a single `datum` — including all WGS84 UTM zones — because `wkt-parser` doesn't understand the newer schema and returns a definition object missing `projName`, which then causes proj4 to throw `Could not get projection name from: [object Object]`.

The viewer ships a small custom resolver that bypasses `wkt-parser` for the common cases. It hand-builds a proj4 string and asks proj4 itself to parse it, which guarantees the result is in a format proj4 accepts. Currently covers:

- EPSG:3857 (Web Mercator)
- EPSG:32601–32660 (WGS84 UTM zones 1–60 North)
- EPSG:32701–32760 (WGS84 UTM zones 1–60 South)

Adding more CRSs is a one-line addition per code in the `projStr()` function. Codes outside this set will currently fail with a clear error.

### Sharing proj4 with the bundled module

`@developmentseed/deck.gl-geotiff` is loaded from esm.sh with `?bundle-deps&external=proj4`. The `external=proj4` flag keeps `proj4` outside the bundle, which means the bundled module resolves its `proj4` import via the page's import map and ends up sharing the **same** proj4 instance the viewer uses. This is what lets a definition object built in our resolver be passed into `COGLayer`'s internal proj4 calls — same registry of projection classes, same registry of EPSG definitions.

## Caveats

### Workers can't run in a `data:` URL iframe

The viewer is embedded as a `data:` URL, which gives the iframe a null/opaque origin. Browsers refuse to construct `Worker`s in null-origin documents (the script URL must be same-origin to the document). `@developmentseed/deck.gl-geotiff`'s default decoder pool uses a Web Worker pool, so we explicitly construct a `DecoderPool({})` with no `createWorker` factory — decoding happens on the main thread.

This trades parallel off-thread decode for compatibility. For modest COGs it's fine; for very large ones the UI thread will block during decode. The fix would be to serve the viewer as a real same-origin HTML file, but mystmd currently has no built-in way to serve such files (see [How it works → The MyST plugin](#1-the-myst-plugin-myst-pluginsdeckgl-rastermjs) above).

### Modern PROJJSON schema

As described under [Projection handling](#projection-handling), only the CRSs registered in `projStr()` work with `COGLayer`. If you point the directive at a COG in some other projected CRS, it will fail. The workaround is to extend `projStr()`.

### CORS

The browser fetches the COG directly via HTTP range requests, so the COG host must serve `Access-Control-Allow-Origin` and allow the `Range` header. Public hosts like `data.source.coop` and `sentinel-cogs.s3.us-west-2.amazonaws.com` do this correctly.

### Basemap

The MapLibre basemap is fetched from `basemaps.cartocdn.com`. Disable it (or swap to a blank style) if you need a fully offline viewer.

## Running locally

```bash
pixi run -- myst start
```

Then open [http://localhost:3000](http://localhost:3000).

## Deploying to GitHub Pages

The workflow at [.github/workflows/deploy.yml](.github/workflows/deploy.yml) builds the static site with `myst build --html` and publishes `_build/html/` to GitHub Pages on every push to `main` (and on manual dispatch).

One-time setup in the GitHub repo: **Settings → Pages → Build and deployment → Source: "GitHub Actions"**.

The workflow sets `BASE_URL: /test-mystmd-deckgl-raster` so internal links work under the GitHub Pages subpath. If you fork the repo under a different name, update that value in the workflow.

The viewer works on Pages without any extra static-file handling because the entire viewer is embedded as a `data:` URL in the article HTML (see [How it works](#how-it-works)).

## Files

| Path | Purpose |
| ---- | ------- |
| [myst.yml](myst.yml) | MyST project config; loads the plugin. |
| [article.md](article.md) | Test article exercising the directive. |
| [myst-plugins/deckgl-raster.mjs](myst-plugins/deckgl-raster.mjs) | The directive plugin (Node-side). |
| [myst-plugins/deckgl-raster-viewer.html](myst-plugins/deckgl-raster-viewer.html) | The browser-side viewer template. |
| [pixi.toml](pixi.toml) | Pixi environment with mystmd. |
