import asyncio
import base64
import logging
import re
from typing import AsyncGenerator, Callable, Dict, Any, Optional

from google import genai
from google.genai import types
from google.genai import errors

import config

logger = logging.getLogger("gemini_live")

def sanitize_message(msg: str, api_key: Optional[str] = None) -> str:
    """Ensure no API keys or sensitive credentials leak in messages or logs."""
    if not msg:
        return ""
    clean = str(msg)
    if api_key and len(api_key) > 4:
        clean = clean.replace(api_key, "[REDACTED_API_KEY]")
    # Mask common Google API key patterns (AIzaSy...)
    clean = re.sub(r'AIzaSy[A-Za-z0-9_-]{33}', '[REDACTED_API_KEY]', clean)
    clean = re.sub(r'key=[A-Za-z0-9_-]+', 'key=[REDACTED]', clean)
    clean = re.sub(r'api_key=[A-Za-z0-9_-]+', 'api_key=[REDACTED]', clean)
    return clean

class GeminiLiveRelay:
    """
    Manages a real-time bidirectional WebSocket session with Google Gemini Live API.
    Acts as a secure proxy between the browser client and Gemini.
    """

    def __init__(
        self,
        api_key: str,
        model: str = config.DEFAULT_MODEL,
        voice_name: str = config.DEFAULT_VOICE,
        system_instruction: str = config.DEFAULT_SYSTEM_INSTRUCTION
    ):
        self.api_key = api_key
        self.model = model
        self.voice_name = voice_name
        self.system_instruction = system_instruction
        self.client: Optional[genai.Client] = None
        self.session = None
        self.is_connected = False
        self._closing = False

    def build_config(self) -> types.LiveConnectConfig:
        """Constructs the LiveConnectConfig for Gemini Live API."""
        return types.LiveConnectConfig(
            response_modalities=[types.Modality.AUDIO],
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(
                        voice_name=self.voice_name
                    )
                )
            ),
            system_instruction=types.Content(
                parts=[types.Part.from_text(text=self.system_instruction)]
            ),
            input_audio_transcription=types.AudioTranscriptionConfig(),
            output_audio_transcription=types.AudioTranscriptionConfig(),
            thinking_config=types.ThinkingConfig(thinking_level="minimal")
        )

    async def connect(self):
        """Initializes genai client and connects to the Gemini Live session."""
        if not self.api_key:
            raise ValueError("GOOGLE_API_KEY is not configured on the server.")

        self.client = genai.Client(api_key=self.api_key)
        live_config = self.build_config()

        logger.info("Connecting to Gemini Live session with model '%s', voice '%s'", self.model, self.voice_name)
        # client.aio.live.connect is an async context manager
        self._connect_cm = self.client.aio.live.connect(model=self.model, config=live_config)
        self.session = await self._connect_cm.__aenter__()
        self.is_connected = True
        logger.info("Gemini Live session established successfully.")

    async def send_audio_chunk(self, pcm_bytes: bytes):
        """Streams a 16kHz 16-bit mono PCM chunk to Gemini."""
        if not self.is_connected or not self.session:
            return
        try:
            blob = types.Blob(data=pcm_bytes, mime_type=config.INPUT_MIME_TYPE)
            await self.session.send_realtime_input(audio=blob)
        except Exception as e:
            logger.error("Error sending audio chunk to Gemini: %s", sanitize_message(str(e), self.api_key))
            raise

    async def send_text(self, text: str):
        """Sends text input to Gemini."""
        if not self.is_connected or not self.session:
            return
        try:
            await self.session.send_realtime_input(text=text)
        except Exception as e:
            logger.error("Error sending text to Gemini: %s", sanitize_message(str(e), self.api_key))
            raise

    async def send_audio_stream_end(self):
        """Signals to Gemini that microphone input has paused/stopped (Hybrid VAD)."""
        if not self.is_connected or not self.session:
            return
        try:
            await self.session.send_realtime_input(audio_stream_end=True)
        except Exception as e:
            logger.error("Error sending audio_stream_end to Gemini: %s", sanitize_message(str(e), self.api_key))

    async def receive_events(self) -> AsyncGenerator[Dict[str, Any], None]:
        """
        Listens for server messages from Gemini Live API and yields normalized event dictionaries:
        - audio: { "type": "audio", "data": "<base64 PCM 24kHz>" }
        - user_transcript: { "type": "user_transcript", "text": "..." }
        - agent_transcript: { "type": "agent_transcript", "text": "..." }
        - interrupted: { "type": "interrupted" }
        - turn_complete: { "type": "turn_complete" }
        """
        if not self.session:
            return

        try:
            async for response in self.session.receive():
                if self._closing:
                    break

                server_content = response.server_content
                if server_content:
                    # Check for interruption signal (Barge-in / VAD)
                    if server_content.interrupted:
                        logger.debug("Gemini signal: Interrupted")
                        yield {"type": "interrupted"}

                    # Check for user input transcription
                    if server_content.input_transcription and server_content.input_transcription.text:
                        user_text = server_content.input_transcription.text
                        logger.debug("Gemini User Transcript: %s", user_text)
                        yield {
                            "type": "user_transcript",
                            "text": user_text
                        }

                    # Check for model audio/text parts
                    if server_content.model_turn and server_content.model_turn.parts:
                        for part in server_content.model_turn.parts:
                            # Audio chunk (24kHz 16-bit PCM)
                            if part.inline_data and part.inline_data.data:
                                audio_b64 = base64.b64encode(part.inline_data.data).decode("utf-8")
                                yield {
                                    "type": "audio",
                                    "data": audio_b64
                                }
                            # Text chunk if provided
                            if part.text:
                                yield {
                                    "type": "agent_transcript_chunk",
                                    "text": part.text
                                }

                    # Output transcription (clean finalized agent speech transcript)
                    if server_content.output_transcription and server_content.output_transcription.text:
                        agent_text = server_content.output_transcription.text
                        logger.debug("Gemini Agent Transcript: %s", agent_text)
                        yield {
                            "type": "agent_transcript",
                            "text": agent_text
                        }

                    # End of turn signal
                    if server_content.turn_complete:
                        logger.debug("Gemini signal: Turn Complete")
                        yield {"type": "turn_complete"}

                # Check if server requested session close / go_away
                if response.go_away:
                    logger.warning("Gemini Live sent GoAway signal.")
                    yield {"type": "go_away"}
                    break

        except errors.APIError as api_err:
            sanitized = sanitize_message(str(api_err), self.api_key)
            logger.error("Gemini Live API Error: %s", sanitized)
            error_msg = "Gemini API error."
            if "PERMISSION_DENIED" in sanitized or "API_KEY_INVALID" in sanitized:
                error_msg = "Invalid Google API key or access denied. Please verify your GOOGLE_API_KEY."
            elif "RESOURCE_EXHAUSTED" in sanitized:
                error_msg = "Gemini API rate limit or quota exceeded. Please try again in a few moments."
            elif "NOT_FOUND" in sanitized:
                error_msg = f"The model '{self.model}' is not available with your current API key. Try switching to a supported model."
            else:
                error_msg = f"Gemini API error: {sanitized}"

            yield {
                "type": "error",
                "message": error_msg,
                "code": getattr(api_err, "code", 500)
            }
        except Exception as e:
            if not self._closing:
                sanitized = sanitize_message(str(e), self.api_key)
                logger.error("Unexpected error in Gemini receive loop: %s", sanitized)
                yield {
                    "type": "error",
                    "message": f"Connection error: {sanitized}",
                    "code": 500
                }

    async def close(self):
        """Closes the Gemini Live session cleanly."""
        self._closing = True
        self.is_connected = False
        if hasattr(self, "_connect_cm") and self._connect_cm:
            try:
                await self._connect_cm.__aexit__(None, None, None)
            except Exception as e:
                logger.debug("Session cleanup note: %s", str(e))
        self.session = None
        logger.info("Gemini Live relay closed.")
