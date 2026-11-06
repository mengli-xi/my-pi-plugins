import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installPeer } from "./common.js";
export default function (pi: ExtensionAPI): void { installPeer(pi, "b"); }
