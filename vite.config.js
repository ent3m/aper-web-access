import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {},
  test: { include: ["src/**/*.test.js"] },
  build: { lib: { entry: "src/worker.js", formats: ["es"], fileName: "worker" }, minify: false },
});
