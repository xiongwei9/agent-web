curl -N -X POST http://localhost:3000/agui \
  -H 'content-type: application/json' \
  -H 'accept: text/event-stream' \
  -d '{
    "threadId": "thread-001",
    "runId": "run-001",
    "state": {},
    "messages": [
      { "id": "m1", "role": "user", "content": "北京和上海今天天气怎么样？" }
    ],
    "tools": [],
    "context": []
  }'


curl -N -X POST http://localhost:3000/agui \
  -H 'content-type: application/json' \
  -H 'accept: text/event-stream' \
  -d '{
    "threadId": "thread-001",
    "runId": "run-001",
    "state": {},
    "messages": [
      { "id": "m1", "role": "user", "content": "帮我写一段发布说明：上线 ai-chat 项目里的新功能" }
    ],
    "tools": [],
    "context": []
  }'