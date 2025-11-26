export class SettingsService {
    private readonly VOICE_KEY = "kokoro_voice_id";
    private readonly DEFAULT_VOICE = "af_heart";

    constructor() { }

    getVoice(): string {
        if (typeof window === "undefined") return this.DEFAULT_VOICE;
        return localStorage.getItem(this.VOICE_KEY) || this.DEFAULT_VOICE;
    }

    setVoice(voiceId: string): void {
        if (typeof window === "undefined") return;
        localStorage.setItem(this.VOICE_KEY, voiceId);
    }
}
