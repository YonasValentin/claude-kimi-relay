// Single source for the version the relay reports over ACP and MCP. Kept in
// sync with package.json and the plugin manifests by scripts/bump-version.mjs
// (and asserted by scripts/check-release.mjs). A build-time constant rather
// than a runtime package.json read, because the esbuild plugin bundle ships
// next to a `{"type":"module"}` stub with no version field.
export const VERSION = "0.2.0";
