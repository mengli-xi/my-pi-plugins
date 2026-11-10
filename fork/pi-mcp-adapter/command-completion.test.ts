import { describe, expect, it } from "vitest";
import { mcpAuthArgumentCompletions, mcpArgumentCompletions } from "./index.ts";
import { completePromptArgs } from "./prompts.ts";

describe("mcp-auth command completions", () => {
  const config = {
    mcpServers: {
      github: { url: "https://github.example/mcp" },
      gitlab: { url: "https://gitlab.example/mcp", auth: "oauth" },
      disabled: { url: "https://disabled.example/mcp", disabled: true },
      header_auth: { url: "https://headers.example/mcp", headers: { authorization: "secret" } },
      node_repl: { command: "node" },
    },
  } as never;

  it("completes configured server names", () => {
    expect(mcpAuthArgumentCompletions("", config)?.map(({ value }) => value))
      .toEqual(["github", "gitlab"]);
    expect(mcpAuthArgumentCompletions(" git", config)?.map(({ value }) => value))
      .toEqual(["github", "gitlab"]);
    expect(mcpAuthArgumentCompletions("github extra", config)).toBeNull();
    expect(mcpAuthArgumentCompletions("missing", config)).toBeNull();
  });
});

describe("dynamic MCP prompt completions", () => {
  const metadata = {
    serverName: "demo",
    originalName: "brief",
    commandName: "mcp__demo__brief",
    description: "Build a brief",
    arguments: [
      { name: "day", description: "Day to summarize", required: true },
      { name: "topic", description: "Optional topic" },
    ],
  };

  it("offers declared argument-name scaffolds and omits used names", () => {
    expect(completePromptArgs(metadata, "")?.map(({ value }) => value))
      .toEqual(["day=", "topic="]);
    expect(completePromptArgs(metadata, "unknown")).toBeNull();
    expect(completePromptArgs(metadata, "to")?.map(({ value }) => value))
      .toEqual(["topic="]);
    expect(completePromptArgs(metadata, "day=today ")?.map(({ value }) => value))
      .toEqual(["day=today topic="]);
    expect(completePromptArgs(metadata, "today ")?.map(({ value }) => value))
      .toEqual(["today topic="]);
  });
});

describe("MCP public command grammar", () => {
  const config = { mcpServers: { tolaria: { command: "node" }, bearer: { url: "https://example.test", auth: "bearer", bearerTokenStore: true } } } as never;
  const values = (prefix: string) => mcpArgumentCompletions(prefix, config)?.map(item => item.value) ?? null;
  it("completes root commands and rejects unknown input", () => {
    expect(values("")).toContain("edit");
    expect(values("re")).toEqual(["reconnect"]);
    expect(values("unknown")).toBeNull();
  });
  it("completes parser enums and real servers", () => {
    expect(values("edit ")).toEqual(["edit project", "edit global"]);
    expect(values("edit gl")).toEqual(["edit global"]);
    expect(values("edit unknown")).toBeNull();
    expect(values("token ")).toEqual(["token set ", "token remove ", "token status "]);
    expect(values("token st")).toEqual(["token status "]);
    expect(values("token bogus ")).toBeNull();
    expect(values("token status ")).toEqual(["token status bearer"]);
    expect(values("semantic ")).toEqual(["semantic setup"]);
    expect(values("semantic se")).toEqual(["semantic setup"]);
    expect(values("semantic unknown")).toBeNull();
    expect(values("jev ")).toBeNull();
    expect(values("reconnect to")).toEqual(["reconnect tolaria"]);
    expect(values("reconnect missing")).toBeNull();
  });
});
