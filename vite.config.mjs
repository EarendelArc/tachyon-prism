import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const secureStorageModule = fileURLToPath(
  new URL("./src/domain/secureStorage.ts", import.meta.url),
).replaceAll("\\", "/");
const uiSmokeBackend = fileURLToPath(
  new URL("./src/domain/secureStorageBackend.ui-smoke.ts", import.meta.url),
);

function uiSmokeSecureStorageBackend(mode) {
  return {
    name: "tachyon-ui-smoke-secure-storage",
    enforce: "pre",
    resolveId(source, importer) {
      const normalizedImporter = importer?.split("?", 1)[0].replaceAll("\\", "/");
      if (
        mode === "ui-smoke" &&
        source === "./secureStorageBackend" &&
        normalizedImporter === secureStorageModule
      ) {
        return uiSmokeBackend;
      }
      return null;
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [uiSmokeSecureStorageBackend(mode), react()],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
  },
}));
