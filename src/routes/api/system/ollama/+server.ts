import type { RequestHandler } from './$types';
import { spawn } from 'child_process';

export const GET: RequestHandler = async () => {
    try {
        const response = await fetch('http://127.0.0.1:11434/api/tags');
        if (response.ok) {
            return new Response(JSON.stringify({ running: true }), { status: 200 });
        }
    } catch (e) {
        // Ignore connection errors, meaning it's not running
    }
    return new Response(JSON.stringify({ running: false }), { status: 200 });
};

export const POST: RequestHandler = async () => {
    try {
        // Check if already running first
        try {
            const response = await fetch('http://127.0.0.1:11434/api/tags');
            if (response.ok) {
                return new Response(JSON.stringify({ success: true, message: 'Already running' }), { status: 200 });
            }
        } catch (e) {
            // Not running, proceed to spawn
        }

        console.log('Attempting to start Ollama...');
        const ollama = spawn('ollama', ['serve'], {
            detached: true,
            stdio: 'ignore'
        });

        ollama.unref();

        // Give it a moment to potentially fail or start
        await new Promise(resolve => setTimeout(resolve, 1000));

        return new Response(JSON.stringify({ success: true, message: 'Ollama started' }), { status: 200 });
    } catch (error) {
        console.error('Failed to start Ollama:', error);
        return new Response(JSON.stringify({ success: false, error: 'Failed to start Ollama' }), { status: 500 });
    }
};
