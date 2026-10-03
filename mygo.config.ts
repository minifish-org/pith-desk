import { defineConfig } from "mygo-cli";

export default defineConfig({
  name: "Pith Desk",
  identifier: "org.minifish.pithdesk",
  version: "0.1.0",
  main: "./cmd/pith-desk",
  buildCommand: "npm --prefix frontend run build",
  // The host package embeds the frontend itself, so MyGo only packages
  // the native shell. No generated Go bridge is exposed to the web page.
  bindings: ".mygo/bindings.ts",
  out: "build",
  macos: {
    minimumSystemVersion: "12.0",
    signingIdentity: "-",
    infoPlist: {
      LSApplicationCategoryType: "public.app-category.productivity",
    },
  },
});
