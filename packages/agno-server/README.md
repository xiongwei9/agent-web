# agno-server

Python service that wraps an [agno](https://github.com/agno-agi/agno) Agent in
the AG-UI protocol via `agno.os.interfaces.agui.AGUI`. The TypeScript
`agui-server` proxies AG-UI runs to this service through the `agno` provider in
`@ai-chat/agents`.

## Setup

Requires Python ≥ 3.10 and [`uv`](https://docs.astral.sh/uv/).

```sh
cd packages/agno-server
uv sync
```

## Run

```sh
OPENAI_API_KEY=sk-... \
OPENAI_MODEL=gpt-4.1-mini \
uv run uvicorn main:app --host 127.0.0.1 --port 8001
```

Optional:

- `OPENAI_BASE_URL` for an OpenAI-compatible endpoint.

## Wire into agui-server

Set on the Node service:

```sh
AGENT_PROVIDER=agno \
AGNO_BASE_URL=http://127.0.0.1:8001 \
pnpm --filter @ai-chat/agui-server dev
```

`AGNO_PATH` defaults to `/agui` (agno's AGUI interface mounts there).
