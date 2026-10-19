import { defineConfig } from "mygo-cli";
import { readFileSync } from "node:fs";

const linuxReleaseVersion = process.env.PITH_DESK_LINUX_RELEASE_VERSION;

export default defineConfig({
  name: "Pith Desk",
  identifier: "org.minifish.pithdesk",
  version: linuxReleaseVersion || "0.1.0",
  icon: "frontend/public/icon.png",
  main: "./cmd/pith-desk",
  buildCommand: "npm --prefix frontend run build",
  // The host package embeds the frontend itself, so MyGo only packages
  // the native shell. No generated Go bridge is exposed to the web page.
  bindings: ".mygo/bindings.ts",
  out: "build",
  resources: ["LICENSE", "third_party", "docs/THIRD_PARTY.md", ...(linuxReleaseVersion ? ["build/linux-release-metadata/pith-desk-release.json"] : [])],
  updates: {
    publicKey: readFileSync(new URL("./resources/update-public-key.txt", import.meta.url), "utf8").trim(),
    // CI publishes this pointer only after the immutable release assets exist.
    // Preview releases are not included in GitHub's releases/latest endpoint.
    url: "https://raw.githubusercontent.com/minifish-org/pith-desk/updates/preview",
    deltas: 0,
  },
  linux: {
    command: "pith-desk",
    comment: "Desktop workspace for Pith agents",
    categories: ["Development"],
  },
  macos: {
    minimumSystemVersion: "12.0",
    signingIdentity: "-",
    infoPlist: {
      LSApplicationCategoryType: "public.app-category.productivity",
    },
  },
});
