// Every composition the project can render. `Main` is the video; add more for variants
// (a vertical cut, a thumbnail still) that reuse the same scenes.
import { Composition } from "remotion";
import { Main } from "./Main";
import { VIDEO } from "./settings";

export const RemotionRoot: React.FC = () => (
  <Composition
    id="Main"
    component={Main}
    durationInFrames={VIDEO.durationInFrames}
    fps={VIDEO.fps}
    width={VIDEO.width}
    height={VIDEO.height}
  />
);
