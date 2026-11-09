import test from "node:test";
import { streamingRecovery } from "./fixtures/streaming-recovery.ts";

test("Pi 1.5 faux threshold compaction collects protocol replies and continues streaming", () => streamingRecovery(true));
