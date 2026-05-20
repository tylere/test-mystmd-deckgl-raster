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
    let parsed;
    try {
      parsed = new URL(data.arg);
    } catch {
      throw new Error(`deckgl-raster: invalid COG URL: ${data.arg}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`deckgl-raster: COG URL must use http(s): ${data.arg}`);
    }
    const cogUrl = parsed.toString();
    const height = data.options?.height ?? "500";
    // JSON.stringify safely escapes quotes/backslashes/newlines for a JS string
    // literal; additionally escape "<" to prevent a "</script>" breakout from
    // the surrounding <script> block in the iframe template.
    const cogUrlLiteral = JSON.stringify(cogUrl).replace(/</g, "\\u003c");
    const html = viewerTemplate.replaceAll("__COG_URL__", cogUrlLiteral);
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
