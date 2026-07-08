import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			// adapter-node : `npm run build` produit un serveur Node autonome
			// dans build/, lançable avec `node build`.
			// See https://svelte.dev/docs/kit/adapter-node for more information.
			adapter: adapter()
		})
	]
});
