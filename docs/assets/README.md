# Assets

`social-preview.png` (1280 x 640) is the repository's GitHub social preview,
the image shown when a link to the repository is shared. It is uploaded by
hand under Settings, General, Social preview, so a change here does not reach
GitHub by itself. When the banner (`banner-dark.png`, `banner-light.png`)
changes, remake this image to match and upload it again.

`scripts/render-assets.ts` renders both banners and the social preview from one
template, so a change to the name, tagline or chips reaches all three. It needs
a Chrome or Chromium binary and the Lato font:

```bash
CHROME=/path/to/chrome bun scripts/render-assets.ts
```

It also writes `source.json`: the tagline, chips and facts the images show, from
`scripts/lib/brand.ts`, and a hash of each image. `bun run check` fails when
that text no longer matches `brand.ts` or an image no longer matches its hash,
so changing the text or an image without rerunning the renderer is caught.

It renders the social preview pixel for pixel like the committed file. The
banners were first rendered through Playwright, so a rerun redraws their text
edges slightly differently (about 1.4% of their pixels).
