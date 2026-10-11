#!/bin/sh
# Final masters: 4K render -> loudness finish (-14 LUFS, TP <= -1 dBTP) -> 1080p Lanczos downscale -> thumbnail.
# Run from video/: sh scripts/render-final.sh   (writes progress to .cache/final.log)
set -e
npx remotion render Bulwark out/bulwark-demo-4k-raw.mp4 --scale 2 --codec h264 --crf 14 --x264-preset slow --image-format png --pixel-format yuv420p --audio-codec aac --audio-bitrate 320k --log=error
node scripts/finish.mjs out/bulwark-demo-4k-raw.mp4 out/bulwark-demo-4k.mp4
ffmpeg -y -loglevel error -i out/bulwark-demo-4k.mp4 -vf scale=1920:1080:flags=lanczos -c:v libx264 -crf 16 -preset slow -pix_fmt yuv420p -c:a copy -movflags +faststart out/bulwark-demo-1080p.mp4
npx remotion still Poster out/bulwark-thumbnail.png --log=error
echo FINAL_DONE
