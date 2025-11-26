import { KokoroTTS, TextSplitterStream } from "kokoro-js";
import { detectWebGPU } from "../utils";

// Load the model
const model_id = "onnx-community/Kokoro-82M-ONNX";
let tts: any = null;

// Initialize the TTS model
(async () => {
    try {

        const device = (await detectWebGPU()) ? "webgpu" : "wasm";
        tts = await KokoroTTS.from_pretrained(model_id, {
            dtype: device === "wasm" ? "q8" : "fp32",
            device,
        });
        self.postMessage({ status: "ready" });
    } catch (e: any) {
        self.postMessage({ status: "error", error: e.message });
        throw e;
    }
})();

// Listen for messages from the main thread
self.addEventListener("message", async (e) => {
    const { text, voice, requestId } = e.data;

    if (!tts) {
        self.postMessage({
            status: "error",
            error: "TTS model not initialized",
            requestId
        });
        return;
    }

    try {
        // Use TextSplitterStream for progressive generation
        const streamer = new TextSplitterStream();
        streamer.push(text);
        streamer.close(); // Indicate we won't add more text

        // Stream audio generation
        const stream = tts.stream(streamer, { voice });

        // Send chunks as they're generated
        for await (const { audio } of stream) {
            self.postMessage({
                status: "chunk",
                requestId,
                audio: {
                    data: audio.audio,
                    sampling_rate: audio.sampling_rate,
                },
            });
        }

        // Notify completion
        self.postMessage({
            status: "complete",
            requestId
        });
    } catch (e: any) {
        self.postMessage({
            status: "error",
            error: e.message,
            requestId
        });
    }
});
