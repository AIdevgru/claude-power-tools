// Colours and type for every scene. Restyle the video here.
import { loadFont } from "@remotion/google-fonts/Inter";

const { fontFamily } = loadFont("normal", { weights: ["400", "800"], subsets: ["latin"] });

export const THEME = {
  background: "#0b0d12",
  surface: "#161a23",
  text: "#f4f6fb",
  muted: "#9aa3b5",
  accent: "#6ee7b7",
  fontFamily,
};
