import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: process.env["VITE_PPOKER_ROUTER_MODE"] === "hash" ? "./" : "/",
  plugins: [react()],
  resolve: {
    conditions: ["onnxruntime-web-use-extern-wasm"],
  },
});
