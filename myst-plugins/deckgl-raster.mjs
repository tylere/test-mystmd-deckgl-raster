import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const viewerTemplate = readFileSync(join(here, "deckgl-raster-viewer.html"), "utf8");

const directive = {
  name: "deckgl-raster",
  arg: { type: String, doc: "URL to a COG" },
  options: {
    height: { type: String },
  },
  run(data) {
    const cogUrl = data.arg;
    const height = data.options?.height ?? "500";
    const html = viewerTemplate.replaceAll("__COG_URL__", cogUrl);
    const b64 = Buffer.from(html, "utf8").toString("base64");
    return [{
      type: "iframe",
      src: `data:text/html;base64,${b64}`,
      width: "100%",
      height,
    }];
  },
};

export default { name: "deckgl-raster", directives: [directive] };
