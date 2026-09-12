import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  exports: {
    customExports: (exports) => ({
      ...exports,
      "./tokens.css": "./src/tokens.css",
      "./assets/mark.svg": "./assets/mark.svg",
      "./assets/logo.svg": "./assets/logo.svg",
    }),
  },
});
