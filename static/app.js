/**
 * Gemini Voice Agent Studio - Frontend Client
 * Real-time bidirectional voice streaming over WebSockets with 16kHz PCM mic capture,
 * 24kHz PCM audio playback, gapless scheduling, barge-in interruption, and reactive visualizer.
 */

class VoiceAgentApp {
    constructor() {
        // State
        this.isConnected = false;
        this.isMuted = false;
        this.currentState = 'disconnected'; // disconnected, connecting, listening, thinking, speaking, interrupted, error
        this.apiKeyConfigured = true;

        // Configuration
        this.selectedVoice = 'Puck';
        this.selectedModel = 'gemini-3.1-flash-live-preview';
        this.systemInstruction = '';

        // Audio Input (Microphone)
        this.inputAudioContext = null;
        this.mediaStream = null;
        this.inputSource = null;
        this.inputAnalyser = null;
        this.audioWorkletNode = null;
        this.scriptProcessorNode = null;

        // Audio Output (Agent Speech Playback)
        this.outputAudioContext = null;
        this.outputAnalyser = null;
        this.nextPlayTime = 0;
        this.activeSources = [];

        // WebSocket
        this.socket = null;

        // Active Transcript State
        this.currentAgentBubble = null;
        this.currentAgentTextSpan = null;
        this.currentUserBubble = null;
        this.currentUserTextSpan = null;

        // Visualizer
        this.animFrameId = null;

        // Initialize UI Elements & Event Listeners
        this.initDOMElements();
        this.initEventListeners();
        this.checkServerStatus();
        this.initCanvas();
    }

    /* ----------------------------------------------------------------------
       DOM Initializations
       ---------------------------------------------------------------------- */
    initDOMElements() {
        // Controls
        this.btnToggle = document.getElementById('btnToggleConversation');
        this.startBtnText = document.getElementById('startBtnText');
        this.startBtnIcon = document.getElementById('startBtnIcon');
        this.btnMute = document.getElementById('btnMuteMic');
        this.btnInterrupt = document.getElementById('btnInterrupt');
        this.micIconUnmuted = document.getElementById('micIconUnmuted');
        this.micIconMuted = document.getElementById('micIconMuted');
        this.muteLabel = document.getElementById('muteLabel');

        // Status & Visuals
        this.statusBadge = document.getElementById('connectionStatusBadge');
        this.statusText = document.getElementById('connectionStatusText');
        this.orb = document.getElementById('voiceOrb');
        this.orbWrapper = document.getElementById('orbWrapper');
        this.stateLabel = document.getElementById('agentStateLabel');
        this.stateText = document.getElementById('agentStateText');
        this.canvas = document.getElementById('frequencyCanvas');
        this.canvasCtx = this.canvas.getContext('2d');

        // Banners & Drawers
        this.apiKeyBanner = document.getElementById('apiKeyBanner');
        this.btnCheckKeyStatus = document.getElementById('btnCheckKeyStatus');
        this.btnOpenSettings = document.getElementById('btnOpenSettings');
        this.btnCloseSettings = document.getElementById('btnCloseSettings');
        this.settingsDrawer = document.getElementById('settingsDrawer');
        this.btnSaveSettings = document.getElementById('btnSaveSettings');
        this.selectVoice = document.getElementById('selectVoice');
        this.selectModel = document.getElementById('selectModel');
        this.voiceDescription = document.getElementById('voiceDescription');
        this.systemInstructionInput = document.getElementById('systemInstructionInput');

        // Transcript
        this.transcriptFeed = document.getElementById('transcriptFeed');
        this.transcriptPlaceholder = document.getElementById('transcriptPlaceholder');
        this.btnClearTranscript = document.getElementById('btnClearTranscript');
        this.btnCopyTranscript = document.getElementById('btnCopyTranscript');
        this.textInputForm = document.getElementById('textInputForm');
        this.userTextInput = document.getElementById('userTextInput');

        // Quick prompts
        this.promptChips = document.querySelectorAll('.prompt-chip');
    }

