// Anywidget COG viewer.
//
// Imports are deliberately full esm.sh URLs (no import map; anywidget can't
// supply one). The widget renders inside an open shadow root, so MapLibre's
// stylesheet has to be injected into `el` — the document <head> doesn't
// reach us.
//
// COG tiling is delegated to @developmentseed/deck.gl-geotiff's COGLayer,
// which GPU-warps the source-CRS pixels into web-mercator. Reprojection,
// overview selection, and tile fetching all happen inside the layer.
//
// One non-obvious bit: @developmentseed/geotiff's default DecoderPool spawns
// Workers from esm.sh URLs, which browsers reject as cross-origin. We pass an
// explicit DecoderPool({ size: 0 }) so decoding runs on the main thread.
//
// TODO: restore worker-pool decoding via a same-origin blob URL — fetch the
// esm.sh worker source as text, wrap in `new Blob([src], { type: ... })`, and
// pass `createWorker: () => new Worker(URL.createObjectURL(blob), { type:
// "module" })`. Skipped here to keep the change minimal; worth doing if
// main-thread decode causes visible jank on larger/compressed COGs.

import maplibregl from "https://esm.sh/maplibre-gl@4.7.1";
import { MapboxOverlay } from "https://esm.sh/@deck.gl/mapbox@9.3.0";
import { COGLayer } from "https://esm.sh/@developmentseed/deck.gl-geotiff@0.7.0";
import { DecoderPool } from "https://esm.sh/@developmentseed/geotiff@0.7.0";

const MAPLIBRE_CSS_URL = "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css";

// Shared across widget instances; main-thread decode, no workers.
const decoderPool = new DecoderPool({ size: 0 });

async function ensureMaplibreCSS(el) {
  if (!ensureMaplibreCSS._cssText) {
    const r = await fetch(MAPLIBRE_CSS_URL);
    ensureMaplibreCSS._cssText = await r.text();
  }
  const style = document.createElement("style");
  style.textContent = ensureMaplibreCSS._cssText;
  el.appendChild(style);
}

