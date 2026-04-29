# Simple HTML/JS Voice Agent App

This is a pure HTML/JavaScript implementation that exactly matches the Google ADK documentation.

## Quick Start

1. **Start the backend server:**
```bash
cd H:\ai\gadk-react-app\backend
uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

2. **Open your browser:**
Navigate to: http://localhost:8000

3. **Test text chat:**
- Type a message in the input box
- Click "Send"
- You should see the agent's response

4. **Test voice chat:**
- Click "Start Audio" button
- Allow microphone access
- Start speaking
- The agent will respond with voice

## Files Structure

```
backend/
├── app/
│   └── main.py          # FastAPI server with ADK integration
├── static/
│   ├── index.html       # Main HTML page
│   └── js/
│       ├── app.js       # WebSocket handling and main logic
│       ├── audio-player.js   # Audio playback worklet
│       └── audio-recorder.js # Audio recording worklet
├── .env                 # Environment variables (GOOGLE_API_KEY)
└── pyproject.toml       # Python dependencies
```

## Features

✅ **Text Chat** - Send and receive text messages
✅ **Voice Chat** - Real-time audio streaming with the agent
✅ **Turn Detection** - Automatic turn-taking with server-side VAD
✅ **Console Logging** - See `[CLIENT TO AGENT]` and `[AGENT TO CLIENT]` messages in browser console
✅ **Auto-reconnect** - Automatically reconnects if connection drops

## Browser Console

Open the browser developer console (F12) to see detailed logs:
- `WebSocket connection opened.`
- `[CLIENT TO AGENT] your message`
- `[AGENT TO CLIENT] { mime_type: "text/plain", data: "..." }`
- `[CLIENT TO AGENT] sent 8192 bytes` (for audio)

## Troubleshooting

**No audio playback:**
- Make sure you clicked "Start Audio" button
- Check browser console for errors
- Verify microphone permissions are granted

**Connection issues:**
- Ensure backend server is running on port 8000
- Check `.env` file has valid `GOOGLE_API_KEY`
- Verify `GOOGLE_GENAI_USE_VERTEXAI=FALSE` in `.env`

**Text chat works but audio doesn't:**
- Try using a different browser (Chrome/Edge recommended)
- Check if AudioWorklet is supported in your browser
- Look for audio-related errors in console
