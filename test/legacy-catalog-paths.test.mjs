import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../site/app.js", import.meta.url), "utf8");
const declarations = source.slice(0, source.indexOf("const FOLLOW_STORAGE_KEY"))
  .replace(/^import .*;\n/gm, "")
  .replaceAll("import.meta.url", "moduleUrl");
const resolver = source.match(/function siteAssetUrl\(value\) \{[\s\S]*?\n\}/)[0]
  .replaceAll("import.meta.url", "moduleUrl");

for (const pagePath of ["", "en/", "en/index.html"]) {
  test(`legacy catalog loads shared data and previews from ${pagePath || "Chinese root"}`, () => {
    const root = "https://wchao6891.github.io/PromptDirector-Curated/";
    const location = new URL(pagePath, root);
    const result = vm.runInNewContext(`${declarations}\n${resolver}\n({
      catalog: new URL(CATALOG_URL, location.href).href,
      metrics: new URL(METRICS_URL, location.href).href,
      preview: siteAssetUrl("previews/example.json"),
      cover: siteAssetUrl("https://wchao6891.github.io/PromptDirector-Curated/covers/example.webp")
    })`, { URL, location, moduleUrl: new URL("app.js", root).href });
    assert.equal(result.catalog, root + "public-catalog.json");
    assert.equal(result.metrics, root + "metrics.json");
    assert.equal(result.preview, root + "previews/example.json");
    assert.equal(result.cover, root + "covers/example.webp");
  });
}
