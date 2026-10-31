import os
from typing import List, Dict

# Supported Gemini Live Models
DEFAULT_MODEL = "gemini-3.1-flash-live-preview"
FALLBACK_MODELS = [
    "gemini-3.1-flash-live-preview",
    "gemini-2.5-flash",
]

# Supported Prebuilt Voices in Gemini Live
VOICES: List[Dict[str, str]] = [
    {
        "id": "Puck",
        "name": "Puck",
        "description": "Engaging, lively, and conversational",
        "tone": "Energetic / Warm"
    },
    {
        "id": "Aoede",
        "name": "Aoede",
        "description": "Breezy, articulate, and thoughtful",
        "tone": "Warm / Natural"
    },
    {
        "id": "Charon",
        "name": "Charon",
        "description": "Calm, deep, and grounded",
        "tone": "Deep / Steady"
    },
    {
        "id": "Fenrir",
        "name": "Fenrir",
        "description": "Crisp, direct, and authoritative",
        "tone": "Confident / Focused"
    },
    {
        "id": "Kore",
        "name": "Kore",
        "description": "Gentle, pleasant, and patient",
        "tone": "Friendly / Soothing"
    }
]

DEFAULT_VOICE = "Puck"

# Audio Settings
# Client sends 16kHz 16-bit mono PCM to server
INPUT_SAMPLE_RATE = 16000
INPUT_MIME_TYPE = "audio/pcm;rate=16000"

# Gemini Live outputs 24kHz 16-bit mono PCM
OUTPUT_SAMPLE_RATE = 24000
OUTPUT_MIME_TYPE = "audio/pcm;rate=24000"

# Default Persona / System Instruction
DEFAULT_SYSTEM_INSTRUCTION = (
    "You are a friendly, intelligent, and highly conversational voice assistant powered by Google Gemini. "
    "Keep your answers concise, natural, and well-suited for spoken dialogue. "
    "Avoid markdown tables or long bullet lists that are awkward when spoken aloud. "
    "Respond warmly, promptly, and directly."
)
