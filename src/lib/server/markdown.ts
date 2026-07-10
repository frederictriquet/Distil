// Canonical Markdown rendering for Distil card bodies (roadmap section 7).
//
// This module is the single place that turns a card's raw Markdown body
// (cards.content) into safe HTML for display. It does three things:
//
//   - 7.1: render Markdown to HTML with syntax-highlighted code blocks
//     (marked + marked-highlight + highlight.js), and sanitize the result with
//     DOMPurify so no card body can ever inject active content (script tags,
//     event-handler attributes, javascript: URLs, …). Sanitization is
//     mandatory and happens on every path, including the empty-body path.
//
//   - 7.2: rewrite internal links between cards. A relative Markdown link to
//     another `.md` file of the same knowledge base (e.g. `chunking.md` or
//     `../concepts/foo.md`) is resolved against the current card's source path
//     inside the KB's content sub-directory and rewritten to the in-app card
//     route `/card/<kbId>/<resolved-path>` (the target page is built later in
//     roadmap section 10). Anchors (`#section`) and query strings are kept.
//
//   - External links (http/https) are left intact and made safe to open in a
//     new tab (`target="_blank"` + `rel="noopener noreferrer"`). Relative
//     `.md` links that resolve outside the KB (or that cannot be resolved,
//     e.g. the card has no source path) are not turned into a card route:
//     rendering them as a live `/card/...` link would be a silently dead link,
//     so they are emitted as marked, non-navigable text instead.
//
// Like the other `$lib/server` modules it is free of SvelteKit imports and
// takes all context explicitly, so it stays unit-testable outside a running
// server.

import { Marked, type Renderer, type RendererObject, type Tokens } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js';
import DOMPurify from 'isomorphic-dompurify';

/**
 * The knowledge-base context needed to resolve a card's relative internal
 * links to in-app card routes. `sourcePath` is the current card's repo-relative
 * markdown path (cards.source_path) and `contentSubdir` is its KB's content
 * sub-directory (knowledge_bases.content_subdir); together they locate the card
 * inside the KB so `./` and `../` links can be normalised.
 */
export interface CardRenderContext {
	/** Owning knowledge base id, used to build the `/card/<kbId>/...` route. */
	kbId: number;
	/** Repo-relative path of the current card's markdown file (may be null). */
	sourcePath: string | null;
	/** KB content sub-directory the cards live under (may be empty). */
	contentSubdir: string;
}

/** A single Marked instance carrying the (context-free) highlight extension. */
const highlighter = markedHighlight({
	langPrefix: 'hljs language-',
	highlight(code: string, lang: string): string {
		const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
		return hljs.highlight(code, { language }).value;
	}
});

