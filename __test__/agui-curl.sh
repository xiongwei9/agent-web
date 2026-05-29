curl -N -X POST http://localhost:3000/agui \
  -H 'content-type: application/json' \
  -H 'accept: text/event-stream' \
  -H 'x-agent-id: OnboardingAgent' \
  -H 'x-resource-id: user-123' \
  -d '{
    "threadId": "thread-001",
    "runId": "run-001",
    "state": {},
    "messages": [
      { "id": "m1", "role": "user", "content": "查询 Figma 设计里的这个图层内容，然后用语言描述下这是什么？ @https://www.figma.com/design/PXzB2B9urw4z6r2jeZhkSF/Cobo-Portal---Mobile-App?node-id=829-7204&m=dev" }
    ],
    "tools": [],
    "context": []
  }'