#!/usr/bin/env node
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";

// In CI, let semantic-release handle everything
if (process.env.CI === "true") {
  process.exit(0);
}

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));
const tag = `v${pkg.version}`;

try {
  execSync(`git rev-parse ${tag}`, { stdio: "pipe" });
  console.log(`Tag ${tag} exists, proceeding with publish`);
} catch {
  console.log();
  console.log(`Warning: Tag ${tag} does not exist`);
  console.log();
  console.log("If this is your first local publish after setting up semantic-release:");
  console.log(`  1. git tag ${tag}`);
  console.log("  2. git push origin main --tags");
  console.log("  3. Then run pnpm publish again");
  console.log();
  console.log("Or push to main and let CI handle the release automatically.");
  console.log();
  console.log("Continuing anyway in 5 seconds... (Ctrl+C to cancel)");
  await setTimeout(5000);
}
