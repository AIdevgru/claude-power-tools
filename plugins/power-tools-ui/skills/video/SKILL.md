---
name: video
description: "Make a video from a request: Claude writes a storyboard, builds it in Remotion (React, three.js for 3D), checks rendered stills and renders an MP4. Asks only what's missing. Trigger on '/video <request>', 'make a video of …', 'render a product teaser' or 'animate this into an MP4'."
user-invocable: true
disable-model-invocation: false
argument-hint: "<what the video shows> [--length 20s] [--size 1080p|vertical|square|WxH] [--fps 30]"
---

# Video

Make the video that **`$ARGUMENTS`** describes and hand back an MP4. You write the storyboard and the composition code; [Remotion](https://www.remotion.dev) (React, frame by frame) renders it, with `@remotion/three` and three.js for 3D.

`VIDEO` below means `node "<this skill's base directory>/scripts/video.mjs"`. Run it with Bash and act on what it prints: JSON, or one `still: <path>` line per image. It owns the mechanical rules (lengths, sizes, folders, exact versions, how npm and the Remotion CLI are run), so don't redo them by hand.

**Remotion's license:** free for individuals, for-profit companies with up to 3 employees, non-profits, and for evaluating it. Any other company needs a Remotion Company License (remotion.pro).

## Ground rules

- **Repo rules win.** Follow the project's `CLAUDE.md` or `AGENTS.md` if there is one.
- **Original content only.** Use only what the owner supplied and what you make. Never use copyrighted characters, logos or music the owner didn't supply, and never recreate a specific existing video, ad or brand look they don't own. If the request needs one, say why in one line and make an original version instead.
- **Audio is optional.** Use a music or voice file only if the owner gives one. If they want narration and this session has no text-to-speech tool, put the words on screen as captions and say so. Don't send their script to an online service they didn't name.
- **Stay in the project folder.** Install nothing globally. Don't commit, stage or push: in a git repo the video folder sits under `videos/`, and the project's `.gitignore` keeps `node_modules/` and `out/` out of git.

## Step 1: settle the request

1. Run `VIDEO doctor`. If `ok` is false, tell the owner what's missing (Node 20+, npm, 3 GB free disk) and stop. If the request changes a video listed under `projects` (for example "make the title bigger"), work in that project and go to Step 4.
2. Take the length, size and fps from `$ARGUMENTS`: flags first, then plain words. "30 second" is `--length 30s`; "vertical", "for Reels", "TikTok" or "Shorts" is `--size vertical`; "square" is `square`; "4:5" is `portrait`; "4K" is `4k`. The defaults are **20 s, 1080p (1920x1080, 16:9) and 30 fps**.
3. Run `VIDEO plan --length <L> --size <S> --fps <N>`. Its `summary` is what you picked. If it errors, use the nearest value that works and say so.
4. Pick a 2 to 4 word slug and run `VIDEO paths --slug <slug>`. It returns `root`, `project`, `storyboard`, `stills` and `video`: in a git repo `<repo>/videos/<YYYY-MM-DD>-<slug>/`, otherwise `~/.claude/video/<YYYY-MM-DD>-<slug>/`.
5. If the video is about "our" or "this" product, read the repo's README and package manifest for its name, tagline and features. Ask only when the video can't be made without the answer, such as a product teaser with no product name anywhere. Otherwise pick and go.
6. Tell the owner in one or two lines what you picked: the plan's `summary`, the folder and any assumption.

## Step 2: storyboard

Write the storyboard to the `storyboard` path:

- A header: the title, the plan's `summary`, the audience and tone, the palette and the typeface.
- One table row per scene: `| # | Scene | Seconds | Frames | On-screen text | Visuals and motion | Audio |`. Frames are start to end. They must add up to the plan's `frames`. A transition overlaps the scenes on each side of it, so give it its own row and count its frames once.
- Pacing: hook the viewer in the first 2 seconds, keep each line of text up long enough to read (about 1 second plus 0.3 seconds a word), and hold the last card at least 1.5 seconds.
- Key frames: each scene's midpoint and the last frame. Step 5 checks these.

## Step 3: scaffold

1. Run `VIDEO init <project> --length <L> --size <S> --fps <N>` with the same values as the plan. It copies the bundled [template](templates/remotion/package.json) and writes the plan into `src/settings.ts`. It refuses a folder that isn't empty.
2. Run `VIDEO install <project>`. It runs `npm install` and fetches Chrome Headless Shell for rendering. The first time takes a few minutes, so give the Bash call a 10-minute timeout.
3. For a package the template lacks, run `VIDEO add <project> <package...>`, for example `@remotion/media` for audio, `@remotion/lottie lottie-web`, or `d3-scale d3-shape`. It saves exact versions and gives every `@remotion/*` package the project's `remotion` version. Never `npm install` a Remotion package yourself.
4. Copy files the owner gave you (logo, screenshots, music) into `<project>/public/`.

## Step 4: write the compositions

Read [reference/remotion.md](reference/remotion.md) first. It has the rules every frame must follow, the layout rules that keep 16:9, 9:16 and square working, and the three.js rules.

- The template has `src/settings.ts` (size, fps, length; change them only there), `src/theme.ts` (colours and font), `src/Main.tsx` (the scene order and timings) and `src/scenes/`, with one 2D scene and one 3D scene. Replace the example scenes with the storyboard's, and delete what you don't use.
- Write one component per scene. Put the storyboard's frame counts in `Main.tsx` as named constants.
- Use the tool each scene needs: React and CSS for text and 2D shapes, `@remotion/three` for 3D, `@remotion/transitions` between scenes, D3 or plain SVG for data, Lottie only for a file the owner gave you, and ffmpeg only for post-processing Remotion can't do itself.
- Run `npm run typecheck` in the project and fix every error before rendering.

## Step 5: check stills (at most 3 rounds)

1. Run `VIDEO still <project> --frame <f1>,<f2>,...` with the storyboard's key frames.
2. Open every printed PNG with the Read tool, which shows images, and look at it against the storyboard:
   - text that overflows, clips, wraps badly or sits outside the 5% safe margin;
   - contrast and readability;
   - layout, alignment and balance, and nothing hidden behind the 3D;
   - timing: the right scene and text at that frame;
   - 3D that is black, unlit or out of frame;
   - a blank frame or Remotion's error overlay.
3. Fix what you found and render the changed stills again. Stop after 3 rounds and list what's left for the report.

If a still fails, read the error. The usual causes are a frame past the end, a file missing from `public/`, or WebGL failing to start; for that last one add `-- --gl=swangle` to `still` and `render`.

## Step 6: render

Run `VIDEO render <project> --out <video>` with a 10-minute Bash timeout; run a long video in the background and wait for it. It prints `file`, `duration`, `width`, `height`, `fps`, `fileSize` and `audio`. If the duration or size isn't the plan's, find out why and render again.

## Step 7: report

```text
Video: <video path>
20 s · 1920x1080 · 30 fps · 6.4 MB · no audio
Storyboard: <storyboard path>
Project: <project path>. Run `npm run studio` there to preview and tweak it.
Picked: <the defaults you chose>. Left over: <findings you didn't fix, or none>.
Remotion is free for individuals and companies of up to 3 people; larger companies need a Remotion Company License.
```

`<project>/node_modules` is a few hundred MB. Say the owner can delete it, and that `VIDEO install <project>` brings it back.

## Changes after the report

- **A revision:** edit the same project, check the stills the change affects, and render again to the same `video` path, which overwrites it. Don't start a new folder.
- **Another size or cut:** get its numbers from `VIDEO plan --size <S>`, add a second `<Composition>` (for example `id="Vertical"`) to `src/Root.tsx` that reuses the scenes, check its stills with `--comp Vertical`, and render it with `--comp Vertical --out <root>/<slug>-vertical.mp4`, next to the first.
