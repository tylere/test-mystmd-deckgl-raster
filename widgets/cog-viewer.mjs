// Anywidget COG viewer.
//
// Imports are deliberately full esm.sh URLs (no import map; anywidget can't
// supply one). The widget renders inside an open shadow root, so MapLibre's
// stylesheet has to be injected into `el` — the document <head> doesn't
// reach us.

import maplibregl from "https://esm.sh/maplibre-gl@4.7.1";
import { MapboxOverlay } from "https://esm.sh/@deck.gl/mapbox@9.3.0";
import { TileLayer } from "https://esm.sh/@deck.gl/geo-layers@9.3.0";
import { BitmapLayer } from "https://esm.sh/@deck.gl/layers@9.3.0";
import { fromUrl } from "https://esm.sh/geotiff@2.1.3";
import proj4 from "https://esm.sh/proj4@2.11.0";

const MAPLIBRE_CSS_URL = "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css";

async function ensureMaplibreCSS(el) {
  // Inject MapLibre CSS into the shadow root. Cached across instances.
  if (!ensureMaplibreCSS._cssText) {
    const r = await fetch(MAPLIBRE_CSS_URL);
    ensureMaplibreCSS._cssText = await r.text();
  }
  const style = document.createElement("style");
  style.textContent = ensureMaplibreCSS._cssText;
  el.appendChild(style);
}

function projStr(epsg) {
  if (epsg === 4326) return "+proj=longlat +datum=WGS84 +no_defs";
  if (epsg === 3857) return "+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs";
  if (epsg >= 32601 && epsg <= 32660) return `+proj=utm +zone=${epsg - 32600} +datum=WGS84 +units=m +no_defs`;
  if (epsg >= 32701 && epsg <= 32760) return `+proj=utm +zone=${epsg - 32700} +south +datum=WGS84 +units=m +no_defs`;
  if (epsg === 2193) return "+proj=tmerc +lat_0=0 +lon_0=173 +k=0.9996 +x_0=1600000 +y_0=10000000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs";
  return null;
}

