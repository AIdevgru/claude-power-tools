// The entry point the Remotion CLI bundles: `remotion render src/index.ts Main out/Main.mp4`.
import { registerRoot } from "remotion";
import { RemotionRoot } from "./Root";

registerRoot(RemotionRoot);
