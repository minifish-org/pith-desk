# Application icon

`icon.svg` is the editable source of the existing four-part Pith Desk mark.
`../frontend/public/icon.png` is its 1024 × 1024 transparent PNG, shared by the
browser favicon and the native application packager. MyGo generates the macOS
ICNS sizes from that PNG when building the app.

Normal builds use the checked-in PNG and need no image-generation dependencies.
After editing the SVG, regenerate it with librsvg:

```sh
rsvg-convert --width 1024 --height 1024 resources/icon.svg --output frontend/public/icon.png
```
