// The example video: a 2D title scene, a fade, then a 3D scene. Replace the scenes with the
// storyboard's. With transitions, the scenes overlap: total = sum of scenes - sum of transitions.
import { linearTiming, TransitionSeries } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { AbsoluteFill, useVideoConfig } from "remotion";
import { SpinScene } from "./scenes/SpinScene";
import { TitleScene } from "./scenes/TitleScene";
import { THEME } from "./theme";

const TRANSITION = 15;

export const Main: React.FC = () => {
  const { durationInFrames } = useVideoConfig();
  const first = Math.floor((durationInFrames + TRANSITION) / 2);
  const second = durationInFrames + TRANSITION - first;
  return (
    <AbsoluteFill style={{ backgroundColor: THEME.background }}>
      <TransitionSeries>
        <TransitionSeries.Sequence durationInFrames={first}>
          <TitleScene title="Your video starts here" subtitle="Made with Remotion and Claude" />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: TRANSITION })} />
        <TransitionSeries.Sequence durationInFrames={second}>
          <SpinScene caption="And this part is three.js" />
        </TransitionSeries.Sequence>
      </TransitionSeries>
    </AbsoluteFill>
  );
};
