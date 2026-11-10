// Read by the Remotion CLI (studio, still, render). See https://www.remotion.dev/docs/config
import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
// three.js needs a real WebGL context. On a machine with no GPU (CI, some servers),
// pass --gl=swangle to still and render instead.
Config.setChromiumOpenGlRenderer("angle");
