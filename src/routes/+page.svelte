<script lang="ts">
	import { onMount, tick } from 'svelte';

	let messages = $state<{ role: 'user' | 'assistant'; content: string }[]>([]);
	let input = $state('');
	let loading = $state(false);
	let chatContainer: HTMLDivElement;
	
	// Voice Mode State
	let isRecording = $state(false);
	let isMuted = $state(false);
	let recognition: any;
	let tts: any; // KokoroTTS instance
	let ttsBuffer = '';
	let isSpeaking = $state(false);
	let isGeneratingAudio = $state(false);
	let audioContext: AudioContext;
	let audioQueue: AudioBuffer[] = [];
	let isPlaying = false;

	onMount(async () => {
		if (typeof window !== 'undefined') {
			// Initialize Speech Recognition
			const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
			if (SpeechRecognition) {
				recognition = new SpeechRecognition();
				recognition.continuous = false;
				recognition.interimResults = false;
				recognition.lang = 'en-US';

				recognition.onresult = (event: any) => {
					const transcript = event.results[0][0].transcript;
					input = transcript;
					handleSubmit(); // Auto-submit on voice input
				};

				recognition.onend = () => {
					isRecording = false;
				};

				recognition.onerror = (event: any) => {
					console.error('Speech recognition error', event.error);
					isRecording = false;
				};
			}

			// Initialize Kokoro TTS
			try {
				const { KokoroTTS } = await import('kokoro-js');
				// Try to load from local path if possible, otherwise fall back to HF but we want to use the local weights
				// Since we can't easily change the internal loading logic of the library without more info,
				// we will try to use the model ID. If the user mapped /onnx to the file, maybe we can use a relative path?
				// For now, let's try to use the standard load.
				// NOTE: The user said weights are in static/onnx.
				// We will attempt to load using the HF ID for now as the library expects it.
				// If we need to force local, we might need to intercept fetch or configure the library.
				tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-ONNX", {
					dtype: "q8"
				});
				audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
			} catch (e) {
				console.error("Failed to load Kokoro TTS", e);
			}
		}
	});

	function toggleRecording() {
		if (!recognition) {
			alert('Speech recognition is not supported in this browser.');
			return;
		}
		if (isRecording) {
			recognition.stop();
		} else {
			isRecording = true;
			recognition.start();
		}
	}

	async function playNextAudio() {
		if (audioQueue.length === 0) {
			isPlaying = false;
			isSpeaking = false;
			return;
		}

		isPlaying = true;
		isSpeaking = true;
		const buffer = audioQueue.shift()!;
		const source = audioContext.createBufferSource();
		source.buffer = buffer;
		source.connect(audioContext.destination);
		source.onended = () => {
			playNextAudio();
		};
		source.start(0);
	}

	async function speakText(text: string) {
		if (isMuted || !tts || !audioContext) return;
		
		try {
			isGeneratingAudio = true;
			const audio = await tts.generate(text, { voice: "af_sky" });
			isGeneratingAudio = false;
			// audio.audio is a Float32Array, audio.sampling_rate is the rate
			const audioBuffer = audioContext.createBuffer(1, audio.audio.length, audio.sampling_rate);
			audioBuffer.getChannelData(0).set(audio.audio);
			
			audioQueue.push(audioBuffer);
			if (!isPlaying) {
				playNextAudio();
			}
		} catch (e) {
			console.error("TTS Generation failed", e);
			isGeneratingAudio = false;
		}
	}

	function stopSpeaking() {
		audioQueue = [];
		if (audioContext) {
			audioContext.suspend().then(() => audioContext.resume());
			// Or just close/recreate, but suspend/resume might not clear running buffers immediately if not handled.
			// Better: disconnect all nodes?
			// Simplest: just clear queue. The current playing one will finish or we can try to stop it if we kept a reference.
			// For now, clearing queue is a good start.
			isPlaying = false;
			isSpeaking = false;
			isGeneratingAudio = false;
		}
	}

	function processTTSBuffer(force = false) {
		if (isMuted) return;

		// Simple sentence splitting regex
		const sentenceEndings = /[.!?\n]+/;
		let match = ttsBuffer.match(sentenceEndings);

		while (match) {
			const endIdx = match.index! + match[0].length;
			const sentence = ttsBuffer.slice(0, endIdx).trim();
			ttsBuffer = ttsBuffer.slice(endIdx);
			
			if (sentence) {
				speakText(sentence);
			}
			
			match = ttsBuffer.match(sentenceEndings);
		}

		if (force && ttsBuffer.trim()) {
			speakText(ttsBuffer.trim());
			ttsBuffer = '';
		}
	}

	async function scrollToBottom() {
		await tick();
		if (chatContainer) {
			chatContainer.scrollTop = chatContainer.scrollHeight;
		}
	}

	async function handleSubmit() {
		if (!input.trim() || loading) return;

		const userMessage = input.trim();
		input = '';
		messages = [...messages, { role: 'user', content: userMessage }];
		loading = true;
		stopSpeaking(); // Stop any previous speech
		await scrollToBottom();

		try {
			// Add a placeholder for the assistant response
			messages = [...messages, { role: 'assistant', content: '' }];
			
			const response = await fetch('/api/chat', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					messages: messages.slice(0, -1) // Send history excluding the empty placeholder
				})
			});

			if (!response.ok) throw new Error('Failed to send message');
			if (!response.body) throw new Error('No response body');

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				const chunk = decoder.decode(value, { stream: true });
				buffer += chunk;

				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const data = JSON.parse(line);
						if (data.message?.content) {
							const content = data.message.content;
							const lastMsgIndex = messages.length - 1;
							messages[lastMsgIndex].content += content;
							
							// Accumulate for TTS but don't process yet
							ttsBuffer += content;
							
							scrollToBottom();
						}
						if (data.done) {
							loading = false;
							processTTSBuffer(true); // Process the full buffer at once
						}
					} catch (e) {
						console.error('Error parsing JSON chunk', e);
					}
				}
			}

		} catch (error) {
			console.error(error);
			messages = [...messages, { role: 'assistant', content: 'Error: Could not connect to Ollama.' }];
		} finally {
			loading = false;
			scrollToBottom();
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			handleSubmit();
		}
	}
