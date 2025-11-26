<script lang="ts">
	import { onMount, tick } from "svelte";
	import { LlamaService } from "$lib/services/LlamaService";
	import { KokoroService } from "$lib/services/KokoroService";

	import { SettingsService } from "$lib/services/SettingsService";
	import voices from "$lib/data/voices.json";

	let messages = $state<{ role: "user" | "assistant"; content: string }[]>(
		[],
	);
	let input = $state("");
	let loading = $state(false);
	let chatContainer: HTMLDivElement;

	// Initialization State
	let isAppReady = $state(false);
	let ollamaInitialized = $state(false);
	let kokoroInitialized = $state(false);
	let initError = $state("");

	// Services
	const llamaService = new LlamaService();
	const kokoroService = new KokoroService();
	const settingsService = new SettingsService();

	// Voice Mode State
	let isRecording = $state(false);
	let isMuted = $state(false);
	let recognition: any;
	let ttsBuffer = "";
	let isGeneratingAudio = $state(false);

	// Settings
	let selectedVoice = $state(settingsService.getVoice());

	// Update isGeneratingAudio reactively
	kokoroService.onStatusChange(() => {
		isGeneratingAudio = kokoroService.isGeneratingAudio;
	});

	onMount(async () => {
		if (typeof window !== "undefined") {
			// Start initialization
			initializeSystem();

			// Initialize Speech Recognition
			const SpeechRecognition =
				(window as any).SpeechRecognition ||
				(window as any).webkitSpeechRecognition;
			if (SpeechRecognition) {
				recognition = new SpeechRecognition();
				recognition.continuous = false;
				recognition.interimResults = false;
				recognition.lang = "en-US";

				recognition.onresult = (event: any) => {
					const transcript = event.results[0][0].transcript;
					input = transcript;
					handleSubmit(); // Auto-submit on voice input
				};

				recognition.onend = () => {
					isRecording = false;
				};

				recognition.onerror = (event: any) => {
					console.error("Speech recognition error", event.error);
					isRecording = false;
				};
			}
		}
	});

	function handleVoiceChange(event: Event) {
		const select = event.target as HTMLSelectElement;
		const voiceId = select.value;
		selectedVoice = voiceId;
		settingsService.setVoice(voiceId);
	}

	async function initializeSystem() {
		try {
			// 1. Initialize Kokoro TTS
			await initKokoro();

			// 2. Initialize/Check Ollama
			await initOllama();
		} catch (e) {
			console.error("Initialization failed", e);
			initError = "Failed to initialize system.";
		}
	}

	async function initKokoro() {
		try {
			await kokoroService.initialize();
			kokoroInitialized = true;
			checkReady();
		} catch (e) {
			console.error("Failed to load Kokoro TTS", e);
			initError = "Failed to load TTS engine.";
		}
	}

	async function initOllama() {
		try {
			// Load system prompt
			await llamaService.loadSystemPrompt();

			// Check if running
			let running = await llamaService.checkStatus();

			if (!running) {
				// Wait for it to actually be ready
				let retries = 10;
				while (retries > 0) {
					await new Promise((r) => setTimeout(r, 1000));
					running = await llamaService.checkStatus();
					if (running) break;
					retries--;
				}

				if (!running) {
					throw new Error("Llama started but not reachable.");
				}
			}

			ollamaInitialized = true;
			checkReady();
		} catch (e) {
			console.error("Ollama init failed", e);
			initError = "Failed to connect to LLM. Is it installed?";
		}
	}

	function checkReady() {
		if (ollamaInitialized && kokoroInitialized) {
			// Add a small delay for better UX
			setTimeout(() => {
				isAppReady = true;
			}, 500);
		}
	}

	function toggleRecording() {
		if (!recognition) {
			alert("Speech recognition is not supported in this browser.");
			return;
		}
		if (isRecording) {
			recognition.stop();
		} else {
			isRecording = true;
			recognition.start();
		}
	}

	function stopSpeaking() {
		kokoroService.stop();
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
				kokoroService.speak(sentence, selectedVoice);
			}

			match = ttsBuffer.match(sentenceEndings);
		}

		if (force && ttsBuffer.trim()) {
			kokoroService.speak(ttsBuffer.trim(), selectedVoice);
			ttsBuffer = "";
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
		input = "";
		messages = [...messages, { role: "user", content: userMessage }];
		loading = true;
		stopSpeaking(); // Stop any previous speech
		await scrollToBottom();

		try {
			// Add a placeholder for the assistant response
			messages = [...messages, { role: "assistant", content: "" }];
			const lastMsgIndex = messages.length - 1;

			for await (const chunk of llamaService.chat(
				messages.slice(0, -1),
			)) {
				messages[lastMsgIndex].content += chunk;
				ttsBuffer += chunk;
				processTTSBuffer(); // Process as we go
				scrollToBottom();
			}

			loading = false;
			processTTSBuffer(true); // Process remaining buffer
		} catch (error) {
			console.error(error);
			messages = [
				...messages,
				{
					role: "assistant",
					content: "Error: Could not connect to LLM.",
				},
			];
		} finally {
			loading = false;
			scrollToBottom();
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			handleSubmit();
		}
	}
