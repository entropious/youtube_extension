/**
 * Utility functions for YouTube extension.
 */

export type HistoryEntry = {
	url: string;
	title?: string;
};

/**
 * Extracts a 11-character video ID from various YouTube URL formats.
 */
export function extractVideoId(urlStr: string): string | undefined {
	try {
		const parsed = new URL(urlStr);
		const host = parsed.hostname.replace(/^www\./, '');
		if (host === 'youtu.be') return parsed.pathname.split('/').filter(Boolean)[0];
		if (host === 'youtube.com' || host === 'm.youtube.com') {
			if (parsed.pathname === '/watch') return parsed.searchParams.get('v') || undefined;
			if (parsed.pathname.startsWith('/shorts/')) return parsed.pathname.split('/').filter(Boolean)[1];
			if (parsed.pathname.startsWith('/embed/')) return parsed.pathname.split('/').filter(Boolean)[1];
			// Also check for v= in other pages if applicable
			const v = parsed.searchParams.get('v');
			if (v) return v;
		}
	} catch {
		const match = urlStr.match(/[a-zA-Z0-9_-]{11}/);
		if (match) return match[0];
	}
	return undefined;
}

/**
 * Extracts a playlist ID from YouTube URL formats.
 */
export function extractPlaylistId(urlStr: string): string | undefined {
	try {
		const parsed = new URL(urlStr);
		return parsed.searchParams.get('list') || undefined;
	} catch {
		return undefined;
	}
}

/**
 * Formats a given URL into a YouTube embed URL suitable for the player.
 */
export function formatYoutubeUrl(url: string, startTime = 0, autoplay = true, proxyPort = 0): string {
	const toEmbed = (id: string): string => {
		const startParam = startTime > 0 ? `&start=${startTime}` : '';
		const autoplayParam = autoplay ? '&autoplay=1' : '&autoplay=0';
		if (proxyPort) {
			return `http://127.0.0.1:${proxyPort}/embed?v=${id}${startParam}${autoplayParam}`;
		}

		return `https://www.youtube.com/embed/${id}?rel=0&modestbranding=1&playsinline=1&enablejsapi=1${autoplayParam}${startParam}`;
	};

	try {
		const parsed = new URL(url);
		const host = parsed.hostname.replace(/^www\./, '');

		if (host === 'youtu.be') {
			const id = parsed.pathname.split('/').filter(Boolean)[0];
			return id ? toEmbed(id) : url;
		}

		if (host === 'youtube.com' || host === 'm.youtube.com') {
			if (parsed.pathname === '/watch') {
				const id = parsed.searchParams.get('v');
				return id ? toEmbed(id) : url;
			}

			if (parsed.pathname.startsWith('/shorts/')) {
				const id = parsed.pathname.split('/').filter(Boolean)[1];
				return id ? toEmbed(id) : url;
			}

			if (parsed.pathname.startsWith('/embed/')) {
				const id = parsed.pathname.split('/').filter(Boolean)[1];
				return id ? toEmbed(id) : url;
			}
		}
	} catch {
		// Keep original URL if parsing fails.
	}

	return url;
}

/**
 * Parses raw data from persistence into HistoryEntry objects.
 */
export function parseEntries(raw: unknown[]): HistoryEntry[] {
	return raw
		.map((item): HistoryEntry | null => {
			if (typeof item === 'string') {
				return { url: item };
			}

			if (item && typeof item === 'object' && 'url' in item && typeof (item as { url: unknown }).url === 'string') {
				const maybeTitle = (item as { title?: unknown }).title;
				return {
					url: (item as { url: string }).url,
					title: typeof maybeTitle === 'string' ? maybeTitle : undefined
				};
			}

			return null;
		})
		.filter((entry): entry is HistoryEntry => Boolean(entry));
}
