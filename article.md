# Test COG Rendering

## Test CRS EPSG:4326

```{anywidget} ./widgets/cog-viewer.mjs
{
  "url": "https://data.source.coop/fika/waternet/raster/29_26.tif",
  "height": 600
}
```

<div style="height: 3em"></div>

## Test CRS EPSG:32618

```{anywidget} ./widgets/cog-viewer.mjs
{
  "url": "https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/18/T/WL/2026/1/S2B_18TWL_20260101_0_L2A/TCI.tif",
  "height": 600
}
```

<div style="height: 3em"></div>

## Test CRS EPSG:2193

```{anywidget} ./widgets/cog-viewer.mjs
{
  "url": "https://nz-imagery.s3-ap-southeast-2.amazonaws.com/new-zealand/new-zealand_2024-2025_10m/rgb/2193/CC11.tiff",
  "height": 600
}
```