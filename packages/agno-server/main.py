"""Agno AG-UI service.

Exposes a single agno Agent over the AG-UI protocol. The TypeScript
`@ai-chat/agents` agno provider POSTs `RunAgentInput` to `/agui` on this
service and streams the resulting AG-UI events back to the browser.
"""

from __future__ import annotations

import os

from agno.agent import Agent
from agno.models.openai import OpenAIChat
from agno.os import AgentOS
from agno.os.interfaces.agui import AGUI

OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4.1-mini")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL")

if not OPENAI_API_KEY:
    raise RuntimeError(
        "OPENAI_API_KEY is required to start the agno AG-UI service."
    )

model_kwargs: dict[str, object] = {"id": OPENAI_MODEL, "api_key": OPENAI_API_KEY}
if OPENAI_BASE_URL:
    model_kwargs["base_url"] = OPENAI_BASE_URL

agent = Agent(
    name="agui-agno-agent",
    model=OpenAIChat(**model_kwargs),
    instructions="You are a helpful assistant.",
    markdown=True,
)

agent_os = AgentOS(agents=[agent], interfaces=[AGUI(agent=agent)])
app = agent_os.get_app()