/** Escape a string for safe inclusion inside a double-quoted HTML attribute. */
function escapeAttribute(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/** True for links carrying an explicit scheme or protocol-relative authority. */
function isExternalHref(href: string): boolean {
	return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//');
}

/** The posix directory of a posix path (`a/b/c.md` -> `a/b`, `c.md` -> ``). */
function posixDirname(path: string): string {
	const idx = path.lastIndexOf('/');
	return idx === -1 ? '' : path.slice(0, idx);
}

/**
 * Resolve a relative posix `target` against `baseDir`, collapsing `.`/`..`.
 * Returns the resolved segments, or `null` if the path escapes above the root
 * (a leading `..` that cannot be consumed) — i.e. points outside the tree.
 */
function resolveSegments(baseDir: string, target: string): string[] | null {
	const segments = baseDir ? baseDir.split('/').filter(Boolean) : [];
	for (const part of target.split('/')) {
		if (part === '' || part === '.') {
			continue;
		}
		if (part === '..') {
			if (segments.length === 0) {
				return null;
			}
			segments.pop();
			continue;
		}
		segments.push(part);
	}
	return segments;
}

/**
 * Strip the `contentSubdir` prefix from repo-relative `segments`, returning the
 * content-root-relative segments, or `null` when the path lies outside the
 * content sub-directory (and therefore outside the KB's card space).
 */
function stripContentSubdir(segments: string[], contentSubdir: string): string[] | null {
	const prefix = contentSubdir ? contentSubdir.split('/').filter((s) => s && s !== '.') : [];
	if (segments.length < prefix.length) {
		return null;
	}
	for (let i = 0; i < prefix.length; i += 1) {
		if (segments[i] !== prefix[i]) {
			return null;
		}
	}
	return segments.slice(prefix.length);
}

/**
 * Resolve a relative Markdown link to an in-app card route (task 7.2), or
 * return `null` when it is not a rewritable internal card link: it must be a
 * relative link to a `.md` file that resolves to a card inside the same KB. The
 * anchor (`#section`) and query string, if any, are preserved on the rewritten
 * URL.
 */
function resolveInternalHref(href: string, context: CardRenderContext): string | null {
	// Split the path part off any query string / fragment so they survive.
	const suffixMatch = href.search(/[?#]/);
	const pathPart = suffixMatch === -1 ? href : href.slice(0, suffixMatch);
	const suffix = suffixMatch === -1 ? '' : href.slice(suffixMatch);

	// Only relative `.md` links are internal card links. Absolute-path links
	// (`/foo.md`) and non-`.md` targets are left to the caller untouched.
	if (pathPart.length === 0 || pathPart.startsWith('/') || !/\.md$/i.test(pathPart)) {
		return null;
	}
	// Without a source path the current card cannot anchor a relative resolve.
	if (context.sourcePath === null || context.sourcePath.length === 0) {
		return null;
	}

	const resolved = resolveSegments(posixDirname(context.sourcePath), pathPart);
	if (resolved === null) {
		return null;
	}
	const withinContent = stripContentSubdir(resolved, context.contentSubdir);
	if (withinContent === null || withinContent.length === 0) {
		return null;
	}

	// Drop the `.md` suffix to match the stored card slug, and percent-encode
	// each segment so odd filenames still produce a valid URL path.
	const slug = withinContent.join('/').replace(/\.md$/i, '');
	const encoded = slug
		.split('/')
		.map((segment) => encodeURIComponent(segment))
		.join('/');
	return `/card/${context.kbId}/${encoded}${suffix}`;
}

/**
 * Build a marked link renderer bound to a card's KB context. Internal `.md`
 * links become `/card/...` routes, external links open safely in a new tab, and
 * links that cannot be resolved to a card are emitted as non-navigable marked
 * text rather than a silently dead link.
 */
function buildLinkRenderer(context: CardRenderContext): RendererObject['link'] {
	return function link(this: Renderer, token: Tokens.Link): string {
		// `this` is marked's Renderer, exposing the parser for inline content.
		const text = this.parser.parseInline(token.tokens);
		const href = (token.href ?? '').trim();
		const titleAttr = token.title ? ` title="${escapeAttribute(token.title)}"` : '';

		if (isExternalHref(href)) {
			return `<a href="${escapeAttribute(href)}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
		}

		// In-page anchors and non-`.md` / absolute-path links pass through as-is.
		if (href.startsWith('#') || !/\.md(?:[?#]|$)/i.test(href) || href.startsWith('/')) {
			return `<a href="${escapeAttribute(href)}"${titleAttr}>${text}</a>`;
		}

		const internal = resolveInternalHref(href, context);
		if (internal !== null) {
			return `<a href="${escapeAttribute(internal)}"${titleAttr}>${text}</a>`;
		}

		// A relative `.md` link that resolves outside the KB (or is unresolvable):
		// mark it plainly instead of emitting a dead `/card/...` link.
		return `<span class="broken-link" title="Unresolved link: ${escapeAttribute(href)}">${text}</span>`;
	};
}

/**
 * Render a card's Markdown body to sanitized HTML (roadmap section 7).
 *
 * Code blocks are syntax-highlighted (7.1) and relative internal links are
 * rewritten to in-app card routes (7.2). The produced HTML always passes
 * through DOMPurify before being returned, so hostile card content (script
 * tags, `onerror=` handlers, `javascript:` URLs, …) can never reach the client.
 * An empty/absent body yields an empty string.
 */
export function renderCardMarkdown(
	content: string | null | undefined,
	context: CardRenderContext
): string {
	if (!content) {
		return '';
	}

	const marked = new Marked(highlighter, {
		renderer: { link: buildLinkRenderer(context) }
	});
	const rawHtml = marked.parse(content, { async: false }) as string;

	return DOMPurify.sanitize(rawHtml, {
		// Keep the syntax-highlighting classes and the safe link attributes the
		// renderer emits; forbid anything that could execute.
		ADD_ATTR: ['target'],
		FORBID_TAGS: ['style'],
		FORBID_ATTR: ['style']
	});
}
