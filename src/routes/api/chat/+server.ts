import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
    const { messages, model } = await request.json();

    try {
        const response = await fetch('http://127.0.0.1:11434/api/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: model || 'llama3.1:8b', // Default to llama3.1:8b, but allow override
                messages: messages,
                stream: true
            })
        });

        if (!response.ok) {
            return new Response(await response.text(), { status: response.status });
        }

        // Create a readable stream to forward the chunks
        const stream = new ReadableStream({
            async start(controller) {
                if (!response.body) return;
                const reader = response.body.getReader();

                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        controller.enqueue(value);
                    }
                } catch (e) {
                    controller.error(e);
                } finally {
                    controller.close();
                }
            }
        });

        return new Response(stream, {
            headers: {
                'Content-Type': 'application/x-ndjson'
            }
        });

    } catch (error) {
        console.error('Error connecting to Ollama:', error);
        return new Response(JSON.stringify({ error: 'Failed to connect to Ollama' }), { status: 500 });
    }
};
