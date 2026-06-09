import { tool } from "@opencode-ai/plugin";

const baseURL = process.env.QWENPROXY_BASE_URL || "http://localhost:3000/v1";
const apiKey = process.env.QWENPROXY_API_KEY || "";

export default tool({
  description: "Run Qwen Deep Research through QwenProxy and return a cited report.",
  args: {
    query: tool.schema.string().describe("Research question or topic."),
    model: tool.schema.string().optional().describe("Qwen model id. Defaults to qwen3.7-plus."),
  },
  async execute(args) {
    const response = await fetch(`${baseURL}/deep-research`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        query: args.query,
        ...(args.model ? { model: args.model } : {}),
      }),
    });

    const body = await response.json();
    if (!response.ok) {
      throw new Error(body?.error?.message || `QwenProxy returned ${response.status}`);
    }

    const sources = Array.isArray(body.sources)
      ? body.sources.map((source: any) => `- [${source.citation_index}] ${source.title}: ${source.url}`).join("\n")
      : "";
    return sources ? `${body.report}\n\nSources:\n${sources}` : body.report;
  },
});
