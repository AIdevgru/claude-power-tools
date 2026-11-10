# Writing Remotion compositions

Rules for the composition code the `/video` skill writes. Remotion renders each frame on its own
in a headless browser, so a frame must look the same whenever and in whatever order it's rendered.

## Time comes from the frame

- Drive every value from `useCurrentFrame()` and `useVideoConfig()` (`fps`, `width`, `height`,
  `durationInFrames`). Seconds to frames: `seconds * fps`.
- Animate with `interpolate(frame, [from, to], [a, b], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })`,
  `spring({ frame, fps, config: { damping: 200 } })` (no bounce; lower `damping` bounces) and
  `Easing` (`easing: Easing.out(Easing.cubic)` inside `interpolate`'s options).
- Never use CSS transitions or `@keyframes`, `setTimeout`, `requestAnimationFrame`, `Date.now()` or
  `Math.random()`. For randomness, use `random("seed-" + i)` from `remotion`: the same seed gives
  the same number every frame.

## Timeline

- `<Sequence from={f} durationInFrames={n}>` places a part. Inside it, `useCurrentFrame()` starts at
  0, so each scene is written as if it starts at frame 0.
- `<Series>` plays parts back to back. `<TransitionSeries>` from `@remotion/transitions` adds
  transitions between them (`fade()`, `slide()`, `wipe()`, `flip()`, `clockWipe()`, from
  `@remotion/transitions/<name>`). A transition overlaps the parts on each side of it, so the
  total is the sum of the parts minus the sum of the transitions. Make the storyboard add up.
- Keep scene components in `src/scenes/` and the order and timings in `src/Main.tsx`. Put
  colours and fonts in `src/theme.ts` and size, fps and length in `src/settings.ts`.

## Layout that survives every size

- Size type and spacing from the frame, not fixed pixels: `const unit = Math.min(width, height) / 100`
  and `fontSize: unit * 6`. Then 16:9, 9:16 and square all work.
- Keep text and logos inside a 5% safe margin. Body text no smaller than `unit * 3.5` (about
  38 px at 1080p); headlines usually `unit * 7` to `unit * 10`.
- Keep a line under about 40 characters for a headline and 60 for body text. Wrap long copy
  yourself or shorten it; never let it overflow or shrink unreadably.
- Contrast: text at least 4.5:1 against what's behind it, in every frame of the motion.
- Give each line of on-screen text time to be read: about 1 second plus 0.3 seconds per word.

## Fonts, images, audio and video

- Google Fonts: `import { loadFont } from "@remotion/google-fonts/<Font>"`, then
  `const { fontFamily } = loadFont("normal", { weights: ["400", "700"], subsets: ["latin"] })`.
  A font file the user gives: put it in `public/` and load it with `@remotion/fonts`.
- Files go in the project's `public/` folder and are referenced with `staticFile("name.png")`.
  Show images with `<Img>` from `remotion` (it waits for the image to load before the frame is taken).
- Audio: `video.mjs add <dir> @remotion/media`, then
  `<Audio src={staticFile("music.mp3")} volume={0.6} />` from `@remotion/media`. `trimBefore` skips
  frames at the start; compute a fade as a number with `interpolate`. Video clips use `<Video>`
  from the same package.
- Lottie: `video.mjs add <dir> @remotion/lottie lottie-web`; render a Lottie JSON the user gave you
  with `<Lottie animationData={data} />`.
- Data: compute scales and paths with `d3-scale` and `d3-shape` (add them), draw plain SVG, and
  animate it with `interpolate`. `@remotion/shapes` and `@remotion/paths` help with shapes and
  drawing a path on (`evolvePath`).

## 3D with @remotion/three

- Wrap the scene in `<ThreeCanvas width={width} height={height} camera={{ position: [0, 0, 7], fov: 40 }}>`.
  Remotion's hooks work inside it.
- Animate from `useCurrentFrame()`, never from react-three-fiber's `useFrame()`.
- A `<Sequence>` inside the canvas needs `layout="none"`, because a `<div>` isn't allowed there.
- `meshStandardMaterial` and `meshPhysicalMaterial` need lights: an `ambientLight` plus a
  `directionalLight` or `pointLight`.
- Build shapes from three.js geometries (`boxGeometry`, `torusKnotGeometry`, `extrudeGeometry`
  from an SVG path, `TextGeometry` with a font JSON). Load a 3D model only if the user gave it.
- `remotion.config.ts` sets the `angle` OpenGL renderer, which three.js needs. If a still comes out
  black or WebGL fails to start (a machine with no GPU), pass `-- --gl=swangle` to `still` and `render`.

## Rendering

- `video.mjs still` and `render` run the project's own Remotion CLI with `src/index.ts` and the
  composition ID (`Main` unless you add others in `src/Root.tsx`).
- H.264 MP4 is the default. Remotion also renders `--codec=gif`, `--codec=vp9` (WebM) and
  `--codec=prores` itself (pass after `--`), and ships ffmpeg and ffprobe, so a separate ffmpeg is
  rarely needed.
- `npm run typecheck` in the project finds type errors before a slow render does.
