import type { RequestHandler } from './$types';


export const GET: RequestHandler = async () => {
    try {
        // Check llama-server health/models endpoint
        const response = await fetch('http://127.0.0.1:8033/health');
        if (response.ok) {
            return new Response(JSON.stringify({ running: true }), { status: 200 });
        }
    } catch (e) {
        // Ignore connection errors
    }
    return new Response(JSON.stringify({ running: false }), { status: 200 });
};

export const POST: RequestHandler = async () => {
    // We no longer spawn from here, just check status
    return GET({} as any);
};
