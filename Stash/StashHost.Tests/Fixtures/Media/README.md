# Media test fixtures

Real photos and videos used by `FunctionAppMediaTests` to exercise the StashHost.Functions
activity pipeline (decode → convert → thumbnail → store) with genuine media instead of
synthetic 4x4 images.

They are test-only inputs. The application never reads them at runtime.

| File | Role | Size | SHA-256 |
|---|---|---|---|
| `cat_1280.jpg` | portrait JPEG photo (pass-through path) | 546,059 B | `23eff170b96a0cade67f883208772b3a5cec7091c6728a33ef2acd90b869bb9f` |
| `transparent_checkerboard.png` | 800x600 RGBA PNG (alpha → JPEG) | 224,566 B | `c4e870d358d64ce677e958c156d0e3fba466993d8e915fc81c5dc64937a9b696` |
| `cat_1280.webp` | WebP derivative of the JPEG (WebP → JPEG) | 375,200 B | `8b832967e894052ec3ad1a2f532d07b563bd4b1af3025ece3ad6ef8bb2998211` |
| `big_buck_bunny_360p_10s.mp4` | H.264/AAC MP4 (already-final format) | 991,017 B | `77145c94c11f3754207499158df22406e1fe7635553c1c86dc5e881dfeb32016` |
| `big_buck_bunny_360p_clip.mov` | 5 s QuickTime remux (MOV → MP4 transcoding) | 479,842 B | `3ff6c9eb0c511cd21fbca2da7e9ad5e1c45345e0713b6c81a696185af70cc2fc` |

`FunctionAppMediaTests.MediaFixtures_MatchDocumentedHashesAndSizes` fails if a binary is
truncated or replaced without updating this table.

## Sources

### `cat_1280.jpg`

- **Original:** https://commons.wikimedia.org/wiki/File:Cat_November_2010-1a.jpg
- **Downloaded from:** https://upload.wikimedia.org/wikipedia/commons/thumb/4/4d/Cat_November_2010-1a.jpg/1280px-Cat_November_2010-1a.jpg
- **Author:** Alvesgaspar (own work)
- **License:** CC BY-SA 3.0 — https://creativecommons.org/licenses/by-sa/3.0/
- **Dimensions:** 1280 x 1709 (portrait, EXIF orientation already applied)

### `transparent_checkerboard.png`

- **Original:** https://commons.wikimedia.org/wiki/File:PNG_transparency_demonstration_1.png
- **Downloaded from:** https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png
- **Authors:** POV-Ray rendering; 2005 Daniel G., 2009 Ed g2s, 2019 CyberShadow
- **License:** CC BY-SA 3.0 — https://creativecommons.org/licenses/by-sa/3.0/
- **Dimensions:** 800 x 600, 8-bit RGBA

### `big_buck_bunny_360p_10s.mp4`

- **Downloaded from:** https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4
- **Source film:** Big Buck Bunny, © Blender Foundation — https://peach.blender.org/
- **License:** CC BY 3.0 — https://creativecommons.org/licenses/by/3.0/
- **Video:** H.264, 640 x 360, 10 s (with AAC audio)

### `cat_1280.webp` (derived)

Produced from `cat_1280.jpg` so the fixture keeps the CC BY-SA 3.0 provenance:

```bash
ffmpeg -hide_banner -loglevel error -y -i cat_1280.jpg -c:v libwebp -quality 80 cat_1280.webp
```

### `big_buck_bunny_360p_clip.mov` (derived)

A five-second QuickTime remux of the downloaded MP4 (clearly-licensed source rather than
an unlicensed sample file):

```bash
ffmpeg -hide_banner -loglevel error -y -i big_buck_bunny_360p_10s.mp4 \
  -t 5 -c copy -f mov big_buck_bunny_360p_clip.mov
```

## Updating the fixtures

1. Download/replace the file.
2. Recompute `sha256sum` and the byte length.
3. Update this table and the `DocumentedFixtures` array in
   `StashHost.Tests/FunctionAppMediaTests.cs`.
4. Keep the files small (a few hundred kilobytes); they are committed to git.
