export class LlamaService {
    private systemPrompt: string | null = null;

    async loadSystemPrompt(): Promise<void> {
        try {
            const response = await fetch("/system-prompt.txt");
            if (response.ok) {
                this.systemPrompt = await response.text();
                console.log("System prompt loaded successfully");
            } else {
                console.warn("System prompt file not found, using default behavior");
            }
        } catch (e) {
            console.error("Failed to load system prompt", e);
        }
    }

    async checkStatus(): Promise<boolean> {
        try {
            const res = await fetch("/api/system/ollama");
            const data = await res.json();
            return data.running;
        } catch (e) {
            console.error("Llama status check failed", e);
            return false;
        }
    }

    async *chat(messages: { role: string; content: string }[]): AsyncGenerator<string, void, unknown> {
        // Prepend system prompt if available
        const messagesWithSystem = this.systemPrompt
            ? [{ role: "system", content: this.systemPrompt }, ...messages]
            : messages;

        const response = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                messages: messagesWithSystem,
            }),
        });

        if (!response.ok) throw new Error("Failed to send message");
        if (!response.body) throw new Error("No response body");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            buffer += chunk;

            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith("data: ")) continue;

                const dataStr = trimmed.slice(6);
                if (dataStr === "[DONE]") {
                    return;
                }

                try {
                    const data = JSON.parse(dataStr);
                    const content = data.choices?.[0]?.delta?.content;

                    if (content) {
                        yield content;
                    }
                } catch (e) {
                    console.error("Error parsing JSON chunk", e);
                }
            }
        }
    }
}
