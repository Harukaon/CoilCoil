# OpenAI Response (WS)

`@suocode/openai-responses-ws` is SuoCode's own Pi extension for services that expose the OpenAI Codex Responses protocol over a persistent WebSocket.

The extension is loaded through Pi's normal `pi.extensions` package manifest. It registers the independent provider `openai-responses-ws`; it does not replace Pi's built-in `openai-codex-responses` provider or any user provider.

Its transport adapts the bundled Pi Codex Responses implementation so ordinary proxy API keys do not require a ChatGPT account ID and WebSocket failures are surfaced instead of silently falling back to HTTP/SSE. Model capabilities are discovered from `/v1/models?client_version=pi` and cached inside SuoCode's private Agent directory.

Configuration is stored in `openai-responses-ws.json`. The old `cliproxyapi.json` filename is read only for migration compatibility and is not used as a provider identity.
