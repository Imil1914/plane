import path from "node:path";
import * as dotenv from "dotenv";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

dotenv.config({ path: path.resolve(__dirname, ".env") });

// Expose public Vite vars and the non-secret PPM brand rollback flag.
const viteEnv = Object.keys(process.env)
  .filter((k) => k.startsWith("VITE_"))
  .reduce<Record<string, string>>((a, k) => {
    a[k] = process.env[k] ?? "";
    return a;
  }, {});

viteEnv.PPM_BRAND_ENABLED = process.env.PPM_BRAND_ENABLED ?? "1";
viteEnv.PPM_CANVAS_ENABLED = process.env.PPM_CANVAS_ENABLED ?? "1";
viteEnv.PPM_ANTYFLOW_SHELL_ENABLED = process.env.PPM_ANTYFLOW_SHELL_ENABLED ?? "1";
viteEnv.PPM_SHELL_ENABLED = process.env.PPM_SHELL_ENABLED ?? "1";
viteEnv.PPM_PROJECT_ASK_ENABLED = process.env.PPM_PROJECT_ASK_ENABLED ?? "0";
viteEnv.PPM_DESIGN_V2 = process.env.PPM_DESIGN_V2 ?? "1";

export default defineConfig(() => ({
  define: {
    "process.env": JSON.stringify(viteEnv),
  },
  build: {
    assetsInlineLimit: 0,
  },
  plugins: [reactRouter()],
  resolve: {
    tsconfigPaths: true,
    alias: {
      // Next.js compatibility shims used within web
      "next/link": path.resolve(__dirname, "app/compat/next/link.tsx"),
      "next/navigation": path.resolve(__dirname, "app/compat/next/navigation.ts"),
      "next/script": path.resolve(__dirname, "app/compat/next/script.tsx"),
    },
    dedupe: ["react", "react-dom", "@headlessui/react"],
  },
  server: {
    host: "127.0.0.1",
  },
  // No SSR-specific overrides needed; alias resolves to ESM build
}));
