import buildManifest from "../build-manifest.json";

export const PPM_BRAND = {
  name: "PPM",
  title: "PPM — проектный интеллект",
  description: "Единое пространство для проектов, знаний и решений команды.",
  themeColor: "#0E0F12",
  accentColor: "#22D3EE",
  assets: {
    mark: "/ppm-brand/mark.svg",
    logo: "/ppm-brand/logo.svg",
    manifest: "/site.ppm.webmanifest.json",
  },
} as const;

export const PPM_BUILD_MANIFEST = buildManifest;
export const PLANE_SOURCE_ATTRIBUTION = PPM_BUILD_MANIFEST.plane;

const DISABLED_FLAG_VALUES = new Set(["0", "false", "no", "off", "disabled"]);

/**
 * PPM branding is enabled by default for PPM builds. Set
 * PPM_BRAND_ENABLED=0 to restore the untouched Plane presentation.
 */
export function isPpmBrandEnabled(value: string | undefined): boolean {
  if (value === undefined || value.trim() === "") return true;
  return !DISABLED_FLAG_VALUES.has(value.trim().toLowerCase());
}
