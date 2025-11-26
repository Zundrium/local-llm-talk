import KokoroWorker from "$lib/workers/kokoro.worker.ts?worker";

type AudioGenerationCallback = {
    resolve: (audio: { data: Float32Array; sampling_rate: number } | null) => void;
    reject: (error: Error) => void;
    onChunk?: (audio: { data: Float32Array; sampling_rate: number }) => void;
};

export class KokoroService {
    private worker: Worker | null = null;
    private audioContext: AudioContext | null = null;
    private audioQueue: AudioBuffer[] = [];
    private isPlaying = false;
    private generationId = 0;
    private generatingCount = 0;
    private initPromise: Promise<void> | null = null;
    private pendingRequests = new Map<number, AudioGenerationCallback>();
    private requestId = 0;
    private statusChangeCallback: (() => void) | null = null;

    get isGeneratingAudio() {
        return this.generatingCount > 0;
    }

    onStatusChange(callback: () => void) {
        this.statusChangeCallback = callback;
    }

    private notifyStatusChange() {
        if (this.statusChangeCallback) {
            this.statusChangeCallback();
        }
    }

    async initialize(): Promise<void> {
        // Return existing promise if already initializing
        if (this.initPromise) {
            return this.initPromise;
        }

        this.initPromise = new Promise((resolve, reject) => {
            // Create the worker
            this.worker = new KokoroWorker();

            // Initialize AudioContext
            if (typeof window !== "undefined") {
                this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
            }

            // Set up single worker message handler
            this.worker.onmessage = (e) => {
                const { status, requestId } = e.data;

                if (status === "ready") {
                    console.log("Kokoro TTS worker ready");
                    resolve();
                } else if (status === "error" && !requestId) {
                    console.error("Kokoro TTS worker error:", e.data.error);
                    reject(new Error(e.data.error));
                } else if (status === "chunk") {
                    // Handle streaming chunk
                    const callback = this.pendingRequests.get(requestId);
                    if (callback && callback.onChunk) {
                        callback.onChunk(e.data.audio);
                    }
                } else if (status === "complete" || status === "error") {
                    // Handle generation complete/error
                    const callback = this.pendingRequests.get(requestId);
                    if (callback) {
                        this.pendingRequests.delete(requestId);
                        if (status === "complete") {
                            callback.resolve(null); // No final audio, chunks already sent
                        } else {
                            callback.reject(new Error(e.data.error));
                        }
                    }
                }
            };

            this.worker.onerror = (error) => {
                console.error("Worker error:", error);
                reject(error);
            };
        });

        return this.initPromise;
    }

    async speak(text: string, voice: string = "af_heart") {
        if (!this.worker || !this.audioContext) return;

        const myId = this.generationId;
        const currentRequestId = ++this.requestId;

        try {
            console.log("Generating audio for", text);
            this.generatingCount++;
            this.notifyStatusChange();

            // Send message to worker with request ID
            this.worker.postMessage({ text, voice, requestId: currentRequestId });

            // Wait for completion using request ID, handle chunks as they arrive
            await new Promise<void>((resolve, reject) => {
                this.pendingRequests.set(currentRequestId, {
                    resolve: () => resolve(),
                    reject,
                    onChunk: (audio) => {
                        if (myId !== this.generationId) return;

                        // Create AudioBuffer from the chunk
                        const audioBuffer = this.audioContext!.createBuffer(
                            1,
                            audio.data.length,
                            audio.sampling_rate,
                        );
                        audioBuffer.getChannelData(0).set(audio.data);

                        // Add to queue and start playback immediately if not playing
                        this.audioQueue.push(audioBuffer);
                        if (!this.isPlaying) {
                            this.playNextAudio();
                        }
                    }
                });
            });
        } catch (e) {
            console.error("TTS Generation failed", e);
        } finally {
            this.generatingCount = Math.max(0, this.generatingCount - 1);
            this.notifyStatusChange();
        }
    }

    private async playNextAudio() {
        if (!this.audioContext || this.audioQueue.length === 0) {
            this.isPlaying = false;
            return;
        }

        this.isPlaying = true;
        const buffer = this.audioQueue.shift()!;
        const source = this.audioContext.createBufferSource();
        source.buffer = buffer;
        source.connect(this.audioContext.destination);
        source.onended = () => {
            this.playNextAudio();
        };
        source.start(0);
    }

    stop() {
        this.generationId++;
        this.audioQueue = [];
        // Clear any pending requests
        this.pendingRequests.clear();
        if (this.audioContext) {
            this.audioContext.suspend().then(() => this.audioContext?.resume());
            this.isPlaying = false;
        }
        this.generatingCount = 0;
        this.notifyStatusChange();
    }
}

