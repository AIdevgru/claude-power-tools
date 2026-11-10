# Use case: a product teaser from one line

Priya maintains an open-source command-line tool. She wants a short teaser for the release post
and has no video editor installed.

1. In the tool's repo she types
   `/video a 20 second product teaser for our CLI, dark theme, 3D logo spin, then three feature cards`.
2. The skill runs `scripts/video.mjs doctor`: Node 22, npm 10 and 40 GB free are fine, and no
   Remotion project exists yet. A machine without Node 20+, npm or 3 GB free gets told what's
   missing, and nothing else happens.
3. She gave a length but no size, so `video.mjs plan --length 20s` picks the defaults and prints
   `20 s at 30 fps = 600 frames, 1920x1080 (16:9)`. `20s`, `1m`, `1m30s`, `1:30` and `450f` all
   read; `vertical`, `square`, `portrait`, `720p`, `4k` and `1280x720` are sizes. An odd size
   such as `1081x720` is refused, because H.264 needs even sides.
4. `video.mjs paths --slug cli-teaser` sees a git repo and answers
   `<repo>/videos/2026-11-10-cli-teaser/`, with the storyboard, the Remotion project and the MP4
   inside. Outside a repo it would be `~/.claude/video/2026-11-10-cli-teaser/`. A second video
   with the same name that day gets `-2`.
5. The skill reads the README for the tool's name and three features, so it asks her nothing. It
   says in one line what it picked.
6. It writes `storyboard.md`: a 2-second hook, the 3D logo spin, three feature cards and a closing
   card, each with seconds, frames, on-screen text, motion and audio ("none"). The frames add up
   to 600, counting each transition's overlap once.
7. `video.mjs init` copies the bundled template, a minimal Remotion project with exact pinned
   versions and every `@remotion/*` package on the same version, and writes the plan into
   `src/settings.ts`. It won't copy into a folder that isn't empty. `video.mjs install` runs
   `npm install` and fetches the headless browser. On Windows npm runs through node's own
   `npm-cli.js` where it can, so a broken PATH entry doesn't stop it.
8. Claude replaces the template's 2D and 3D example scenes with the storyboard's scenes: a
   `@remotion/three` logo that turns with the frame number, cards that spring in, and fades from
   `@remotion/transitions` between them. Sizes come from the video's width and height, so a
   vertical cut later still fits.
9. `video.mjs still --frame 45,150,300,450,599` renders each scene's midpoint and the last frame.
   Claude opens each PNG with the Read tool and sees the third card's text run past the safe
   margin. It shortens the line and renders that still again. It stops after 3 rounds at most.
10. `video.mjs render --out <folder>/cli-teaser.mp4` renders the MP4 and prints its duration
    (20 s), size (1920x1080), fps, file size and whether it has audio.
11. The report gives the path, `20 s · 1920x1080 · 30 fps · 6.4 MB · no audio`, the storyboard
    and project paths, and a one-line note on Remotion's license: free for individuals and
    companies of up to 3 people, a company license for larger ones.

She asks for the logo to spin faster. Claude edits the same project, checks the stills the change
affects and renders over the same MP4; it doesn't start a new folder. Then she wants a vertical cut
too. Claude adds a `Vertical` composition (1080x1920, from `video.mjs plan --size vertical`) to
the same project, checks its stills and renders it with `--comp Vertical` to
`cli-teaser-vertical.mp4`, next to the first.

The skill never uses characters, logos or music she didn't supply. If she'd asked for narration
with no text-to-speech tool in the session, the words would go on screen as captions, and the
report would say so.
