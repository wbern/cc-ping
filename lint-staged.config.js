export default {
  "*.{ts,tsx}": [
    "biome check --write --no-errors-on-unmatched",
    () => "tsc --noEmit",
  ],
  "*.{js,jsx,cjs,mjs}": ["biome check --write --no-errors-on-unmatched"],
  "*.json": ["biome check --write --no-errors-on-unmatched"],
  "*": ["secretlint"],
};
