# jev-sscope

Watch a Claude Code session while it runs.

Claude Code hooks send each step to a Cloudflare Worker, the Worker asks
[Jev](https://developers.cloudflare.com/ai/models/typesafe/jev/) (TypeSafe's
typed-judgment model on Workers AI) a few fixed questions about the step, and a
page shows the answers as they arrive.

**Status: just started. Nothing here runs yet.**
