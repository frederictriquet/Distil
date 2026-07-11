import { json } from '@sveltejs/kit';
import { APP_VERSION } from '$lib/version';

// Simple version access point (roadmap task 13.5): exposes the build-time
// version string so it can be consumed programmatically.
export function GET() {
	return json({ version: APP_VERSION });
}
