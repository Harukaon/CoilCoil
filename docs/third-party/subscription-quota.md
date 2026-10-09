# Subscription quota source and license

CoilCoil reads Anthropic and OpenAI Codex subscription usage from their own services.
The endpoint/header conventions and duration-based quota-window classification were
adapted from the CPA management panel:

- CLIProxyAPI: https://github.com/router-for-me/CLIProxyAPI
- Management panel: https://github.com/router-for-me/Cli-Proxy-API-Management-Center
- Reference revision: `c9e2f7cb0b065c13211285d9525bcc8761f17837`
- Reference files: `src/utils/quota/constants.ts`,
  `src/features/quota/providers/claude/data.ts`,
  `src/features/quota/providers/codex/data.ts`

Only read-only usage queries are integrated. Reset-credit consumption, purchases,
extra-usage configuration and CPA's credential/file management are not included.
Queries use CoilCoil's existing subscription auth resolver; credentials stay in the
runtime, never in renderer state. These upstream endpoints may change independently
of CoilCoil. Missing windows are shown as unavailable, not zero.

## MIT notice

MIT License

Copyright (c) 2026 Router-For.ME

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
