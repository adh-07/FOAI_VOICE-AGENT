# 🎙️ Gemini Voice Agent Studio

A real-time, bidirectional voice agent application powered by the **Google Gemini Live API** and the official `google-genai` SDK.

The application allows users to speak naturally with Google Gemini, receive native spoken audio responses, interrupt the agent at any point (barge-in), and view real-time live transcripts within a dark-mode glassmorphic interface.

---

## ✨ Features

- **⚡ Real-Time Bidirectional Voice Streaming**: Full-duplex audio interaction over WebSockets using the Gemini Live API.
- **🗣️ Natural Turn-Taking & Interruption (Barge-In)**: Automatic Voice Activity Detection (VAD) stops the agent instantly when the user starts speaking, plus a manual "Interrupt" control.
- **🔊 Native High-Fidelity Audio Responses**: Gemini outputs native 24kHz 16-bit PCM spoken audio with customizable prebuilt voices.
- **🛡️ Secure Server-Side Credential Handling**: The `GOOGLE_API_KEY` is loaded strictly on the backend server. It is **never** sent to the client browser, logged, or exposed in client bundles.
- **📝 Live Dual Transcript**: Displays simultaneous real-time transcription of both the user's speech and Gemini's response, with copy and clear actions.
- **🌊 Interactive Audio Visualizer**: Dynamic reactive audio rings and frequency equalizers reacting to both microphone input and agent speech.
- **🎨 Glassmorphic Dark UI**: Modern dark theme with ambient lighting, status indicators, and settings drawer.
- **🚨 Graceful Error & Permission Handling**: Clear, friendly indicators for missing API keys, denied microphone permissions, or network disconnects.

---

## 🏗️ Architecture

```
┌─────────────────────────────────┐        WebSocket (/ws/live)        ┌──────────────────────────────────┐
│         Browser Client          │ ◄────────────────────────────────► │          FastAPI Server          │
│                                 │   16kHz PCM In / 24kHz PCM Out     │                                  │
│  - Web Audio API (Mic Capture)  │                                    │  - Reads GOOGLE_API_KEY from env │
│  - Linear Resampler to 16kHz    │                                    │  - Relays bidirectional stream   │
│  - Gapless 24kHz PCM Playback   │                                    │  - Sanitizes errors & logs       │
│  - Real-time Audio Visualizer   │                                    └─────────────────┬────────────────┘
│  - Live Transcript Feed         │                                                      │
└─────────────────────────────────┘                                                      │  Google Gen AI SDK
                                                                                         │  (google-genai)
                                                                                         ▼
                                                                       ┌──────────────────────────────────┐
                                                                       │      Google Gemini Live API      │
                                                                       │                                  │
                                                                       │  - Model:                        │
                                                                       │    gemini-3.1-flash-live-preview │
                                                                       │  - Native Audio Modality         │
                                                                       │  - Voices: Puck, Aoede, etc.     │
                                                                       │  - Hybrid VAD & Interruption     │
                                                                       └──────────────────────────────────┘
```

---

## ⚙️ Prerequisites

- **Python 3.10+** (Python 3.12 recommended)
- A **Google Gemini API Key** (obtainable from [Google AI Studio](https://aistudio.google.com/))
- A modern web browser with microphone support (Chrome, Edge, Firefox, Safari)

---

## 🚀 Setup & Installation

### 1. Environment Setup

If not already created, set up a virtual environment and activate it:

**On Windows (PowerShell):**
```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

**On macOS / Linux:**
```bash
python3 -m venv .venv
source .venv/bin/activate
```

Install the dependencies:
```bash
pip install -r requirements.txt
```

---

### 2. Configure `GOOGLE_API_KEY`

The application reads the API key from the `GOOGLE_API_KEY` environment variable.

#### Option A: Using a `.env` file (Recommended for Local Dev)
Create a `.env` file in the project root:
```ini
GOOGLE_API_KEY=your_actual_gemini_api_key_here
PORT=8000
HOST=127.0.0.1
```

*(You can copy `.env.example` as a starting template)*:
```powershell
Copy-Item .env.example .env
```

#### Option B: Using Environment Variables in Terminal

**Windows PowerShell:**
```powershell
$env:GOOGLE_API_KEY="your_actual_gemini_api_key_here"
```

**Windows CMD:**
```cmd
set GOOGLE_API_KEY=your_actual_gemini_api_key_here
```

**macOS / Linux (Bash/Zsh):**
```bash
export GOOGLE_API_KEY="your_actual_gemini_api_key_here"
```

> [!IMPORTANT]
> Never commit your `.env` file or hardcode your API key in source code. `.env` is included in `.gitignore` by default.

---

## 🏃 Running the Application

Start the server using Python or Uvicorn:

**Using Python:**
```powershell
.\.venv\Scripts\python server.py
```

**Or using Uvicorn directly:**
```powershell
.\.venv\Scripts\uvicorn server:app --host 127.0.0.1 --port 8000 --reload
```

Once started, open your browser and navigate to:
```
http://127.0.0.1:8000
```

---

## 🗣️ Supported Models & Voices

### Recommended Models
- **`gemini-3.1-flash-live-preview`** *(Default)*: Specifically designed and optimized for low-latency, real-time bidirectional dialogue with native audio output, thinking capabilities, and Voice Activity Detection.
- **`gemini-2.5-flash`**: Fast, versatile multimodal model.

### Available Gemini Live Voices
Configure any of the following natural prebuilt voices in the Settings drawer:
| Voice Name | Tone / Characteristics |
| :--- | :--- |
| **Puck** *(Default)* | Engaging, lively, warm, and conversational |
| **Aoede** | Breezy, articulate, thoughtful, and natural |
| **Charon** | Calm, deep, steady, and grounded |
| **Fenrir** | Crisp, direct, authoritative, and focused |
| **Kore** | Gentle, pleasant, soothing, and friendly |

---

## 🛠️ API & WebSocket Endpoints

- **`GET /api/status`**: Returns server status and whether `GOOGLE_API_KEY` is present (boolean only; never leaks the key).
- **`GET /api/voices`**: Returns the list of available prebuilt Gemini voices and descriptions.
- **`GET /api/models`**: Returns the list of recommended models.
- **`POST /api/chat-turn`**: Fallback REST endpoint for single-turn voice/text queries.
- **`WebSocket /ws/live`**: Real-time bidirectional streaming connection between client and Gemini Live API.

---

## 🔍 Troubleshooting

| Issue | Resolution |
| :--- | :--- |
| **"GOOGLE_API_KEY Not Configured" Banner** | Create a `.env` file in the project root containing `GOOGLE_API_KEY=your_key` or set it in your environment, then click **Refresh Status** or restart the server. |
| **Microphone Permission Denied** | Click the camera/microphone icon in your browser's address bar and grant permission for `http://127.0.0.1:8000`. |
| **Session Disconnect / 403 Forbidden** | Verify that your API key is valid and has access to Gemini 3/2.5 models at [Google AI Studio](https://aistudio.google.com/). |
| **Audio Echo or Feedback** | We strongly recommend using **headphones** during voice conversations to prevent microphone feedback from triggering false interruptions. |
