/**
 * AudioWorkletProcessor for capturing microphone PCM data off the main thread.
 * Buffers samples and sends them to the main thread.
 */
class PCMProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.bufferSize = 2048;
        this.buffer = new Float32Array(this.bufferSize);
        this.bufferIndex = 0;
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        if (!input || !input[0]) {
            return true;
        }

        const channelData = input[0];
        for (let i = 0; i < channelData.length; i++) {
            this.buffer[this.bufferIndex++] = channelData[i];
            if (this.bufferIndex >= this.bufferSize) {
                // Send a copy of the buffer to the main thread
                const chunk = new Float32Array(this.buffer);
                this.port.postMessage(chunk, [chunk.buffer]);
                this.buffer = new Float32Array(this.bufferSize);
                this.bufferIndex = 0;
            }
        }

        return true;
    }
}

registerProcessor('pcm-processor', PCMProcessor);