    initEventListeners() {
        this.btnToggle.addEventListener('click', () => this.toggleConversation());
        this.btnMute.addEventListener('click', () => this.toggleMute());
        this.btnInterrupt.addEventListener('click', () => this.handleInterrupt(true));

        this.btnOpenSettings.addEventListener('click', () => this.openSettings());
        this.btnCloseSettings.addEventListener('click', () => this.closeSettings());
        this.btnSaveSettings.addEventListener('click', () => this.saveSettings());

        this.selectVoice.addEventListener('change', () => this.updateVoiceDescription());
        this.btnCheckKeyStatus.addEventListener('click', () => this.checkServerStatus(true));

        this.btnClearTranscript.addEventListener('click', () => this.clearTranscript());
        this.btnCopyTranscript.addEventListener('click', () => this.copyTranscript());

        this.textInputForm.addEventListener('submit', (e) => this.handleTextSubmit(e));

        this.promptChips.forEach(chip => {
            chip.addEventListener('click', () => {
                const text = chip.textContent.replace(/^"|"$/g, '');
                this.usePrompt(text);
            });
        });

        // Close drawer on background click
        window.addEventListener('click', (e) => {
            if (this.settingsDrawer && !this.settingsDrawer.contains(e.target) && !this.btnOpenSettings.contains(e.target)) {
                this.closeSettings();
            }
        });
    }

    /* ----------------------------------------------------------------------
       Server Diagnostics & Key Status
       ---------------------------------------------------------------------- */
    async checkServerStatus(showToastOnSuccess = false) {
        try {
            const res = await fetch('/api/status');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();

            this.apiKeyConfigured = data.configured;
            if (!data.configured) {
                this.apiKeyBanner.classList.remove('hidden');
                this.showToast('GOOGLE_API_KEY is missing on the server.', 'error');
            } else {
                this.apiKeyBanner.classList.add('hidden');
                if (showToastOnSuccess) {
                    this.showToast('GOOGLE_API_KEY is configured and active!', 'success');
                }
            }

            if (data.default_voice && !this.systemInstruction) {
                this.selectedVoice = data.default_voice;
                this.selectVoice.value = data.default_voice;
            }
            if (data.default_model) {
                this.selectedModel = data.default_model;
                this.selectModel.value = data.default_model;
            }
            this.systemInstruction = this.systemInstructionInput.value.trim();
        } catch (err) {
            console.warn('Could not reach /api/status:', err);
            this.apiKeyBanner.classList.remove('hidden');
        }
    }

    /* ----------------------------------------------------------------------
       Session Management (Start / Stop)
       ---------------------------------------------------------------------- */
    async toggleConversation() {
        if (this.isConnected) {
            this.stopConversation();
        } else {
            await this.startConversation();
        }
    }

