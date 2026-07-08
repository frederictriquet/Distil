import adapter from '@sveltejs/adapter-node';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},

	kit: {
		// adapter-node: `npm run build` produces a standalone Node server in build/,
		// runnable with `node build`.
		// See https://svelte.dev/docs/kit/adapter-node for more information.
		adapter: adapter()
	}
};

export default config;
