#!/bin/sh
# Finals: 4K ProRes HQ master -> H.264 4K (~45 Mbps) and 1080p (~14 Mbps, Lanczos), both at -14 LUFS / TP <= -1 dBTP -> thumbnail.
# Run from video/: sh scripts/render-final.sh   (writes progress to .cache/final.log)
set -e
npx remotion render Bulwark out/master-prores.mov --scale 2 --codec prores --prores-profile hq --image-format png --audio-codec pcm-16 --log=error
node scripts/final.mjs
npx remotion still Poster out/bulwark-thumbnail.png --log=error
echo FINAL_DONE