</script>

{#if !isAppReady}
	<div
		class="fixed inset-0 bg-gray-950 flex flex-col items-center justify-center z-50"
	>
		<div
			class="max-w-md w-full p-8 bg-gray-900 rounded-2xl border border-gray-800 shadow-2xl"
		>
			<div class="flex items-center justify-center mb-8">
				<div
					class="w-16 h-16 rounded-full bg-gradient-to-tr from-indigo-500 to-purple-500 flex items-center justify-center shadow-lg shadow-indigo-500/20 animate-pulse"
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						class="w-8 h-8 text-white"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M13 10V3L4 14h7v7l9-11h-7z"
						/>
					</svg>
				</div>
			</div>

			<h2 class="text-2xl font-bold text-center text-white mb-2">
				Initializing System
			</h2>
			<p class="text-gray-400 text-center mb-8 text-sm">
				Please wait while we prepare your local AI environment.
			</p>

			<div class="space-y-4">
				<!-- Ollama Status -->
				<div
					class="flex items-center gap-3 p-3 rounded-xl bg-gray-800/50 border border-gray-800"
				>
					<div
						class="relative flex items-center justify-center w-6 h-6"
					>
						{#if ollamaInitialized}
							<div
								class="absolute inset-0 bg-green-500 rounded-md opacity-20"
							></div>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								class="w-4 h-4 text-green-500"
								viewBox="0 0 20 20"
								fill="currentColor"
							>
								<path
									fill-rule="evenodd"
									d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
									clip-rule="evenodd"
								/>
							</svg>
						{:else}
							<div
								class="w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin"
							></div>
						{/if}
					</div>
					<span
						class="{ollamaInitialized
							? 'text-gray-200'
							: 'text-gray-400'} text-sm font-medium"
						>Starting Local LLM...</span
					>
				</div>

				<!-- Kokoro Status -->
				<div
					class="flex items-center gap-3 p-3 rounded-xl bg-gray-800/50 border border-gray-800"
				>
					<div
						class="relative flex items-center justify-center w-6 h-6"
					>
						{#if kokoroInitialized}
							<div
								class="absolute inset-0 bg-green-500 rounded-md opacity-20"
							></div>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								class="w-4 h-4 text-green-500"
								viewBox="0 0 20 20"
								fill="currentColor"
							>
								<path
									fill-rule="evenodd"
									d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
									clip-rule="evenodd"
								/>
							</svg>
						{:else}
							<div
								class="w-4 h-4 border-2 border-purple-500 border-t-transparent rounded-full animate-spin"
							></div>
						{/if}
					</div>
					<span
						class="{kokoroInitialized
							? 'text-gray-200'
							: 'text-gray-400'} text-sm font-medium"
						>Initializing Kokoro TTS...</span
					>
				</div>
			</div>

			{#if initError}
				<div
					class="mt-6 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm text-center"
				>
					{initError}
				</div>
			{/if}
		</div>
	</div>
{/if}

<div
	class="flex flex-col h-[calc(100vh-0px)] max-w-4xl mx-auto w-full p-4 {isAppReady
		? 'opacity-100'
		: 'opacity-0'} transition-opacity duration-500"
>
	<!-- Header -->
	<header
		class="flex items-center justify-between py-4 border-b border-gray-800 mb-4"
	>
		<div class="flex items-center gap-3">
			<div
				class="w-10 h-10 rounded-full bg-gradient-to-tr from-indigo-500 to-purple-500 flex items-center justify-center shadow-lg shadow-indigo-500/20"
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					class="w-6 h-6 text-white"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
					/>
				</svg>
			</div>
			<div>
				<h1
					class="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-indigo-400 to-purple-400"
				>
					Local LLM Chat
				</h1>
				<p class="text-xs text-gray-400">Powered by llama.cpp</p>
			</div>
		</div>
		<div class="flex items-center gap-3">
			<!-- Voice Selector -->
			<select
				bind:value={selectedVoice}
				onchange={handleVoiceChange}
				class="px-3 py-1 text-xs rounded-lg bg-gray-800 border border-gray-700 text-gray-300 focus:outline-none focus:border-indigo-500 hover:border-gray-600 transition-colors"
				aria-label="Select voice"
			>
				{#each voices as voice}
					<option value={voice.id}>
						{voice.name} ({voice.language})
					</option>
				{/each}
			</select>

			<button
				onclick={() => {
					isMuted = !isMuted;
					stopSpeaking();
				}}
				class="p-2 rounded-full hover:bg-gray-800 transition-colors text-gray-400"
				title={isMuted
					? "Unmute Text-to-Speech"
					: "Mute Text-to-Speech"}
			>
				{#if isMuted}
					<svg
						xmlns="http://www.w3.org/2000/svg"
						class="w-5 h-5"
						viewBox="0 0 20 20"
						fill="currentColor"
					>
						<path
							fill-rule="evenodd"
							d="M9.383 3.076A1 1 0 0110 4v12a1 1 0 01-1.707.707L4.586 13H2a1 1 0 01-1-1V8a1 1 0 011-1h2.586l3.707-3.707a1 1 0 011.09-.217zM12.293 7.293a1 1 0 011.414 0L15 8.586l1.293-1.293a1 1 0 111.414 1.414L16.414 10l1.293 1.293a1 1 0 01-1.414 1.414L15 11.414l-1.293 1.293a1 1 0 01-1.414-1.414L13.586 10l-1.293-1.293a1 1 0 010-1.414z"
							clip-rule="evenodd"
						/>
					</svg>
				{:else}
					<svg
						xmlns="http://www.w3.org/2000/svg"
						class="w-5 h-5"
						viewBox="0 0 20 20"
						fill="currentColor"
					>
						<path
							fill-rule="evenodd"
							d="M9.383 3.076A1 1 0 0110 4v12a1 1 0 01-1.707.707L4.586 13H2a1 1 0 01-1-1V8a1 1 0 011-1h2.586l3.707-3.707a1 1 0 011.09-.217zM14.657 2.929a1 1 0 011.414 0A9.972 9.972 0 0119 10a9.972 9.972 0 01-2.929 7.071 1 1 0 01-1.414-1.414A7.971 7.971 0 0017 10c0-2.21-.894-4.208-2.343-5.657a1 1 0 010-1.414zm-2.829 2.828a1 1 0 011.415 0A5.983 5.983 0 0115 10a5.984 5.984 0 01-1.757 4.243 1 1 0 01-1.415-1.415A3.984 3.984 0 0013 10a3.983 3.983 0 00-1.172-2.828 1 1 0 010-1.414z"
							clip-rule="evenodd"
						/>
					</svg>
				{/if}
			</button>
			<div
				class="text-xs px-3 py-1 rounded-full bg-gray-900 border border-gray-800 text-gray-400 flex items-center gap-2 transition-all duration-300 {isGeneratingAudio
					? 'bg-indigo-900/50 border-indigo-500/50 text-indigo-200'
					: ''}"
			>
				{#if isGeneratingAudio}
					<span
						class="w-2 h-2 rounded-full bg-indigo-400 animate-pulse shadow-[0_0_8px_rgba(129,140,248,0.8)]"
					></span>
					<span class="font-medium">Generating Audio...</span>
				{:else if loading}
					<span
						class="w-2 h-2 rounded-full bg-indigo-500 animate-pulse"
					></span>
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
			<div
				class="h-full flex flex-col items-center justify-center text-gray-500 opacity-50"
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					class="w-16 h-16 mb-4"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="1.5"
						d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
					/>
				</svg>
				<p>Start a conversation...</p>
			</div>
		{/if}

		{#each messages as msg}
			<div
				class="flex {msg.role === 'user'
					? 'justify-end'
					: 'justify-start'}"
			>
				<div
					class="max-w-[85%] rounded-2xl px-5 py-3 shadow-sm
					{msg.role === 'user'
						? 'bg-indigo-600 text-white rounded-br-none'
						: 'bg-gray-800 text-gray-200 rounded-bl-none border border-gray-700'}"
				>
					<div class="whitespace-pre-wrap leading-relaxed">
						{msg.content}
					</div>
				</div>
			</div>
		{/each}
	</div>

	<!-- Input Area -->
	<div class="mt-4 relative">
		<div
			class="relative rounded-2xl bg-gray-900 border border-gray-800 focus-within:border-indigo-500/50 focus-within:ring-1 focus-within:ring-indigo-500/50 transition-all shadow-lg flex items-end"
		>
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
					class="p-2 rounded-xl transition-all duration-200 {isRecording
						? 'bg-red-500/20 text-red-500 animate-pulse'
						: 'text-gray-400 hover:text-white hover:bg-gray-800'}"
					aria-label="Toggle voice input"
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						class="w-5 h-5"
						viewBox="0 0 20 20"
						fill="currentColor"
					>
						<path
							fill-rule="evenodd"
							d="M7 4a3 3 0 016 0v4a3 3 0 11-6 0V4zm4 10.93A7.001 7.001 0 0017 8a1 1 0 10-2 0A5 5 0 015 8a1 1 0 00-2 0 7.001 7.001 0 006 6.93V17H6a1 1 0 100 2h8a1 1 0 100-2h-3v-2.07z"
							clip-rule="evenodd"
						/>
					</svg>
				</button>

				<!-- Send Button -->
				<button
					onclick={handleSubmit}
					disabled={!input.trim() || loading}
					class="p-2 rounded-xl bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-50 disabled:hover:bg-indigo-600 transition-colors"
					aria-label="Send message"
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						class="w-5 h-5"
						viewBox="0 0 20 20"
						fill="currentColor"
					>
						<path
							d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z"
						/>
					</svg>
				</button>
			</div>
		</div>
		<div class="text-center mt-2">
			<p class="text-[10px] text-gray-600">
				AI can make mistakes. Check important info.
			</p>
		</div>
	</div>
</div>
