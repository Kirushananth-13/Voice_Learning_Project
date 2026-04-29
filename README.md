# Voice Agent (Google ADK)

## Backend (FastAPI + Google ADK)

- Requires Python >= 3.12 and `uv`.
- From `backend/`:
  - Install: `uv sync`
  - Dev run: `uv run dev`
  - Prod run: `uv run start`

WebSocket endpoint: `ws://localhost:8000/ws/{user_id}?is_audio=true`

## Frontend (Next.js 15)

- From `frontend/`:
  - Install: `npm install`
  - Dev run: `npm run dev`

Configuration:
- The app reads the backend WS base URL from `.env.local`:
  - `NEXT_PUBLIC_BACKEND_WS_URL=ws://localhost:8000`
  - Example full connect URL used by the app: `${NEXT_PUBLIC_BACKEND_WS_URL}/ws/{user_id}?is_audio=true`
- If not set, defaults to `ws://localhost:8000` in the browser.

## Notes
- Uses dummy `user_id` for session management, e.g. `dummy-user`.
- Streams audio as base64-encoded PCM 16k mono; receives text/audio messages.
- Set `VOICE_AGENT_MODEL` and `VOICE_AGENT_VOICE` env vars to customize.
- Backend file `backend/app/main.py` currently contains two different WebSocket handlers. The frontend targets the ADK JSON format at `ws://.../ws/{user_id}?is_audio=true` that sends/receives `{ mime_type, data }`. If you instead use the alternate handler that expects plain text and emits `{ type: 'agent_response', response }`, the UI also handles that shape.

