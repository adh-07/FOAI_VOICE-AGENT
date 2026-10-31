import asyncio
import base64
import logging
import os
from typing import Optional
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import config
from gemini_live import GeminiLiveRelay, sanitize_message

# Load environment variables from .env file if present
load_dotenv()

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("gemini_voice_server")

def get_api_key() -> Optional[str]:
    """Retrieve Google API Key safely from environment, hot-reloading .env if modified."""
    load_dotenv(override=True)
    return os.environ.get("GOOGLE_API_KEY", "").strip() or None

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup check
    api_key = get_api_key()
    if api_key:
        masked = f"{api_key[:4]}...{api_key[-4:]}" if len(api_key) > 8 else "***"
        logger.info("Server started with GOOGLE_API_KEY configured (%s)", masked)
    else:
        logger.warning(
            "Server started WITHOUT GOOGLE_API_KEY! "
            "Please configure GOOGLE_API_KEY in your .env file or environment variables to enable voice features."
        )
    yield
    logger.info("Server shutting down.")

app = FastAPI(
    title="Agent",
    description="Real-time conversational voice agent powered by Google Gemini Live API",
    version="1.0.0",
    lifespan=lifespan
)

# Enable CORS for local testing/development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class StatusResponse(BaseModel):
    configured: bool
    message: str
    default_model: str
    default_voice: str
    available_models: list[str]
    available_voices: list[dict]

@app.get("/api/status", response_model=StatusResponse)
async def api_status():
    """Reports configuration status without exposing credentials."""
    api_key = get_api_key()
    configured = bool(api_key)
    msg = (
        "GOOGLE_API_KEY is properly configured."
        if configured
        else "GOOGLE_API_KEY is missing. Please set it in your environment or a .env file."
    )
    return StatusResponse(
        configured=configured,
        message=msg,
        default_model=config.DEFAULT_MODEL,
        default_voice=config.DEFAULT_VOICE,
        available_models=config.FALLBACK_MODELS,
        available_voices=config.VOICES
    )

@app.get("/api/voices")
async def get_voices():
    """List available prebuilt voices for Gemini."""
    return {"voices": config.VOICES}

@app.get("/api/models")
async def get_models():
    """List recommended models for voice interaction."""
    return {"models": config.FALLBACK_MODELS}

class TurnRequest(BaseModel):
    text: Optional[str] = None
    voice: Optional[str] = config.DEFAULT_VOICE
    model: Optional[str] = "gemini-2.5-flash"
    system_instruction: Optional[str] = config.DEFAULT_SYSTEM_INSTRUCTION

@app.post("/api/chat-turn")
async def chat_turn(req: TurnRequest):
    """
    Fallback REST endpoint for single-turn voice/text queries.
    Uses Gemini generate_content with audio output modality.
    """
    api_key = get_api_key()
    if not api_key:
        raise HTTPException(
            status_code=500,
            detail="GOOGLE_API_KEY is not configured on the server."
        )

    from google import genai
    from google.genai import types

    try:
        client = genai.Client(api_key=api_key)
        voice_name = req.voice or config.DEFAULT_VOICE
        model_name = req.model or "gemini-2.5-flash"

        gen_config = types.GenerateContentConfig(
            response_modalities=["AUDIO"],
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(
                        voice_name=voice_name
                    )
                )
            ),
            system_instruction=req.system_instruction or config.DEFAULT_SYSTEM_INSTRUCTION
        )

        response = await client.aio.models.generate_content(
            model=model_name,
            contents=req.text or "Hello! Introduce yourself briefly.",
            config=gen_config
        )

        audio_b64 = None
        transcript = ""

        if response.candidates:
            first_cand = response.candidates[0]
            if first_cand.content and first_cand.content.parts:
                for part in first_cand.content.parts:
                    if part.inline_data and part.inline_data.data:
                        audio_b64 = base64.b64encode(part.inline_data.data).decode("utf-8")
                    if part.text:
                        transcript += part.text

        return {
            "transcript": transcript or "(Audio response)",
            "audio_base64": audio_b64,
            "voice": voice_name,
            "model": model_name
        }
    except Exception as e:
        clean_err = sanitize_message(str(e), api_key)
        logger.error("Error in chat-turn: %s", clean_err)
        raise HTTPException(status_code=500, detail=f"Generation failed: {clean_err}")

