import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node18",
  clean: true,
  splitting: false,
  banner: {
    js: "#!/usr/bin/env node",
  },
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
});
