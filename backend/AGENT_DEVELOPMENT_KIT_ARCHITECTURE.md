# Google Agent Development Kit (ADK) Architecture Documentation

This document explains how the Google Agent Development Kit (ADK) is implemented in this backend, covering WebSocket communication, agent invocation, session memory management, and the overall architecture.

## Table of Contents

1. [Overview](#overview)
2. [WebSocket Communication Flow](#websocket-communication-flow)
3. [Agent Initialization and Invocation](#agent-initialization-and-invocation)
4. [Session Memory Management](#session-memory-management)
5. [Message Flow Architecture](#message-flow-architecture)
6. [Key Components](#key-components)
7. [Data Flow Diagrams](#data-flow-diagrams)

---

## Overview

This backend implements a real-time voice and text agent using Google's Agent Development Kit (ADK). The system uses:

- **FastAPI** for the web server and WebSocket handling
- **Google ADK** (`google-adk>=1.16.0`) for agent orchestration
- **InMemoryRunner** for running agents with in-memory session storage
- **WebSocket** for bidirectional real-time communication
- **Gemini 2.0 Flash** model for the LLM backend

The agent is configured to use Google Search as a tool for grounding responses with real-time information.

---

## WebSocket Communication Flow

### WebSocket Endpoint

**Endpoint:** `/ws/{user_id}?is_audio=true|false`

- **Path Parameter:** `user_id` (integer) - Unique identifier for the user session
- **Query Parameter:** `is_audio` (string) - `"true"` for audio mode, `"false"` for text mode

### Connection Lifecycle

```python
@app.websocket("/ws/{user_id}")
async def websocket_endpoint(websocket: WebSocket, user_id: int, is_audio: str):
    # 1. Accept WebSocket connection
    await websocket.accept()
    
    # 2. Start agent session
    live_events, live_request_queue = await start_agent_session(user_id_str, is_audio == "true")
    
    # 3. Start bidirectional communication tasks
    agent_to_client_task = asyncio.create_task(agent_to_client_messaging(...))
    client_to_agent_task = asyncio.create_task(client_to_agent_messaging(...))
    
    # 4. Wait for disconnection or error
    await asyncio.wait(tasks, return_when=asyncio.FIRST_EXCEPTION)
    
    # 5. Cleanup
    live_request_queue.close()
```

### Message Format

#### Client → Agent Messages

**Text Message:**
```json
{
  "mime_type": "text/plain",
  "data": "Hello, how are you?"
}
```

**Audio Message:**
```json
{
  "mime_type": "audio/pcm",
  "data": "<base64-encoded-pcm-audio-data>"
}
```

#### Agent → Client Messages

**Text Response:**
```json
{
  "mime_type": "text/plain",
  "data": "I'm doing well, thank you!"
}
```

**Audio Response:**
```json
{
  "mime_type": "audio/pcm",
  "data": "<base64-encoded-pcm-audio-data>"
}
```

**Turn Status:**
```json
{
  "turn_complete": true,
  "interrupted": false
}
```

---

## Agent Initialization and Invocation

### Agent Definition

The agent is defined in `google_search_agent/agent.py`:

```python
from google.adk.agents import Agent
from google.adk.tools import google_search

root_agent = Agent(
    name="google_search_agent",
    model="gemini-2.0-flash-exp",
    description="Agent to answer questions using Google Search.",
    instruction="Answer the question using the Google Search tool.",
    tools=[google_search],
)
```

**Key Properties:**
- **name**: Unique identifier for the agent
- **model**: LLM model to use (`gemini-2.0-flash-exp` or `gemini-2.0-flash-live-001`)
- **description**: High-level description of agent's purpose
- **instruction**: System prompt/instructions for the agent
- **tools**: List of tools the agent can use (Google Search in this case)

### Agent Session Startup

When a WebSocket connection is established, `start_agent_session()` is called:

```python
async def start_agent_session(user_id, is_audio=False):
    # 1. Create InMemoryRunner
    runner = InMemoryRunner(
        app_name=APP_NAME,
        agent=root_agent,
    )
    
    # 2. Create a Session for this user
    session = await runner.session_service.create_session(
        app_name=APP_NAME,
        user_id=user_id,
    )
    
    # 3. Configure response modality (AUDIO or TEXT)
    modality = "AUDIO" if is_audio else "TEXT"
    run_config = RunConfig(
        response_modalities=[modality],
        session_resumption=types.SessionResumptionConfig()
    )
    
    # 4. Create LiveRequestQueue for real-time communication
    live_request_queue = LiveRequestQueue()
    
    # 5. Start live agent session
    live_events = runner.run_live(
        session=session,
        live_request_queue=live_request_queue,
        run_config=run_config,
    )
    
    return live_events, live_request_queue
```

**Key Components:**

1. **InMemoryRunner**: Manages agent execution and session state in memory
2. **Session**: Represents a conversation session tied to a `user_id`
3. **RunConfig**: Configuration for the agent run, including:
   - `response_modalities`: Whether to return AUDIO or TEXT
   - `session_resumption`: Enables session memory persistence
4. **LiveRequestQueue**: Queue for sending real-time requests to the agent
5. **live_events**: Async iterator that yields agent responses and events

---

## Session Memory Management

### How Session Memory Works

Session memory is managed by the **InMemoryRunner** and **Session** objects:

1. **Session Creation:**
   ```python
   session = await runner.session_service.create_session(
       app_name=APP_NAME,
       user_id=user_id,
   )
   ```
   - Each `user_id` gets its own session
   - The session is stored in memory by the `InMemoryRunner`
   - Session state persists for the duration of the WebSocket connection

2. **Session Resumption:**
   ```python
   run_config = RunConfig(
       response_modalities=[modality],
       session_resumption=types.SessionResumptionConfig()
   )
   ```
   - `SessionResumptionConfig()` enables conversation history to be maintained
   - When a new WebSocket connection is made with the same `user_id`, the session can be resumed
   - Previous conversation context is preserved

3. **Memory Storage:**
   - **Storage Type**: In-memory (not persistent to disk)
   - **Scope**: Per `user_id` and `app_name` combination
   - **Lifetime**: Persists while the session is active
   - **Content**: Conversation history, context, and agent state

### Memory Limitations

⚠️ **Important Notes:**
- Memory is **in-memory only** - it does not persist across server restarts
- Each WebSocket connection creates a new session, but with `SessionResumptionConfig()`, the same `user_id` can resume previous sessions
- If you need persistent storage, you would need to implement a custom runner or session service that writes to a database

### Conversation Context Flow

```
User Message → LiveRequestQueue → Agent (with session context) → Response
                                              ↓
                                    Session Memory Updated
```

Each message sent to the agent includes the full conversation history from the session, allowing the agent to maintain context across multiple turns.

---

## Message Flow Architecture

### Bidirectional Communication

The system uses two concurrent async tasks for bidirectional communication:

#### 1. Client → Agent Flow

```python
async def client_to_agent_messaging(websocket, live_request_queue):
    while True:
        # Receive message from WebSocket
        message_json = await websocket.receive_text()
        message = json.loads(message_json)
        
        if message["mime_type"] == "text/plain":
            # Create Content object for text
            content = Content(role="user", parts=[Part.from_text(text=message["data"])])
            live_request_queue.send_content(content=content)
            
        elif message["mime_type"] == "audio/pcm":
            # Decode base64 audio and send as realtime blob
            decoded_data = base64.b64decode(message["data"])
            live_request_queue.send_realtime(Blob(data=decoded_data, mime_type="audio/pcm"))
```

**Flow:**
1. WebSocket receives JSON message from client
2. Parse message to extract `mime_type` and `data`
3. For text: Create `Content` object and send via `send_content()`
4. For audio: Decode base64 and send as `Blob` via `send_realtime()`
5. Agent processes the message with session context

#### 2. Agent → Client Flow

```python
async def agent_to_client_messaging(websocket, live_events):
    async for event in live_events:
        # Handle turn completion/interruption
        if event.turn_complete or event.interrupted:
            await websocket.send_text(json.dumps({
                "turn_complete": event.turn_complete,
                "interrupted": event.interrupted,
            }))
            continue
        
        # Extract content part
        part = event.content and event.content.parts and event.content.parts[0]
        if not part:
            continue
        
        # Handle audio response
        if part.inline_data and part.inline_data.mime_type.startswith("audio/pcm"):
            audio_data = part.inline_data.data
            await websocket.send_text(json.dumps({
                "mime_type": "audio/pcm",
                "data": base64.b64encode(audio_data).decode("ascii")
            }))
            continue
        
        # Handle text response (partial streaming)
        if part.text and event.partial:
            await websocket.send_text(json.dumps({
                "mime_type": "text/plain",
                "data": part.text
            }))
```

**Flow:**
1. Iterate over `live_events` async iterator
2. Check for turn completion/interruption events
3. Extract content parts from events
4. Encode audio as base64 or send text directly
5. Stream partial text responses as they arrive
6. Send JSON messages back to client via WebSocket

### Event Types

The `live_events` iterator yields different types of events:

- **Content Events**: Contain text or audio responses from the agent
- **Turn Complete Events**: Indicate the agent has finished its turn
- **Interrupted Events**: Indicate the agent's turn was interrupted (e.g., user started speaking)

---

## Key Components

### 1. InMemoryRunner

**Purpose**: Manages agent execution and session state

**Key Methods:**
- `session_service.create_session()`: Creates a new session
- `run_live()`: Starts a live agent session with streaming responses

**Storage**: In-memory session storage (not persistent)

### 2. Session

**Purpose**: Represents a conversation session

**Properties:**
- `app_name`: Application identifier
- `user_id`: User identifier (used for session resumption)

**Lifetime**: Persists while active, can be resumed with same `user_id`

### 3. LiveRequestQueue

**Purpose**: Queue for sending real-time requests to the agent

**Methods:**
- `send_content(content)`: Send a text message
- `send_realtime(blob)`: Send real-time audio data
- `close()`: Close the queue and cleanup

### 4. RunConfig

**Purpose**: Configuration for agent execution

**Properties:**
- `response_modalities`: List of modalities (["AUDIO"] or ["TEXT"])
- `session_resumption`: Configuration for session memory persistence

### 5. Agent

**Purpose**: Defines the agent's behavior, model, and tools

**Properties:**
- `name`: Agent identifier
- `model`: LLM model to use
- `description`: Agent description
- `instruction`: System instructions
- `tools`: Available tools (e.g., `google_search`)

---

## Data Flow Diagrams

### Complete Message Flow

```
┌─────────┐                    ┌──────────────┐                    ┌──────────┐
│ Client  │                    │   FastAPI    │                    │   ADK    │
│         │                    │   Backend    │                    │  Agent   │
└────┬────┘                    └──────┬───────┘                    └────┬─────┘
     │                                 │                                 │
     │  1. WebSocket Connect          │                                 │
     │────────────────────────────────>│                                 │
     │                                 │                                 │
     │                                 │  2. Create Session              │
     │                                 │────────────────────────────────>│
     │                                 │                                 │
     │                                 │  3. Start Live Session          │
     │                                 │────────────────────────────────>│
     │                                 │                                 │
     │  4. Send Text/Audio            │                                 │
     │────────────────────────────────>│                                 │
     │                                 │  5. Queue Message               │
     │                                 │────────────────────────────────>│
     │                                 │                                 │
     │                                 │  6. Process with Context        │
     │                                 │     (Session Memory)            │
     │                                 │                                 │
     │                                 │  7. Stream Response             │
     │                                 │<────────────────────────────────│
     │  8. Receive Response            │                                 │
     │<────────────────────────────────│                                 │
     │                                 │                                 │
```

### Session Memory Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                      Session Memory (In-Memory)                  │
│                                                                  │
│  User ID: "123"                                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Conversation History:                                     │  │
│  │  - Turn 1: User: "Hello" → Agent: "Hi there!"          │  │
│  │  - Turn 2: User: "How are you?" → Agent: "I'm great!"   │  │
│  │  - Turn 3: User: "What's the weather?" → ...            │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                  │
│  Context: Previous messages, agent state, tool results          │
└─────────────────────────────────────────────────────────────────┘
                              ↑
                              │
                    Each message includes
                    full conversation context
                              │
                              ↓
                    ┌──────────────────┐
                    │  Agent Processing │
                    │  (with context)   │
                    └──────────────────┘
```

### WebSocket Lifecycle

```
┌─────────────────────────────────────────────────────────────┐
│                    WebSocket Connection Lifecycle            │
└─────────────────────────────────────────────────────────────┘

1. Client connects → /ws/{user_id}?is_audio=true
   ↓
2. Server accepts connection
   ↓
3. start_agent_session() called
   ├─ Create InMemoryRunner
   ├─ Create Session (with user_id)
   ├─ Configure RunConfig
   ├─ Create LiveRequestQueue
   └─ Start run_live() → returns live_events
   ↓
4. Start two async tasks:
   ├─ agent_to_client_messaging (listens to live_events)
   └─ client_to_agent_messaging (listens to websocket)
   ↓
5. Bidirectional communication active
   ├─ Client → Agent: Text/Audio messages
   └─ Agent → Client: Streaming responses
   ↓
6. Connection closes or error occurs
   ↓
7. Cleanup:
   ├─ Close LiveRequestQueue
   └─ Session state preserved (if resumption enabled)
```

---

## Environment Configuration

### Required Environment Variables

```bash
# Required
GOOGLE_API_KEY=your-api-key-here

# Optional
VOICE_AGENT_MODEL=gemini-2.0-flash-exp
VOICE_AGENT_VOICE=Puck
```

### Dependencies

From `pyproject.toml`:
- `fastapi>=0.115.0` - Web framework
- `uvicorn[standard]>=0.30.0` - ASGI server
- `google-adk>=1.16.0` - Google Agent Development Kit
- `python-dotenv>=1.0.0` - Environment variable management

---

## Summary

### Key Takeaways

1. **WebSocket Communication**: 
   - Endpoint: `/ws/{user_id}?is_audio=true|false`
   - Bidirectional JSON message protocol
   - Supports both text and audio (PCM) communication

2. **Agent Invocation**:
   - Agent defined with model, instructions, and tools
   - Session created per `user_id`
   - Live session started with `run_live()` for streaming responses

3. **Session Memory**:
   - Managed by `InMemoryRunner` (in-memory storage)
   - Session tied to `user_id` and `app_name`
   - `SessionResumptionConfig()` enables conversation history persistence
   - Context automatically included in each agent request

4. **Architecture**:
   - Two concurrent async tasks handle bidirectional communication
   - `LiveRequestQueue` for sending messages to agent
   - `live_events` async iterator for receiving agent responses
   - Real-time streaming of partial responses

This architecture enables real-time, context-aware conversations with the Google ADK agent, supporting both text and voice interactions with automatic session memory management.
