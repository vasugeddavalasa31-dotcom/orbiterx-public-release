import { defineConfig } from "electron-vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [solid()],
    build: {
      target: "esnext",
    },
    optimizeDeps: {
      esbuildOptions: {
        target: "esnext",
      },
    },
  },
});
