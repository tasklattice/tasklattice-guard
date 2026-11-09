// Maintenance command only: consumes a local LiteLLM download, never runs in production.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { parseLiteLLMPrices, LITELLM_PRICE_URL } from "../server/services/model-pricing-domain.ts";

const [input, version] = process.argv.slice(2);
if (!input || !version || !/^\d{4}-\d{2}-\d{2}(?:\.[\w-]+)?$/.test(version)) {
  throw new Error("Usage: node --import tsx scripts/update-model-prices.mjs /path/to/litellm.json YYYY-MM-DD[.revision]");
}
const raw = await readFile(input);
const prices = Object.fromEntries([...parseLiteLLMPrices(JSON.parse(raw.toString("utf8")))].sort(([a], [b]) => a.localeCompare(b, "en")));
const licenseNotice = `MIT License
Copyright (c) 2023 Berri AI
Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;
const snapshot = { version, sourceUrl: LITELLM_PRICE_URL, sourceSha256: createHash("sha256").update(raw).digest("hex"), licenseNotice, prices };
await mkdir(new URL("../server/catalog/", import.meta.url), { recursive: true });
await writeFile(new URL("../server/catalog/model-prices.json", import.meta.url), `${JSON.stringify(snapshot, null, 2)}\n`);
process.stdout.write(`Bundled ${Object.keys(prices).length} USD prices (${version}). Review the diff before release.\n`);
