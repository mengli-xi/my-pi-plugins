import "./test-offline.mjs";
import { vi } from "vitest";

vi.mock("open", () => ({ default: async () => { throw new Error("Opening a browser is forbidden in the MCP offline fixture"); } }));
