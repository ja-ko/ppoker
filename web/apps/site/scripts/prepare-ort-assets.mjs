import { copyFile, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const assets = ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"];
const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const installedPackage = JSON.parse(
  await readFile(
    new URL("../node_modules/onnxruntime-web/package.json", import.meta.url),
    "utf8",
  ),
);

if (installedPackage.version !== packageJson.dependencies["onnxruntime-web"]) {
  throw new Error(
    `onnxruntime-web ${installedPackage.version} does not match package.json ${packageJson.dependencies["onnxruntime-web"]}`,
  );
}

const destination = fileURLToPath(new URL("../public/ort/", import.meta.url));
const sources = new Map(
  assets.map((asset) => [
    asset,
    fileURLToPath(import.meta.resolve(`onnxruntime-web/${asset}`)),
  ]),
);

let current = false;
try {
  const generatedAssets = await readdir(destination);
  current =
    generatedAssets.length === assets.length &&
    assets.every((asset) => generatedAssets.includes(asset));
  for (const asset of current ? assets : []) {
    const [source, generated] = await Promise.all([
      readFile(sources.get(asset)),
      readFile(join(destination, asset)),
    ]);
    if (!source.equals(generated)) {
      current = false;
      break;
    }
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

if (!current) {
  await rm(destination, { force: true, recursive: true });
  await mkdir(destination, { recursive: true });
  for (const [asset, source] of sources) {
    await copyFile(source, join(destination, asset));
  }
}

console.log(
  `Prepared ONNX Runtime ${installedPackage.version} assets in public/ort`,
);
