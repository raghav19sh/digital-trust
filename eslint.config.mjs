import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals.js";

const nextConfig = Array.isArray(nextVitals) ? nextVitals : [nextVitals];

export default defineConfig([
  ...nextConfig,
  globalIgnores([".next/**", "node_modules/**"]),
]);