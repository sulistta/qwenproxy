import { tool } from "@opencode-ai/plugin";

const baseURL = process.env.QWENPROXY_BASE_URL || "http://localhost:3000/v1";
const apiKey = process.env.QWENPROXY_API_KEY || "";

export default tool({
  description: "Generate an image with Qwen through QwenProxy.",
  args: {
    prompt: tool.schema.string().describe("Image generation prompt."),
    size: tool.schema.string().optional().describe('Aspect ratio, for example "1:1", "16:9", or "9:16".'),
    model: tool.schema.string().optional().describe("Qwen model id. Defaults to qwen3.7-plus."),
  },
  async execute(args) {
    const response = await fetch(`${baseURL}/images/generations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        prompt: args.prompt,
        ...(args.size ? { size: args.size } : {}),
        ...(args.model ? { model: args.model } : {}),
      }),
    });

    const body = await response.json();
    if (!response.ok) {
      throw new Error(body?.error?.message || `QwenProxy returned ${response.status}`);
    }

    const urls = Array.isArray(body.data)
      ? body.data.map((item: any) => item.url).filter(Boolean)
      : [];
    if (urls.length === 0) return "No image URL was returned.";
    return urls.map((url: string, index: number) => `Image ${index + 1}: ${url}`).join("\n");
  },
});
