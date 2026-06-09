# OpenCode Custom Tools

Copy the files in `tools/` to your project's `.opencode/tools/` directory.
Copy `opencode.json` to the project root if you want OpenCode to use
QwenProxy as the model provider for that project.

Environment variables:

```bash
export QWENPROXY_BASE_URL=http://localhost:3000/v1
export QWENPROXY_API_KEY=your-key-if-configured
```

Tools:

- `qwen-deep-research`: calls `POST /v1/deep-research`.
- `qwen-generate-image`: calls `POST /v1/images/generations`.

OpenCode loads custom tools from `.opencode/tools/`; each filename becomes the
tool name.

From the target project:

```bash
QWENPROXY_BASE_URL=http://localhost:3000/v1 QWENPROXY_API_KEY=opencode opencode
```