@app.websocket("/ws/live")
async def websocket_live_endpoint(websocket: WebSocket):
    """
    Real-time bidirectional WebSocket relay between browser and Gemini Live API.
    Handles continuous 16kHz PCM audio streaming, live transcriptions, 24kHz audio playback,
    and instantaneous interruption.
    """
    await websocket.accept()
    logger.info("Browser client connected to /ws/live")

    api_key = get_api_key()
    if not api_key:
        await websocket.send_json({
            "type": "error",
            "message": "GOOGLE_API_KEY is not set on the server. Please configure it in your .env file or environment variables."
        })
        await websocket.close(code=1008)
        return

    relay: Optional[GeminiLiveRelay] = None
    receive_task: Optional[asyncio.Task] = None

    async def forward_gemini_to_browser():
        """Reads events from Gemini and forwards to browser websocket."""
        try:
            async for event in relay.receive_events():
                await websocket.send_json(event)
        except WebSocketDisconnect:
            logger.info("Browser disconnected during Gemini receive.")
        except asyncio.CancelledError:
            pass
        except Exception as e:
            clean_err = sanitize_message(str(e), api_key)
            logger.error("Error forwarding Gemini event to browser: %s", clean_err)
            try:
                await websocket.send_json({
                    "type": "error",
                    "message": f"Streaming error: {clean_err}"
                })
            except Exception:
                pass

    try:
        # Await initial setup message from client
        initial_msg = await websocket.receive_json()
        msg_type = initial_msg.get("type")

        if msg_type != "start":
            await websocket.send_json({
                "type": "error",
                "message": "Expected 'start' message with configuration."
            })
            await websocket.close(code=1002)
            return

        cfg = initial_msg.get("config", {})
        model_name = cfg.get("model", config.DEFAULT_MODEL)
        voice_name = cfg.get("voice", config.DEFAULT_VOICE)
        system_instruction = cfg.get("system_instruction", config.DEFAULT_SYSTEM_INSTRUCTION)

        relay = GeminiLiveRelay(
            api_key=api_key,
            model=model_name,
            voice_name=voice_name,
            system_instruction=system_instruction
        )

        try:
            await relay.connect()
        except Exception as conn_err:
            clean_err = sanitize_message(str(conn_err), api_key)
            logger.error("Failed to connect to Gemini Live: %s", clean_err)
            if "API key not valid" in clean_err or "PERMISSION_DENIED" in clean_err:
                user_msg = "The configured GOOGLE_API_KEY is not valid or lacks Gemini Live permissions. Please verify your key at https://aistudio.google.com/."
            elif "not found" in clean_err.lower() or "unsupported" in clean_err.lower():
                user_msg = f"Model '{model_name}' is unavailable for your project/key. You can choose another model in Settings."
            else:
                user_msg = f"Failed to connect to Gemini Live: {clean_err}"
            await websocket.send_json({
                "type": "error",
                "message": user_msg
            })
            await websocket.close(code=1011)
            return

        await websocket.send_json({
            "type": "session_started",
            "model": model_name,
            "voice": voice_name
        })

        # Start forwarding Gemini responses in background task
        receive_task = asyncio.create_task(forward_gemini_to_browser())

        # Main loop: receive audio/text from browser and stream to Gemini
        while True:
            data = await websocket.receive_json()
            event_type = data.get("type")

            if event_type == "audio":
                # Audio chunk encoded as base64 16kHz 16-bit mono PCM
                b64_data = data.get("data")
                if b64_data:
                    pcm_chunk = base64.b64decode(b64_data)
                    await relay.send_audio_chunk(pcm_chunk)

            elif event_type == "text":
                text = data.get("text", "")
                if text.strip():
                    await relay.send_text(text)

            elif event_type == "audio_stream_end":
                # User paused speaking or muted mic
                await relay.send_audio_stream_end()

            elif event_type == "interrupt":
                # Client triggered manual barge-in / interrupt
                logger.info("Client requested manual interruption.")

            elif event_type == "stop":
                logger.info("Client requested session stop.")
                break

    except WebSocketDisconnect:
        logger.info("Browser client disconnected cleanly.")
    except Exception as e:
        clean_err = sanitize_message(str(e), api_key)
        logger.error("Error in websocket session: %s", clean_err)
        try:
            await websocket.send_json({
                "type": "error",
                "message": f"Session error: {clean_err}"
            })
        except Exception:
            pass
    finally:
        if receive_task and not receive_task.done():
            receive_task.cancel()
        if relay:
            await relay.close()
        logger.info("Cleaned up WebSocket session.")

# Serve frontend static assets
static_dir = os.path.join(os.path.dirname(__file__), "static")
if not os.path.exists(static_dir):
    os.makedirs(static_dir, exist_ok=True)

app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    host = os.environ.get("HOST", "127.0.0.1")
    logger.info("Starting AGENT on http://%s:%d", host, port)
    uvicorn.run("server:app", host=host, port=port, reload=True)