</script>

<div class="flex flex-col h-[calc(100vh-0px)] max-w-4xl mx-auto w-full p-4">
	<!-- Header -->
	<header class="flex items-center justify-between py-4 border-b border-gray-800 mb-4">
		<div class="flex items-center gap-3">
			<div class="w-10 h-10 rounded-full bg-gradient-to-tr from-indigo-500 to-purple-500 flex items-center justify-center shadow-lg shadow-indigo-500/20">
				<svg xmlns="http://www.w3.org/2000/svg" class="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
				</svg>
			</div>
			<div>
				<h1 class="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-indigo-400 to-purple-400">Local LLM Chat</h1>
				<p class="text-xs text-gray-400">Powered by Ollama</p>
			</div>
		</div>
		<div class="flex items-center gap-3">
			<button 
				onclick={() => { isMuted = !isMuted; stopSpeaking(); }}
				class="p-2 rounded-full hover:bg-gray-800 transition-colors text-gray-400"
				title={isMuted ? "Unmute Text-to-Speech" : "Mute Text-to-Speech"}
			>
				{#if isMuted}
					<svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
						<path fill-rule="evenodd" d="M9.383 3.076A1 1 0 0110 4v12a1 1 0 01-1.707.707L4.586 13H2a1 1 0 01-1-1V8a1 1 0 011-1h2.586l3.707-3.707a1 1 0 011.09-.217zM12.293 7.293a1 1 0 011.414 0L15 8.586l1.293-1.293a1 1 0 111.414 1.414L16.414 10l1.293 1.293a1 1 0 01-1.414 1.414L15 11.414l-1.293 1.293a1 1 0 01-1.414-1.414L13.586 10l-1.293-1.293a1 1 0 010-1.414z" clip-rule="evenodd" />
					</svg>
				{:else}
					<svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
						<path fill-rule="evenodd" d="M9.383 3.076A1 1 0 0110 4v12a1 1 0 01-1.707.707L4.586 13H2a1 1 0 01-1-1V8a1 1 0 011-1h2.586l3.707-3.707a1 1 0 011.09-.217zM14.657 2.929a1 1 0 011.414 0A9.972 9.972 0 0119 10a9.972 9.972 0 01-2.929 7.071 1 1 0 01-1.414-1.414A7.971 7.971 0 0017 10c0-2.21-.894-4.208-2.343-5.657a1 1 0 010-1.414zm-2.829 2.828a1 1 0 011.415 0A5.983 5.983 0 0115 10a5.984 5.984 0 01-1.757 4.243 1 1 0 01-1.415-1.415A3.984 3.984 0 0013 10a3.983 3.983 0 00-1.172-2.828 1 1 0 010-1.414z" clip-rule="evenodd" />
					</svg>
				{/if}
			</button>
			<div class="text-xs px-3 py-1 rounded-full bg-gray-900 border border-gray-800 text-gray-400 flex items-center gap-2">
				{#if isGeneratingAudio}
					<span class="w-2 h-2 rounded-full bg-yellow-500 animate-pulse"></span>
					<span>Generating Audio...</span>
				{:else if loading}
					<span class="w-2 h-2 rounded-full bg-indigo-500 animate-pulse"></span>
					<span>Thinking...</span>
				{:else}
					<span class="w-2 h-2 rounded-full bg-green-500"></span>
					<span>Ready</span>
				{/if}
			</div>
		</div>
	</header>

	<!-- Chat Area -->
	<div 
		bind:this={chatContainer}
		class="flex-1 overflow-y-auto space-y-6 pr-2 scrollbar-thin scrollbar-thumb-gray-800 scrollbar-track-transparent"
	>
		{#if messages.length === 0}
			<div class="h-full flex flex-col items-center justify-center text-gray-500 opacity-50">
				<svg xmlns="http://www.w3.org/2000/svg" class="w-16 h-16 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
				</svg>
				<p>Start a conversation...</p>
			</div>
		{/if}

		{#each messages as msg}
			<div class="flex {msg.role === 'user' ? 'justify-end' : 'justify-start'}">
				<div 
					class="max-w-[85%] rounded-2xl px-5 py-3 shadow-sm 
					{msg.role === 'user' 
						? 'bg-indigo-600 text-white rounded-br-none' 
						: 'bg-gray-800 text-gray-200 rounded-bl-none border border-gray-700'}"
				>
					<div class="whitespace-pre-wrap leading-relaxed">{msg.content}</div>
				</div>
			</div>
		{/each}
	</div>

	<!-- Input Area -->
	<div class="mt-4 relative">
		<div class="relative rounded-2xl bg-gray-900 border border-gray-800 focus-within:border-indigo-500/50 focus-within:ring-1 focus-within:ring-indigo-500/50 transition-all shadow-lg flex items-end">
			<textarea
				bind:value={input}
				onkeydown={handleKeydown}
				placeholder="Type your message..."
				class="w-full bg-transparent text-gray-200 placeholder-gray-500 px-4 py-4 pr-24 focus:outline-none resize-none max-h-32 min-h-[60px]"
				rows="1"
			></textarea>
			
			<div class="absolute right-2 bottom-2 flex items-center gap-2">
				<!-- Mic Button -->
				<button
					onclick={toggleRecording}
					class="p-2 rounded-xl transition-all duration-200 {isRecording ? 'bg-red-500/20 text-red-500 animate-pulse' : 'text-gray-400 hover:text-white hover:bg-gray-800'}"
					aria-label="Toggle voice input"
				>
					<svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
						<path fill-rule="evenodd" d="M7 4a3 3 0 016 0v4a3 3 0 11-6 0V4zm4 10.93A7.001 7.001 0 0017 8a1 1 0 10-2 0A5 5 0 015 8a1 1 0 00-2 0 7.001 7.001 0 006 6.93V17H6a1 1 0 100 2h8a1 1 0 100-2h-3v-2.07z" clip-rule="evenodd" />
					</svg>
				</button>

				<!-- Send Button -->
				<button
					onclick={handleSubmit}
					disabled={!input.trim() || loading}
					class="p-2 rounded-xl bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-50 disabled:hover:bg-indigo-600 transition-colors"
					aria-label="Send message"
				>
					<svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
						<path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
					</svg>
				</button>
			</div>
		</div>
		<div class="text-center mt-2">
			<p class="text-[10px] text-gray-600">AI can make mistakes. Check important info.</p>
		</div>
	</div>
</div>
