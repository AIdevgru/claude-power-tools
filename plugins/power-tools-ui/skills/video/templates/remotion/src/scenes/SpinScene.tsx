// A 3D scene with @remotion/three: a lit torus knot that pops in and turns, with a caption over
// it. Motion comes from useCurrentFrame(), never from react-three-fiber's useFrame().
import { ThreeCanvas } from "@remotion/three";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { THEME } from "../theme";

export const SpinScene: React.FC<{ caption: string }> = ({ caption }) => {
  const frame = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();
  const unit = Math.min(width, height) / 100;

  const pop = spring({ frame, fps, config: { damping: 14, mass: 0.8 } });
  const turn = interpolate(frame, [0, durationInFrames], [0, Math.PI * 2]);
  const captionIn = interpolate(frame, [0.5 * fps, 1 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ backgroundColor: THEME.background }}>
      <ThreeCanvas width={width} height={height} camera={{ position: [0, 0, 7], fov: 40 }}>
        <ambientLight intensity={0.5} />
        <directionalLight position={[4, 6, 5]} intensity={2.2} />
        <pointLight position={[-5, -3, 4]} intensity={30} color={THEME.accent} />
        <mesh rotation={[turn * 0.5, turn, 0]} scale={pop}>
          <torusKnotGeometry args={[1, 0.32, 256, 32]} />
          <meshStandardMaterial color={THEME.text} metalness={0.35} roughness={0.25} />
        </mesh>
      </ThreeCanvas>
      <AbsoluteFill
        style={{
          justifyContent: "flex-end",
          alignItems: "center",
          paddingBottom: unit * 9,
          fontFamily: THEME.fontFamily,
        }}
      >
        <div style={{ color: THEME.muted, fontSize: unit * 4.5, fontWeight: 400, opacity: captionIn }}>{caption}</div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