    async startConversation() {
        if (!this.apiKeyConfigured) {
            this.showToast('Please configure GOOGLE_API_KEY on the server before starting.', 'error');
            this.apiKeyBanner.classList.remove('hidden');
            return;
        }

        this.setState('connecting', 'Connecting to Gemini Live...');
        this.btnToggle.disabled = true;

        try {
            // 1. Initialize Audio Contexts
            await this.initAudioContexts();

            // 2. Open Microphone Stream
            await this.startMicrophone();

            // 3. Connect WebSocket Relay
            await this.connectWebSocket();

            this.isConnected = true;
            this.btnToggle.disabled = false;
            this.btnToggle.classList.add('active-session');
            this.btnToggle.setAttribute('aria-pressed', 'true');
            this.startBtnText.textContent = 'End Conversation';
            this.btnMute.disabled = false;
            this.btnInterrupt.disabled = false;

            this.setState('listening', 'Listening... Speak naturally');
            this.showToast('Voice session connected. Gemini is listening!', 'success');

        } catch (err) {
            console.error('Failed to start conversation:', err);
            this.stopConversation();
            this.setState('error', 'Failed to start');
            this.btnToggle.disabled = false;

            if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
                this.showToast('Microphone access was denied. Please allow microphone permissions in your browser.', 'error');
            } else {
                this.showToast(`Error: ${err.message || 'Could not start voice session'}`, 'error');
            }
        }
    }

    stopConversation() {
        // Send stop to server
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            try {
                this.socket.send(JSON.stringify({ type: 'stop' }));
                this.socket.close();
            } catch (e) {}
        }
        this.socket = null;

        // Stop microphone
        this.stopMicrophone();

        // Halt playback
        this.interruptPlayback();

        this.isConnected = false;
        this.isMuted = false;
        this.updateMuteUI();

        this.btnToggle.disabled = false;
        this.btnToggle.classList.remove('active-session');
        this.btnToggle.setAttribute('aria-pressed', 'false');
        this.startBtnText.textContent = 'Start Conversation';
        this.btnMute.disabled = true;
        this.btnInterrupt.disabled = true;

        this.setState('disconnected', 'Ready to start');
    }

    /* ----------------------------------------------------------------------
       Web Audio Pipeline (Capture & Resampling to 16kHz PCM)
       ---------------------------------------------------------------------- */
    async initAudioContexts() {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;

        if (!this.inputAudioContext) {
            this.inputAudioContext = new AudioContextClass();
        }
        if (this.inputAudioContext.state === 'suspended') {
            await this.inputAudioContext.resume();
        }

        if (!this.outputAudioContext) {
            // Native output rate or 24000
            this.outputAudioContext = new AudioContextClass({ sampleRate: 24000 });
        }
        if (this.outputAudioContext.state === 'suspended') {
            await this.outputAudioContext.resume();
        }

        // Setup Output Analyser
        if (!this.outputAnalyser) {
            this.outputAnalyser = this.outputAudioContext.createAnalyser();
            this.outputAnalyser.fftSize = 64;
            this.outputAnalyser.smoothingTimeConstant = 0.8;
            this.outputAnalyser.connect(this.outputAudioContext.destination);
        }
    }

    async startMicrophone() {
        this.mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                channelCount: 1,
            }
        });

        this.inputSource = this.inputAudioContext.createMediaStreamSource(this.mediaStream);

        // Input Analyser for Visualizer
        this.inputAnalyser = this.inputAudioContext.createAnalyser();
        this.inputAnalyser.fftSize = 64;
        this.inputAnalyser.smoothingTimeConstant = 0.8;
        this.inputSource.connect(this.inputAnalyser);

        const sampleRate = this.inputAudioContext.sampleRate;

        // Attempt AudioWorklet first, fall back to ScriptProcessorNode
        let workletLoaded = false;
        try {
            await this.inputAudioContext.audioWorklet.addModule('audio-processor.js');
            this.audioWorkletNode = new AudioWorkletNode(this.inputAudioContext, 'pcm-processor');
            this.audioWorkletNode.port.onmessage = (event) => {
                if (this.isMuted || !this.isConnected) return;
                const float32Chunk = event.data;
                this.processAndSendPCM(float32Chunk, sampleRate);
            };
            this.inputSource.connect(this.audioWorkletNode);
            workletLoaded = true;
        } catch (workletErr) {
            console.warn('AudioWorklet module failed or not supported in this context, falling back to ScriptProcessor:', workletErr);
        }

        if (!workletLoaded) {
            // ScriptProcessorNode fallback (bufferSize 2048, 1 input channel, 1 output channel)
            this.scriptProcessorNode = this.inputAudioContext.createScriptProcessor(2048, 1, 1);
            this.scriptProcessorNode.onaudioprocess = (event) => {
                if (this.isMuted || !this.isConnected) return;
                const inputData = event.inputBuffer.getChannelData(0);
                this.processAndSendPCM(inputData, sampleRate);
            };
            this.inputSource.connect(this.scriptProcessorNode);
            this.scriptProcessorNode.connect(this.inputAudioContext.destination);
        }
    }

    stopMicrophone() {
        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach(track => track.stop());
            this.mediaStream = null;
        }
        if (this.audioWorkletNode) {
            try { this.audioWorkletNode.disconnect(); } catch (e) {}
            this.audioWorkletNode = null;
        }
        if (this.scriptProcessorNode) {
            try { this.scriptProcessorNode.disconnect(); } catch (e) {}
            this.scriptProcessorNode = null;
        }
        if (this.inputSource) {
            try { this.inputSource.disconnect(); } catch (e) {}
            this.inputSource = null;
        }
    }

    /**
     * Resamples Float32 audio chunk to 16,000 Hz, encodes as 16-bit little-endian PCM,
     * and sends over WebSocket as Base64 string.
     */
    processAndSendPCM(float32Buffer, inputSampleRate) {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;

        const targetRate = 16000;
        let pcm16Buffer;

        if (inputSampleRate === targetRate) {
            pcm16Buffer = new Int16Array(float32Buffer.length);
            for (let i = 0; i < float32Buffer.length; i++) {
                const s = Math.max(-1, Math.min(1, float32Buffer[i]));
                pcm16Buffer[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
            }
        } else {
            // Downsample using average pooling / linear interpolation
            const ratio = inputSampleRate / targetRate;
            const newLength = Math.round(float32Buffer.length / ratio);
            pcm16Buffer = new Int16Array(newLength);

            let offsetResult = 0;
            let offsetBuffer = 0;
            while (offsetResult < newLength) {
                const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
                let accum = 0;
                let count = 0;
                for (let i = offsetBuffer; i < nextOffsetBuffer && i < float32Buffer.length; i++) {
                    accum += float32Buffer[i];
                    count++;
                }
                const sample = count > 0 ? accum / count : float32Buffer[offsetBuffer] || 0;
                const clamped = Math.max(-1, Math.min(1, sample));
                pcm16Buffer[offsetResult] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
                offsetResult++;
                offsetBuffer = nextOffsetBuffer;
            }
        }

        // Convert Int16Array buffer to base64
        const uint8Bytes = new Uint8Array(pcm16Buffer.buffer);
        let binary = '';
        const len = uint8Bytes.byteLength;
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(uint8Bytes[i]);
        }
        const b64Data = window.btoa(binary);

        this.socket.send(JSON.stringify({
            type: 'audio',
            data: b64Data
        }));
    }

    /* ----------------------------------------------------------------------
       Web Audio Playback (24kHz PCM from Gemini)
       ---------------------------------------------------------------------- */
    playAudioChunk(base64AudioData) {
        if (!this.outputAudioContext) return;

        // Decode Base64 to ArrayBuffer
        const binaryString = window.atob(base64AudioData);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }

        const int16View = new Int16Array(bytes.buffer);
        const float32Data = new Float32Array(int16View.length);
        for (let i = 0; i < int16View.length; i++) {
            float32Data[i] = int16View[i] / 32768.0;
        }

        // Create 24kHz AudioBuffer
        const sampleRate = 24000;
        const audioBuffer = this.outputAudioContext.createBuffer(1, float32Data.length, sampleRate);
        audioBuffer.copyToChannel(float32Data, 0);

        // Schedule gapless playback
        const source = this.outputAudioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this.outputAnalyser);

        const currentTime = this.outputAudioContext.currentTime;
        const startTime = Math.max(currentTime, this.nextPlayTime);
        source.start(startTime);
        this.nextPlayTime = startTime + audioBuffer.duration;

        this.activeSources.push(source);
        this.setState('speaking', 'Gemini is speaking...');

        source.onended = () => {
            const index = this.activeSources.indexOf(source);
            if (index !== -1) {
                this.activeSources.splice(index, 1);
            }
            if (this.activeSources.length === 0 && this.nextPlayTime <= this.outputAudioContext.currentTime) {
                if (this.isConnected) {
                    this.setState('listening', 'Listening... Speak naturally');
                }
            }
        };
    }

    interruptPlayback() {
        for (const src of this.activeSources) {
            try {
                src.stop(0);
                src.disconnect();
            } catch (e) {}
        }
        this.activeSources = [];
        if (this.outputAudioContext) {
            this.nextPlayTime = this.outputAudioContext.currentTime;
        }
    }

    /* ----------------------------------------------------------------------
       WebSocket Relay Connection
       ---------------------------------------------------------------------- */
    async connectWebSocket() {
        return new Promise((resolve, reject) => {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = `${protocol}//${window.location.host}/ws/live`;

            this.socket = new WebSocket(wsUrl);

            this.socket.onopen = () => {
                // Send start configuration message
                this.socket.send(JSON.stringify({
                    type: 'start',
                    config: {
                        model: this.selectedModel,
                        voice: this.selectedVoice,
                        system_instruction: this.systemInstructionInput.value.trim()
                    }
                }));
            };

            this.socket.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data);
                    this.handleServerMessage(msg, resolve);
                } catch (err) {
                    console.error('Failed to parse incoming WebSocket message:', err);
                }
            };

            this.socket.onerror = (error) => {
                console.error('WebSocket error:', error);
                reject(new Error('WebSocket connection failed'));
            };

            this.socket.onclose = (event) => {
                console.info('WebSocket connection closed:', event.code, event.reason);
                if (this.isConnected) {
                    this.stopConversation();
                    if (event.code !== 1000) {
                        this.showToast('Session disconnected by server.', 'error');
                    }
                }
            };
        });
    }

    handleServerMessage(msg, resolvePromise) {
        const type = msg.type;

        switch (type) {
            case 'session_started':
                console.info('Gemini Live session initialized:', msg.model, msg.voice);
                if (resolvePromise) resolvePromise();
                break;

            case 'audio':
                // Gemini speech audio chunk
                if (msg.data) {
                    this.playAudioChunk(msg.data);
                }
                break;

            case 'user_transcript':
                // Transcribed user input
                if (msg.text) {
                    this.appendUserTranscript(msg.text);
                }
                break;

            case 'agent_transcript':
                // Finalized agent response transcript
                if (msg.text) {
                    this.appendOrUpdateAgentTranscript(msg.text, true);
                }
                break;

            case 'agent_transcript_chunk':
                // Streaming text chunk
                if (msg.text) {
                    this.appendOrUpdateAgentTranscript(msg.text, false);
                }
                break;

            case 'interrupted':
                // Gemini detected user barge-in!
                console.info('Interruption signal received from Gemini.');
                this.handleInterrupt(false);
                break;

            case 'turn_complete':
                // Turn finished
                this.finalizeCurrentBubbles();
                break;

            case 'go_away':
                this.showToast('Session reached connection time limit.', 'info');
                this.stopConversation();
                break;

            case 'error':
                console.error('Server error received:', msg.message);
                this.showToast(msg.message || 'Error from Gemini API', 'error');
                this.setState('error', 'API Error');
                break;

            default:
                break;
        }
    }

    /* ----------------------------------------------------------------------
       Interruption & Turn-Taking Handling
       ---------------------------------------------------------------------- */
    handleInterrupt(manual = false) {
        // Halt current audio immediately
        this.interruptPlayback();

        // Mark current agent bubble as interrupted
        if (this.currentAgentBubble) {
            const existingTag = this.currentAgentBubble.querySelector('.interrupted-tag');
            if (!existingTag) {
                const tag = document.createElement('span');
                tag.className = 'interrupted-tag';
                tag.textContent = 'Interrupted';
                this.currentAgentBubble.appendChild(tag);
            }
            this.currentAgentBubble = null;
            this.currentAgentTextSpan = null;
        }

        // Notify server if manual button clicked
        if (manual && this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify({ type: 'interrupt' }));
        }

        this.setState('interrupted', 'Interrupted');
        setTimeout(() => {
            if (this.isConnected) {
                this.setState('listening', 'Listening... Speak naturally');
            }
        }, 600);
    }

    toggleMute() {
        if (!this.isConnected) return;
        this.isMuted = !this.isMuted;
        this.updateMuteUI();

        if (this.isMuted) {
            // Signal audio stream end to flush any pending buffer
            if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                this.socket.send(JSON.stringify({ type: 'audio_stream_end' }));
            }
            this.showToast('Microphone muted', 'info');
        } else {
            this.showToast('Microphone unmuted', 'info');
        }
    }

    updateMuteUI() {
        if (this.isMuted) {
            this.btnMute.classList.add('active');
            this.micIconUnmuted.classList.add('hidden');
            this.micIconMuted.classList.remove('hidden');
            this.muteLabel.textContent = 'Unmute';
        } else {
            this.btnMute.classList.remove('active');
            this.micIconUnmuted.classList.remove('hidden');
            this.micIconMuted.classList.add('hidden');
            this.muteLabel.textContent = 'Mute';
        }
    }

    /* ----------------------------------------------------------------------
       Transcript Management
       ---------------------------------------------------------------------- */
    appendUserTranscript(text) {
        this.hideTranscriptPlaceholder();

        // Create new user bubble
        const item = document.createElement('div');
        item.className = 'transcript-item user';

        const avatar = document.createElement('div');
        avatar.className = 'transcript-avatar';
        avatar.textContent = 'You';

        const bubble = document.createElement('div');
        bubble.className = 'transcript-bubble';

        const textSpan = document.createElement('span');
        textSpan.textContent = text;
        bubble.appendChild(textSpan);

        const time = document.createElement('span');
        time.className = 'transcript-time';
        time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        bubble.appendChild(time);

        item.appendChild(avatar);
        item.appendChild(bubble);
        this.transcriptFeed.appendChild(item);

        this.currentUserBubble = bubble;
        this.currentUserTextSpan = textSpan;
        this.scrollTranscriptToBottom();
    }

    appendOrUpdateAgentTranscript(text, isFinal = false) {
        this.hideTranscriptPlaceholder();

        if (!this.currentAgentBubble) {
            const item = document.createElement('div');
            item.className = 'transcript-item agent';

            const avatar = document.createElement('div');
            avatar.className = 'transcript-avatar';
            avatar.textContent = '✦';

            const bubble = document.createElement('div');
            bubble.className = 'transcript-bubble';

            const textSpan = document.createElement('span');
            textSpan.textContent = text;
            bubble.appendChild(textSpan);

            const time = document.createElement('span');
            time.className = 'transcript-time';
            time.textContent = `${this.selectedVoice} • ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
            bubble.appendChild(time);

            item.appendChild(avatar);
            item.appendChild(bubble);
            this.transcriptFeed.appendChild(item);

            this.currentAgentBubble = bubble;
            this.currentAgentTextSpan = textSpan;
        } else {
            if (isFinal) {
                this.currentAgentTextSpan.textContent = text;
            } else {
                this.currentAgentTextSpan.textContent += text;
            }
        }

        this.scrollTranscriptToBottom();
    }

    finalizeCurrentBubbles() {
        this.currentAgentBubble = null;
        this.currentAgentTextSpan = null;
        this.currentUserBubble = null;
        this.currentUserTextSpan = null;
    }

    hideTranscriptPlaceholder() {
        if (this.transcriptPlaceholder) {
            this.transcriptPlaceholder.style.display = 'none';
        }
    }

    clearTranscript() {
        this.transcriptFeed.innerHTML = '';
        if (this.transcriptPlaceholder) {
            this.transcriptPlaceholder.style.display = 'block';
            this.transcriptFeed.appendChild(this.transcriptPlaceholder);
        }
        this.currentAgentBubble = null;
        this.currentUserBubble = null;
        this.showToast('Transcript cleared', 'info');
    }

    copyTranscript() {
        const items = this.transcriptFeed.querySelectorAll('.transcript-item');
        if (items.length === 0) {
            this.showToast('No transcript to copy.', 'info');
            return;
        }

        let fullText = '=== Gemini Voice Conversation Transcript ===\n\n';
        items.forEach(item => {
            const role = item.classList.contains('user') ? 'User' : 'Gemini Agent';
            const bubble = item.querySelector('.transcript-bubble span:first-child');
            const time = item.querySelector('.transcript-time');
            const content = bubble ? bubble.textContent.trim() : '';
            const timestamp = time ? `[${time.textContent.trim()}]` : '';
            fullText += `${timestamp} ${role}: ${content}\n\n`;
        });

        navigator.clipboard.writeText(fullText).then(() => {
            this.showToast('Transcript copied to clipboard!', 'success');
        }).catch(err => {
            this.showToast('Failed to copy to clipboard', 'error');
        });
    }

    scrollTranscriptToBottom() {
        this.transcriptFeed.scrollTop = this.transcriptFeed.scrollHeight;
    }

    /* ----------------------------------------------------------------------
       Text Input & Suggested Prompts
       ---------------------------------------------------------------------- */
    handleTextSubmit(e) {
        e.preventDefault();
        const text = this.userTextInput.value.trim();
        if (!text) return;
        this.userTextInput.value = '';

        if (!this.isConnected) {
            this.startConversation().then(() => {
                this.sendText(text);
            });
        } else {
            this.sendText(text);
        }
    }

    sendText(text) {
        this.appendUserTranscript(text);
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify({
                type: 'text',
                text: text
            }));
            this.setState('thinking', 'Gemini is thinking...');
        }
    }

    usePrompt(promptText) {
        if (!this.isConnected) {
            this.startConversation().then(() => {
                this.sendText(promptText);
            });
        } else {
            this.sendText(promptText);
        }
    }

    /* ----------------------------------------------------------------------
       Settings Management
       ---------------------------------------------------------------------- */
    openSettings() {
        this.settingsDrawer.classList.remove('hidden');
    }

    closeSettings() {
        this.settingsDrawer.classList.add('hidden');
    }

    updateVoiceDescription() {
        const descMap = {
            'Puck': 'Engaging, lively, and conversational',
            'Aoede': 'Breezy, articulate, and thoughtful',
            'Charon': 'Calm, deep, and grounded',
            'Fenrir': 'Crisp, direct, and authoritative',
            'Kore': 'Gentle, pleasant, and patient'
        };
        const voice = this.selectVoice.value;
        this.voiceDescription.textContent = descMap[voice] || 'Prebuilt voice';
    }

    saveSettings() {
        this.selectedVoice = this.selectVoice.value;
        this.selectedModel = this.selectModel.value;
        this.closeSettings();
        this.showToast(`Settings applied: Voice ${this.selectedVoice}, Model ${this.selectedModel}`, 'success');

        if (this.isConnected) {
            this.showToast('Restarting session with updated settings...', 'info');
            this.stopConversation();
            setTimeout(() => this.startConversation(), 400);
        }
    }

    /* ----------------------------------------------------------------------
       State Transition & Visualizer
       ---------------------------------------------------------------------- */
    setState(state, label) {
        this.currentState = state;
        this.stateText.textContent = label;

        // Reset orb classes
        this.orb.className = 'voice-orb';
        this.orbWrapper.classList.remove('active');

        // Status badge updates
        this.statusBadge.className = 'status-badge';

        switch (state) {
            case 'disconnected':
                this.statusBadge.classList.add('disconnected');
                this.statusText.textContent = 'Offline';
                break;
            case 'connecting':
                this.statusBadge.classList.add('connecting');
                this.statusText.textContent = 'Connecting...';
                this.orb.classList.add('state-thinking');
                break;
            case 'listening':
                this.statusBadge.classList.add('listening');
                this.statusText.textContent = 'Listening';
                this.orb.classList.add('state-listening');
                this.orbWrapper.classList.add('active');
                break;
            case 'thinking':
                this.statusBadge.classList.add('connecting');
                this.statusText.textContent = 'Thinking';
                this.orb.classList.add('state-thinking');
                break;
            case 'speaking':
                this.statusBadge.classList.add('speaking');
                this.statusText.textContent = 'Speaking';
                this.orb.classList.add('state-speaking');
                this.orbWrapper.classList.add('active');
                break;
            case 'interrupted':
                this.statusBadge.classList.add('speaking');
                this.statusText.textContent = 'Interrupted';
                this.orb.classList.add('state-interrupted');
                break;
            case 'error':
                this.statusBadge.classList.add('error');
                this.statusText.textContent = 'Error';
                this.orb.classList.add('state-interrupted');
                break;
        }
    }

    /* ----------------------------------------------------------------------
       Canvas Audio Waveform Visualizer
       ---------------------------------------------------------------------- */
    initCanvas() {
        const render = () => {
            this.animFrameId = requestAnimationFrame(render);
            this.drawVisualizer();
        };
        render();
    }

    drawVisualizer() {
        const ctx = this.canvasCtx;
        const width = this.canvas.width;
        const height = this.canvas.height;

        ctx.clearRect(0, 0, width, height);

        let activeAnalyser = null;
        if (this.currentState === 'speaking' && this.outputAnalyser) {
            activeAnalyser = this.outputAnalyser;
        } else if (this.currentState === 'listening' && this.inputAnalyser && !this.isMuted) {
            activeAnalyser = this.inputAnalyser;
        }

        const barCount = 36;
        const barWidth = 6;
        const gap = 8;
        const startX = (width - (barCount * (barWidth + gap) - gap)) / 2;

        if (activeAnalyser) {
            const bufferLength = activeAnalyser.frequencyBinCount;
            const dataArray = new Uint8Array(bufferLength);
            activeAnalyser.getByteFrequencyData(dataArray);

            // Compute volume/energy
            let sum = 0;
            for (let i = 0; i < bufferLength; i++) {
                sum += dataArray[i];
            }
            const avgVolume = sum / bufferLength;

            // Subtle scale pulse on orb
            const scale = 1.0 + (avgVolume / 255) * 0.25;
            this.orb.style.transform = `scale(${scale})`;

            // Draw frequency bars
            for (let i = 0; i < barCount; i++) {
                // Pick sampled frequency
                const dataIndex = Math.floor((i / barCount) * (bufferLength / 1.5));
                const value = dataArray[dataIndex] || 0;
                const barHeight = Math.max(4, (value / 255) * (height - 10));

                const x = startX + i * (barWidth + gap);
                const y = (height - barHeight) / 2;

                const gradient = ctx.createLinearGradient(0, y, 0, y + barHeight);
                if (this.currentState === 'speaking') {
                    gradient.addColorStop(0, '#c084fc');
                    gradient.addColorStop(1, '#ec4899');
                } else {
                    gradient.addColorStop(0, '#34d399');
                    gradient.addColorStop(1, '#38bdf8');
                }

                ctx.fillStyle = gradient;
                ctx.beginPath();
                ctx.roundRect(x, y, barWidth, barHeight, 3);
                ctx.fill();
            }
        } else {
            // Idle subtle resting wave
            this.orb.style.transform = '';
            const time = Date.now() * 0.003;
            for (let i = 0; i < barCount; i++) {
                const wave = Math.sin(time + i * 0.3);
                const barHeight = 4 + (wave + 1) * 3;
                const x = startX + i * (barWidth + gap);
                const y = (height - barHeight) / 2;

                ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
                ctx.beginPath();
                ctx.roundRect(x, y, barWidth, barHeight, 2);
                ctx.fill();
            }
        }
    }

    /* ----------------------------------------------------------------------
       Toasts Notification Helper
       ---------------------------------------------------------------------- */
    showToast(message, type = 'info') {
        const container = document.getElementById('toastContainer');
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.textContent = message;

        container.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(10px)';
            toast.style.transition = 'all 0.3s ease';
            setTimeout(() => {
                if (toast.parentNode) toast.parentNode.removeChild(toast);
            }, 300);
        }, 4000);
    }
}

// Instantiate on DOMContentLoaded
window.addEventListener('DOMContentLoaded', () => {
    window.voiceAgent = new VoiceAgentApp();
});
