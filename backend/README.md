# Voice Agent Backend (FastAPI + Google ADK)

Run locally with uv + uvicorn:

```bash
# Set your Google API key first
export GOOGLE_API_KEY="your-api-key-here"  # Linux/Mac
# or
$env:GOOGLE_API_KEY="your-api-key-here"    # Windows PowerShell

# Run the server
uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Endpoints:
- GET `/` -> { message, status }
- GET `/health` -> { status: "ok" }
- WS `/ws/{user_id}?is_audio=true|false`
  - Send JSON messages:
    - Text: `{ "mime_type": "text/plain", "data": "Hello" }`
    - Audio PCM 16k mono: `{ "mime_type": "audio/pcm", "data": "<base64>" }`
  - Receive JSON messages:
    - Text: `{ "mime_type": "text/plain", "data": "..." }`
    - Audio: `{ "mime_type": "audio/pcm", "data": "<base64>" }`
    - Turn complete/interrupted: `{ "turn_complete": true/false, "interrupted": true/false }`

Environment:
- `GOOGLE_API_KEY` (required) - Your Google AI API key
- `VOICE_AGENT_MODEL` (default: `gemini-2.0-flash-exp` or `gemini-2.0-flash-live-001`)
- `VOICE_AGENT_VOICE` (default: `Puck`)
- Requires the Google ADK SDK (`google-adk>=1.17.0`) and FastAPI.