function makeStretchByte(nodata) {
  return (band) => {
    if (band instanceof Uint8Array) return band;
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < band.length; i++) {
      const v = band[i];
      if (nodata != null && v === nodata) continue;
      if (!Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (!Number.isFinite(min) || max === min) { min = 0; max = 1; }
    const out = new Uint8Array(band.length);
    const scale = 255 / (max - min);
    for (let i = 0; i < band.length; i++) {
      const v = band[i];
      out[i] = (nodata != null && v === nodata) ? 0 : Math.max(0, Math.min(255, (v - min) * scale));
    }
    return out;
  };
}

function rastersToRGBA(rasters, w, h, samplesPerPixel, nodata) {
  const stretchByte = makeStretchByte(nodata);
  const rgba = new Uint8ClampedArray(w * h * 4);
  if (samplesPerPixel >= 3) {
    const r = stretchByte(rasters[0]);
    const g = stretchByte(rasters[1]);
    const b = stretchByte(rasters[2]);
    const a = samplesPerPixel >= 4 ? stretchByte(rasters[3]) : null;
    for (let i = 0, j = 0; i < w * h; i++, j += 4) {
      rgba[j] = r[i]; rgba[j+1] = g[i]; rgba[j+2] = b[i];
      rgba[j+3] = a ? a[i] : (nodata != null && rasters[0][i] === nodata ? 0 : 255);
    }
  } else {
    const v = stretchByte(rasters[0]);
    const src = rasters[0];
    for (let i = 0, j = 0; i < w * h; i++, j += 4) {
      const isNodata = nodata != null && src[i] === nodata;
      rgba[j] = rgba[j+1] = rgba[j+2] = v[i];
      rgba[j+3] = isNodata ? 0 : 255;
    }
  }
  return rgba;
}

async function indexLevels(tiff, mainW) {
  const count = await tiff.getImageCount();
  const levels = [];
  for (let i = 0; i < count; i++) {
    const img = await tiff.getImage(i);
    levels.push({ image: img, width: img.getWidth(), height: img.getHeight(), scale: mainW / img.getWidth() });
  }
  levels.sort((a, b) => a.scale - b.scale);
  return levels;
}

// ---- Geographic path: BitmapLayer bounds = native COG window bounds. ----
function geographicTileLayer({ main, levels, samplesPerPixel, nodata }) {
  const [originX, originY] = main.getOrigin();
  const [resX, resY] = main.getResolution();
  return new TileLayer({
    id: "cog-tiles",
    tileSize: 256,
    extent: main.getBoundingBox(),
    maxRequests: 6,
    getTileData: async ({ bbox: { west, south, east, north }, signal }) => {
      const px = (x) => (x - originX) / resX;
      const py = (y) => (y - originY) / resY;
      const px0 = Math.min(px(west), px(east));
      const px1 = Math.max(px(west), px(east));
      const py0 = Math.min(py(south), py(north));
      const py1 = Math.max(py(south), py(north));
      const targetDownsample = Math.max(1, (px1 - px0) / 256);
      let chosen = levels[0];
      for (const lvl of levels) {
        if (lvl.scale <= targetDownsample) chosen = lvl; else break;
      }
      const s = chosen.scale;
      const lx0 = Math.max(0, Math.floor(px0 / s) - 1);
      const lx1 = Math.min(chosen.width, Math.ceil(px1 / s) + 1);
      const ly0 = Math.max(0, Math.floor(py0 / s) - 1);
      const ly1 = Math.min(chosen.height, Math.ceil(py1 / s) + 1);
      if (lx1 <= lx0 || ly1 <= ly0) return null;
      const winW = lx1 - lx0, winH = ly1 - ly0;
      const rasters = await chosen.image.readRasters({ window: [lx0, ly0, lx1, ly1], interleave: false, signal });
      const rgba = rastersToRGBA(rasters, winW, winH, samplesPerPixel, nodata);
      const canvas = document.createElement("canvas");
      canvas.width = winW; canvas.height = winH;
      canvas.getContext("2d").putImageData(new ImageData(rgba, winW, winH), 0, 0);
      const wLng = originX + lx0 * s * resX;
      const eLng = originX + lx1 * s * resX;
      const nLat = originY + ly0 * s * resY;
      const sLat = originY + ly1 * s * resY;
      return { image: await createImageBitmap(canvas), bounds: [wLng, Math.min(nLat, sLat), eLng, Math.max(nLat, sLat)] };
    },
    renderSubLayers: (props) => {
      if (!props.data) return null;
      return new BitmapLayer(props, { data: null, image: props.data.image, bounds: props.data.bounds });
    },
  });
}

// ---- Projected path: per-tile reprojection on a 17×17 grid + bilinear. ----
function projectedTileLayer({ main, levels, samplesPerPixel, nodata, epsg }) {
  const [originX, originY] = main.getOrigin();
  const [resX, resY] = main.getResolution();
  const toSrc = (lng, lat) => proj4("EPSG:4326", `EPSG:${epsg}`, [lng, lat]);
  const N = 17;

  return new TileLayer({
    id: "cog-tiles",
    tileSize: 256,
    maxRequests: 6,
    getTileData: async ({ bbox: { west, south, east, north }, signal }) => {
      // Coarse grid of source-CRS coords across the tile.
      const gridX = new Float64Array(N * N);
      const gridY = new Float64Array(N * N);
      for (let j = 0; j < N; j++) {
        const t = j / (N - 1);
        const lat = north + (south - north) * t;
        for (let i = 0; i < N; i++) {
          const s = i / (N - 1);
          const lng = west + (east - west) * s;
          const [x, y] = toSrc(lng, lat);
          gridX[j * N + i] = x;
          gridY[j * N + i] = y;
        }
      }
      let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
      for (let k = 0; k < N * N; k++) {
        if (gridX[k] < xMin) xMin = gridX[k];
        if (gridX[k] > xMax) xMax = gridX[k];
        if (gridY[k] < yMin) yMin = gridY[k];
        if (gridY[k] > yMax) yMax = gridY[k];
      }

      const px = (x) => (x - originX) / resX;
      const py = (y) => (y - originY) / resY;
      const px0 = Math.min(px(xMin), px(xMax));
      const px1 = Math.max(px(xMin), px(xMax));
      const py0 = Math.min(py(yMin), py(yMax));
      const py1 = Math.max(py(yMin), py(yMax));
      const targetDownsample = Math.max(1, (px1 - px0) / 256);
      let chosen = levels[0];
      for (const lvl of levels) {
        if (lvl.scale <= targetDownsample) chosen = lvl; else break;
      }
      const ss = chosen.scale;
      let lx0 = Math.max(0, Math.floor(px0 / ss) - 1);
      let lx1 = Math.min(chosen.width, Math.ceil(px1 / ss) + 1);
      let ly0 = Math.max(0, Math.floor(py0 / ss) - 1);
      let ly1 = Math.min(chosen.height, Math.ceil(py1 / ss) + 1);
      if (lx1 <= lx0 || ly1 <= ly0) return null;
      const winW = lx1 - lx0, winH = ly1 - ly0;
      const rasters = await chosen.image.readRasters({ window: [lx0, ly0, lx1, ly1], interleave: false, signal });
      const winRGBA = rastersToRGBA(rasters, winW, winH, samplesPerPixel, nodata);

      // Bilinear-interpolate (cell_i, cell_j) across the N×N grid for each
      // output pixel; sample winRGBA at the resulting source pixel.
      const outW = 256, outH = 256;
      const out = new Uint8ClampedArray(outW * outH * 4);
      const cellW = (outW - 1) / (N - 1);
      const cellH = (outH - 1) / (N - 1);
      for (let j = 0; j < outH; j++) {
        const gj = j / cellH;
        const gj0 = Math.min(N - 2, Math.floor(gj));
        const fj = gj - gj0;
        for (let i = 0; i < outW; i++) {
          const gi = i / cellW;
          const gi0 = Math.min(N - 2, Math.floor(gi));
          const fi = gi - gi0;
          const k00 = gj0 * N + gi0;
          const k10 = gj0 * N + gi0 + 1;
          const k01 = (gj0 + 1) * N + gi0;
          const k11 = (gj0 + 1) * N + gi0 + 1;
          const sx =
            gridX[k00] * (1 - fi) * (1 - fj) + gridX[k10] * fi * (1 - fj) +
            gridX[k01] * (1 - fi) * fj       + gridX[k11] * fi * fj;
          const sy =
            gridY[k00] * (1 - fi) * (1 - fj) + gridY[k10] * fi * (1 - fj) +
            gridY[k01] * (1 - fi) * fj       + gridY[k11] * fi * fj;
          const lpx = (sx - originX) / (resX * ss);
          const lpy = (sy - originY) / (resY * ss);
          const wpx = Math.floor(lpx) - lx0;
          const wpy = Math.floor(lpy) - ly0;
          const oOff = (j * outW + i) * 4;
          if (wpx < 0 || wpx >= winW || wpy < 0 || wpy >= winH) {
            out[oOff + 3] = 0;
            continue;
          }
          const sOff = (wpy * winW + wpx) * 4;
          out[oOff]     = winRGBA[sOff];
          out[oOff + 1] = winRGBA[sOff + 1];
          out[oOff + 2] = winRGBA[sOff + 2];
          out[oOff + 3] = winRGBA[sOff + 3];
        }
      }
      const canvas = document.createElement("canvas");
      canvas.width = outW; canvas.height = outH;
      canvas.getContext("2d").putImageData(new ImageData(out, outW, outH), 0, 0);
      return await createImageBitmap(canvas);
    },
    renderSubLayers: (props) => {
      if (!props.data) return null;
      const { west, south, east, north } = props.tile.bbox;
      return new BitmapLayer(props, { data: null, image: props.data, bounds: [west, south, east, north] });
    },
  });
}

async function render({ model, el }) {
  const initialUrl = model.get("url");
  const height = Number(model.get("height")) || 500;
  const listen = model.get("listen") ?? null;

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

  let currentMap = null;
  // Monotonic counter so a slow-loading old request can't stomp on a newer one.
  let loadSeq = 0;

  async function loadCog(url) {
    const seq = ++loadSeq;
    showUrlBadge(url);
    // Tear down any previous map in the same container.
    if (currentMap) {
      try { currentMap.remove(); } catch { /* ignore */ }
      currentMap = null;
    }

    try {
      setStatus(`Probing COG: ${url}`);
      const tiff = await fromUrl(url);
      if (seq !== loadSeq) return; // a newer load started while we were probing
      const main = await tiff.getImage(0);
      const geoKeys = main.getGeoKeys() ?? {};
      const epsg = geoKeys.ProjectedCSTypeGeoKey || geoKeys.GeographicTypeGeoKey || 4326;
      const isGeographic = !geoKeys.ProjectedCSTypeGeoKey;
      const samplesPerPixel = main.getSamplesPerPixel();
      const nodata = main.getGDALNoData();
      const mainBbox = main.getBoundingBox();
      const levels = await indexLevels(tiff, main.getWidth());
      if (seq !== loadSeq) return;

      if (!isGeographic) {
        const ps = projStr(epsg);
        if (!ps) { showError(`Unsupported EPSG:${epsg}. Add a proj4 string to projStr().`); return; }
        proj4.defs(`EPSG:${epsg}`, ps);
      }

      const map = new maplibregl.Map({
        container: mapDiv,
        style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
        center: [0, 0],
        zoom: 1,
      });
      currentMap = map;
      await new Promise((r) => map.on("load", r));
      if (seq !== loadSeq) { try { map.remove(); } catch { /* ignore */ } return; }

      const layer = isGeographic
        ? geographicTileLayer({ main, levels, samplesPerPixel, nodata })
        : projectedTileLayer({ main, levels, samplesPerPixel, nodata, epsg });

      map.addControl(new MapboxOverlay({ layers: [layer] }));

      // Fit to COG bounds in WGS84.
      let bounds;
      if (isGeographic) {
        bounds = [[mainBbox[0], mainBbox[1]], [mainBbox[2], mainBbox[3]]];
      } else {
        const toWGS = (x, y) => proj4(`EPSG:${epsg}`, "EPSG:4326", [x, y]);
        const [w, s] = toWGS(mainBbox[0], mainBbox[1]);
        const [e, n] = toWGS(mainBbox[2], mainBbox[3]);
        bounds = [[Math.min(w, e), Math.min(s, n)], [Math.max(w, e), Math.max(s, n)]];
      }
      map.fitBounds(bounds, { padding: 20, duration: 0 });
      status.remove();
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
    if (currentMap) { try { currentMap.remove(); } catch { /* ignore */ } }
    el.replaceChildren();
  };
}

export default { render };
