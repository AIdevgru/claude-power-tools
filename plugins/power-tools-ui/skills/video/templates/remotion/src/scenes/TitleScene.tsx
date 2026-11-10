// A 2D scene: the title springs in, the subtitle fades up after it. Every value comes from the
// frame number, so any frame renders the same way every time.
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { THEME } from "../theme";

export const TitleScene: React.FC<{ title: string; subtitle: string }> = ({ title, subtitle }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const unit = Math.min(width, height) / 100;

  const enter = spring({ frame, fps, config: { damping: 200 } });
  const subtitleIn = interpolate(frame, [0.6 * fps, 1.2 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: THEME.background,
        justifyContent: "center",
        alignItems: "center",
        padding: unit * 8,
        fontFamily: THEME.fontFamily,
        textAlign: "center",
      }}
    >
      <div
        style={{
          color: THEME.text,
          fontSize: unit * 9,
          fontWeight: 800,
          lineHeight: 1.05,
          letterSpacing: "-0.02em",
          transform: `translateY(${(1 - enter) * unit * 6}px)`,
          opacity: enter,
        }}
      >
        {title}
      </div>
      <div
        style={{
          marginTop: unit * 3,
          color: THEME.accent,
          fontSize: unit * 4,
          fontWeight: 400,
          opacity: subtitleIn,
          transform: `translateY(${(1 - subtitleIn) * unit * 2}px)`,
        }}
      >
        {subtitle}
      </div>
    </AbsoluteFill>
  );
};
