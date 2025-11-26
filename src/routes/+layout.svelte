<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	
	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<div class="min-h-screen bg-gray-950 text-gray-100 flex flex-col font-sans antialiased selection:bg-indigo-500 selection:text-white">
	{@render children()}
</div>
