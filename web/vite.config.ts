import { readFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import type { Plugin } from "vite";

const generatedWasmPath = fileURLToPath(
  new URL("./src/generated/ppoker-wasm/ppoker_wasm_bg.wasm", import.meta.url),
);
const generatedWasmModulePath = fileURLToPath(
  new URL("./src/generated/ppoker-wasm/ppoker_wasm.js", import.meta.url),
);

function emitPpokerWasm(): Plugin {
  return {
    name: "emit-ppoker-wasm",
    enforce: "pre",
    async transform(code, id) {
      if (id === generatedWasmModulePath) {
        const fallback = "new URL('ppoker_wasm_bg.wasm', import.meta.url)";
        if (!code.includes(fallback)) {
          throw new Error("wasm-pack output has an unexpected asset fallback");
        }
        const reference = this.emitFile({
          type: "asset",
          fileName: "ppoker_wasm_bg.wasm",
          source: await readFile(generatedWasmPath),
        });
        return code.replace(
          fallback,
          `import.meta.ROLLUP_FILE_URL_${reference}`,
        );
      }
    },
    renderChunk(code) {
      return code.replace(/^\/\/#(?:end)?region.*\n/gmu, "");
    },
  };
}

export default defineConfig({
  plugins: [emitPpokerWasm()],
  build: {
    assetsDir: "",
    emptyOutDir: false,
    lib: {
      entry: {
        index: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
        react: fileURLToPath(new URL("./src/react.tsx", import.meta.url)),
      },
      fileName: (_format, entryName) => `${entryName}.js`,
      formats: ["es"],
    },
    minify: true,
    rollupOptions: {
      external: ["react", "react/jsx-runtime"],
      output: {
        assetFileNames: "[name][extname]",
      },
    },
    sourcemap: false,
    target: "es2022",
  },
});
