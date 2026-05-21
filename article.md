# Test COG Rendering

## Pick a COG

```{anywidget} ./widgets/cog-selector.mjs
{
  "label": "Source:",
  "event": "cog-url-change",
  "urls": [
    { "label": "EPSG:4326 — waternet",        "url": "https://data.source.coop/fika/waternet/raster/29_26.tif" },
    { "label": "EPSG:32618 — Sentinel-2 TCI", "url": "https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/18/T/WL/2026/1/S2B_18TWL_20260101_0_L2A/TCI.tif" },
    { "label": "EPSG:2193 — NZTM RGB",        "url": "https://nz-imagery.s3-ap-southeast-2.amazonaws.com/new-zealand/new-zealand_2024-2025_10m/rgb/2193/CC11.tiff" }
  ]
}
```

```{anywidget} ./widgets/cog-zoom-slider.mjs
{
  "label": "Zoom:",
  "event": "cog-zoom-change",
  "min": 0,
  "max": 22,
  "step": 0.5
}
```

```{anywidget} ./widgets/cog-viewer.mjs
{
  "listen": "cog-url-change",
  "zoomListen": "cog-zoom-change",
  "height": 600
}
```