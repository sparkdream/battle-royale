import { defineConfig } from "vite";

export default defineConfig({
  server: { port: 5173, host: true }, // host: reachable from other machines on the LAN
  build: { target: "es2022", chunkSizeWarningLimit: 2000 },
});