async function render({ model, el }) {
  const initialUrl = model.get("url");
  const height = Number(model.get("height")) || 500;
  const listen = model.get("listen") ?? null;
  const zoomListen = model.get("zoomListen") ?? null;

  // Subscribe synchronously — before any `await` — so we don't miss a live
  // event from a sibling selector. Events that arrive during async init are
  // buffered into `pendingUrl` and consumed once setup completes. We also
  // check the selector's latest-value global as a fallback for the case where
  // the selector mounted (and fired) before we got here.
  let pendingUrl = initialUrl ?? null;
  if (listen && !pendingUrl) {
    const stashed = window.__cogSelectorLatest?.[listen];
    if (typeof stashed === "string" && stashed) pendingUrl = stashed;
  }
  let ready = false;
  let onEvent = null;
  if (listen) {
    onEvent = (e) => {
      const url = e?.detail?.url;
      if (typeof url !== "string" || !url) return;
      if (ready) loadCog(url);
      else pendingUrl = url;
    };
    window.addEventListener(listen, onEvent);
  }

  // Hoisted because the synchronous zoomListen handler below references them
  // before the rest of render() (after the awaits) initializes them.
  let currentMap = null;
  let loadSeq = 0;

  // Same pattern as `listen`, for zoom: subscribe synchronously, buffer events
  // that arrive before the map exists, and apply them once a map is around.
  // Map-sourced events are ignored (we set them, no need to re-apply).
  let pendingZoom = null;
  if (zoomListen) {
    const stashed = window.__cogZoomLatest?.[zoomListen];
    if (typeof stashed === "number") pendingZoom = stashed;
  }
  let onZoomEvent = null;
  if (zoomListen) {
    onZoomEvent = (e) => {
      const detail = e?.detail;
      if (!detail || typeof detail.zoom !== "number") return;
      if (detail.source === "map") return; // our own outbound, ignore
      if (currentMap) currentMap.setZoom(detail.zoom);
      else pendingZoom = detail.zoom;
    };
    window.addEventListener(zoomListen, onZoomEvent);
  }

  // Container + status banner inside the shadow root.
  el.style.position = "relative";
  el.style.height = `${height}px`;
  el.style.width = "100%";

  await ensureMaplibreCSS(el);

  const mapDiv = document.createElement("div");
  Object.assign(mapDiv.style, { position: "absolute", inset: "0" });
  el.appendChild(mapDiv);

  const status = document.createElement("div");
  Object.assign(status.style, {
    position: "absolute", top: "8px", left: "8px", zIndex: "10",
    font: "12px/1.3 system-ui, sans-serif",
    background: "rgba(255,255,255,0.9)",
    padding: "6px 8px", borderRadius: "4px", maxWidth: "80%",
    whiteSpace: "pre-wrap",
  });
  status.textContent = listen ? "Waiting for selection…" : "Loading…";
  el.appendChild(status);
  const setStatus = (msg) => {
    status.style.background = "rgba(255,255,255,0.9)";
    status.style.color = "";
    status.textContent = msg;
    if (!el.contains(status)) el.appendChild(status);
  };
  const showError = (msg) => {
    if (!el.contains(status)) el.appendChild(status);
    status.style.background = "#fee";
    status.style.color = "#900";
    status.textContent = String(msg);
  };

  // Badge in the top-right showing the URL of the COG currently loaded.
  // Long URLs are truncated with ellipsis; full URL is in the link title.
  const urlBadge = document.createElement("div");
  Object.assign(urlBadge.style, {
    position: "absolute",
    top: "8px",
    right: "8px",
    zIndex: "10",
    font: "11px/1.3 system-ui, sans-serif",
    background: "rgba(255,255,255,0.85)",
    color: "#333",
    padding: "3px 6px",
    borderRadius: "3px",
    maxWidth: "60%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    display: "none",
  });
  el.appendChild(urlBadge);
  const showUrlBadge = (url) => {
    urlBadge.replaceChildren();
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    a.title = url;
    a.textContent = url;
    Object.assign(a.style, { color: "inherit", textDecoration: "none" });
    urlBadge.appendChild(a);
    urlBadge.style.display = "block";
  };

  async function loadCog(url) {
    const seq = ++loadSeq;
    showUrlBadge(url);
    if (currentMap) {
      try { currentMap.remove(); } catch { /* ignore */ }
      currentMap = null;
    }

    setStatus(`Loading COG: ${url}`);

    const map = new maplibregl.Map({
      container: mapDiv,
      style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
      center: [0, 0],
      zoom: 1,
    });
    currentMap = map;

    try {
      await new Promise((r) => map.on("load", r));
      if (seq !== loadSeq) { try { map.remove(); } catch { /* ignore */ } return; }

      // Attach the zoom broadcaster BEFORE fitBounds. fitBounds({duration:0})
      // fires zoomend synchronously inside the call, so if we attached this
      // after fitBounds the slider would never hear about the new map's zoom.
      if (zoomListen) {
        map.on("zoomend", () => {
          const z = map.getZoom();
          if (!window.__cogZoomLatest) window.__cogZoomLatest = {};
          window.__cogZoomLatest[zoomListen] = z;
          window.dispatchEvent(new CustomEvent(zoomListen, { detail: { zoom: z, source: "map" } }));
        });
      }

      const overlay = new MapboxOverlay({
        onError: (e) => {
          if (seq === loadSeq) showError("Layer error: " + (e?.message ?? String(e)));
        },
        layers: [],
      });
      map.addControl(overlay);

      const layer = new COGLayer({
        id: "cog",
        geotiff: url,
        pool: decoderPool,
        onGeoTIFFLoad: (_geotiff, opts) => {
          if (seq !== loadSeq) return;
          const b = opts.geographicBounds;
          if (Number.isFinite(b.west) && Number.isFinite(b.east) && b.east > b.west) {
            map.fitBounds([[b.west, b.south], [b.east, b.north]], { padding: 20, duration: 0 });
          }
          // Slider may have broadcast a zoom during async init; apply now so
          // it overrides fitBounds' default.
          if (pendingZoom != null) {
            map.setZoom(pendingZoom);
            pendingZoom = null;
          }
          status.remove();
        },
        onTileError: (e) => {
          if (seq === loadSeq) showError("Tile error: " + (e?.message ?? String(e)));
        },
      });
      overlay.setProps({ layers: [layer] });
    } catch (e) {
      if (seq === loadSeq) showError(e?.message ?? String(e));
    }
  }

  ready = true;
  if (pendingUrl) {
    loadCog(pendingUrl);
  } else if (!listen) {
    showError("cog-viewer: provide 'url' or 'listen'.");
  }

  return () => {
    if (onEvent) window.removeEventListener(listen, onEvent);
    if (onZoomEvent) window.removeEventListener(zoomListen, onZoomEvent);
    if (currentMap) { try { currentMap.remove(); } catch { /* ignore */ } }
    el.replaceChildren();
  };
}

export default { render };
