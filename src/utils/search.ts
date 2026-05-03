import { TFile } from 'obsidian';
import { extractTags } from './markdown';

export interface SearchState {
	query: string;
	filterTag: string | null;
	filterPinned: 'all' | 'pinned' | 'unpinned';
	filterColors: string[];
	filterFolder: string | null;
	filterOperators: Map<string, string>;
}

export interface SearchSuggestion {
	type: 'operator' | 'tag' | 'color' | 'typeValue' | 'folder';
	value: string;
	display: string;
}

export function parseSearchOperators(query: string): Omit<SearchState, 'query'> {
	const filterOperators = new Map<string, string>();
	const filterColors: string[] = [];
	let filterTag: string | null = null;
	let filterPinned: 'all' | 'pinned' | 'unpinned' = 'all';
	let filterFolder: string | null = null;

	// Parse operators: tag:name, color:red, is:pinned, type:empty, folder:path, etc.
	// Support both quoted values (folder:"My Folder") and unquoted with spaces (folder:My Folder)
	const operatorRegex = /(tag|color|is|type|folder|path):(?:"([^"]+)"|(.+?))(?=\s+(?:tag|color|is|type|folder|path):|$)/gi;
	let match;

	while ((match = operatorRegex.exec(query)) !== null) {
		const operator = match[1]?.toLowerCase();
		// Value is either quoted (group 2) or unquoted (group 3)
		const value = (match[2] || match[3])?.trim().toLowerCase();

		if (!operator || !value) continue;

		if (operator === 'tag') {
			filterTag = value;
		} else if (operator === 'color') {
			filterColors.push(value);
		} else if (operator === 'folder' || operator === 'path') {
			filterFolder = value;
		} else if (operator === 'is') {
			if (value === 'pinned') {
				filterPinned = 'pinned';
			} else if (value === 'unpinned') {
				filterPinned = 'unpinned';
			}
		} else if (operator === 'type') {
			filterOperators.set(operator, value);
		}
	}

	return { filterTag, filterPinned, filterColors, filterFolder, filterOperators };
}

export function getSearchSuggestions(query: string, allTags: string[], allFolders: string[] = [], noteColors: Record<string, string> = {}): SearchSuggestion[] {
	const suggestions: SearchSuggestion[] = [];
	const lastWord = query.split(' ').pop() || '';

	// Show initial view when query is empty
	if (query.trim().length === 0) {
		const operators = ['folder:', 'tag:', 'color:', 'type:', 'is:pinned', 'is:unpinned'];
		operators.forEach(op => {
			suggestions.push({ type: 'operator', value: op, display: op });
		});
		return suggestions;
	}

	// Show operator suggestions
	if (!lastWord.includes(':')) {
		const operators = ['folder:', 'tag:', 'color:', 'type:', 'is:pinned', 'is:unpinned'];
		const matchingOps = operators.filter(op => op.startsWith(lastWord.toLowerCase()));

		if (matchingOps.length > 0 && lastWord.length > 0) {
			matchingOps.forEach(op => {
				suggestions.push({ type: 'operator', value: op, display: op });
			});
			return suggestions;
		}
	}

	// Show tag suggestions when typing tag:
	if (lastWord.startsWith('tag:')) {
		const tagPrefix = lastWord.substring(4).toLowerCase();
		const matchingTags = allTags.filter(tag => tag.toLowerCase().includes(tagPrefix));

		if (matchingTags.length > 0) {
			matchingTags.slice(0, 8).forEach(tag => {
				suggestions.push({ type: 'tag', value: `tag:${tag}`, display: `tag:${tag}` });
			});
			return suggestions;
		}
	}

	// Show color suggestions when typing color:
	if (lastWord.startsWith('color:')) {
		// Extract unique colors from noteColors
		const colorMap: Record<string, string> = {
			'pastel-peach': 'Peach',
			'pastel-yellow': 'Yellow',
			'pastel-green': 'Green',
			'pastel-blue': 'Blue',
			'pastel-purple': 'Purple',
			'pastel-magenta': 'Pink'
		};
		
		// Map display names to search keys
		const displayToSearchKey: Record<string, string> = {
			'Peach': 'peach',
			'Yellow': 'yellow',
			'Green': 'green',
			'Blue': 'blue',
			'Purple': 'purple',
			'Pink': 'pink'
		};
		
		const usedColors = new Set<string>();
		Object.values(noteColors).forEach(colorValue => {
			for (const [key, displayName] of Object.entries(colorMap)) {
				if (colorValue.includes(key)) {
					usedColors.add(key);
				}
			}
		});
		
		const colorPrefix = lastWord.substring(6).toLowerCase();
		const availableColors: Array<{key: string, display: string, value: string}> = [];
		
		// Add used colors
		for (const [key, displayName] of Object.entries(colorMap)) {
			if (usedColors.has(key)) {
				const searchKey = displayToSearchKey[displayName] || key.replace('pastel-', '');
				if (displayName.toLowerCase().startsWith(colorPrefix) || searchKey.startsWith(colorPrefix)) {
					availableColors.push({
						key: searchKey,
						display: displayName,
						value: `color:${searchKey}`
					});
				}
			}
		}
		
		// Add "No color" option if it matches
		if ('no color'.includes(colorPrefix) || 'gray'.startsWith(colorPrefix) || colorPrefix === '') {
			availableColors.push({
				key: 'gray',
				display: 'No color',
				value: 'color:gray'
			});
		}
		
		if (availableColors.length > 0) {
			availableColors.forEach(color => {
				suggestions.push({ type: 'color', value: color.value, display: color.display });
			});
			return suggestions;
		}
	}

	// Show type suggestions when typing type:
	if (lastWord.startsWith('type:')) {
		const types = ['empty', 'image', 'pdf', 'link', 'list', 'code', 'table'];
		const typePrefix = lastWord.substring(5).toLowerCase();
		const matchingTypes = types.filter(t => t.startsWith(typePrefix));

		if (matchingTypes.length > 0) {
			matchingTypes.forEach(type => {
				suggestions.push({ type: 'typeValue', value: `type:${type}`, display: `type:${type}` });
			});
			return suggestions;
		}
	}

	// Show folder suggestions when typing folder: or path:
	if (lastWord.startsWith('folder:') || lastWord.startsWith('path:')) {
		const prefix = lastWord.startsWith('folder:') ? 'folder:' : 'path:';
		const folderPrefix = lastWord.substring(prefix.length).toLowerCase();
		const matchingFolders = allFolders.filter(folder => folder.toLowerCase().includes(folderPrefix));

		if (matchingFolders.length > 0) {
			matchingFolders.slice(0, 8).forEach(folder => {
				const displayFolder = folder === '/' ? '/' : folder;
				suggestions.push({ type: 'folder', value: `folder:${folder}`, display: `folder:${displayFolder}` });
			});
			return suggestions;
		}
	}

	return suggestions;
}

export function getCleanQuery(query: string): string {
	return query
		.replace(/(tag|color|is|type|folder|path):(?:"[^"]+"|.+?)(?=\s+(?:tag|color|is|type|folder|path):|$)/gi, '')
		.trim()
		.toLowerCase();
}

export function isSimpleTextSearch(query: string): boolean {
	const hasOperators = /(tag|color|is|type|folder|path):/i.test(query);
	return !hasOperators && query.trim().length > 0;
}

export function highlightSearchTerms(element: HTMLElement, searchTerm: string): void {
	if (!searchTerm || searchTerm.trim().length === 0) return;
	
	const term = searchTerm.trim();
	const walker = document.createTreeWalker(
		element,
		NodeFilter.SHOW_TEXT,
		null
	);
	
	const textNodes: Text[] = [];
	let node: Node | null;
	
	// Collect all text nodes
	while ((node = walker.nextNode())) {
		textNodes.push(node as Text);
	}
	
	// Process each text node
	textNodes.forEach(textNode => {
		const text = textNode.textContent || '';
		const lowerText = text.toLowerCase();
		const lowerTerm = term.toLowerCase();
		const index = lowerText.indexOf(lowerTerm);
		
		if (index !== -1) {
			const parent = textNode.parentNode;
			if (!parent) return;
			
			// Skip if already highlighted or in certain elements
			if (parent.nodeName === 'MARK' || parent.nodeName === 'CODE' || parent.nodeName === 'PRE') {
				return;
			}
			
			// Create highlighted version
			const before = text.substring(0, index);
			const match = text.substring(index, index + term.length);
			const after = text.substring(index + term.length);
			
			const fragment = document.createDocumentFragment();
			
			if (before) fragment.appendChild(document.createTextNode(before));
			
			const mark = document.createElement('mark');
			mark.className = 'search-highlight';
			mark.textContent = match;
			fragment.appendChild(mark);
			
			if (after) {
				// Recursively highlight remaining text
				const afterNode = document.createTextNode(after);
				fragment.appendChild(afterNode);
			}
			
			parent.replaceChild(fragment, textNode);
		}
	});
}

export function filterFiles(
	files: TFile[],
	fileContents: Map<string, string>,
	searchState: SearchState,
	isPinned: (path: string) => boolean,
	getNoteColor: (path: string) => string | undefined
): TFile[] {
	let filtered = [...files];

	// Apply pinned filter
	if (searchState.filterPinned === 'pinned') {
		filtered = filtered.filter(f => isPinned(f.path));
	} else if (searchState.filterPinned === 'unpinned') {
		filtered = filtered.filter(f => !isPinned(f.path));
	}

	// Apply tag filter
	if (searchState.filterTag) {
		filtered = filtered.filter(f => {
			const content = fileContents.get(f.path) || '';
			const tags = extractTags(content);
			return tags.includes(searchState.filterTag!);
		});
	}

	// Apply folder filter
	if (searchState.filterFolder) {
		const folderPath = searchState.filterFolder === '/' ? '' : searchState.filterFolder;
		filtered = filtered.filter(f => {
			if (folderPath === '') return true; // All files if root
			return f.path.toLowerCase().startsWith(folderPath);
		});
	}

	// Apply color filter
	if (searchState.filterColors.length > 0) {
		filtered = filtered.filter(f => {
			const savedColor = getNoteColor(f.path);

			const colorMatch = searchState.filterColors.some(filterColor => {
				// Special case: gray means no color
				if (filterColor === 'gray') {
					return !savedColor;
				}
				
				if (!savedColor) return false;

				const colorMap: Record<string, string> = {
					'pink': 'pastel-magenta',
					'peach': 'pastel-peach',
					'yellow': 'pastel-yellow',
					'green': 'pastel-green',
					'blue': 'pastel-blue',
					'purple': 'pastel-purple'
				};
				const expectedColor = colorMap[filterColor];
				if (!expectedColor) return false;
				return savedColor.includes(expectedColor);
			});

			return colorMatch;
		});
	}

	// Apply search filter with operators + relevance scoring
	if (searchState.query) {
		const cleanQuery = getCleanQuery(searchState.query);

		const scored: Array<{ file: TFile; score: number }> = [];

		for (const f of filtered) {
			const content = fileContents.get(f.path) || '';
			const tags = extractTags(content);

			// Check has: operators
			if (searchState.filterOperators.has('has')) {
				const hasValue = searchState.filterOperators.get('has');
				if (hasValue === 'tags' && tags.length === 0) continue;
				if (hasValue === 'content' && content.trim().length === 0) continue;
			}

			// Check type: operators
			if (searchState.filterOperators.has('type')) {
				const typeValue = searchState.filterOperators.get('type');

				let typeMatch = true;
				switch (typeValue) {
					case 'empty':
						if (content.trim().length > 0) typeMatch = false;
						break;
					case 'image':
						if (!content.match(/!\[.*?\]\([^)]*\.(png|jpg|jpeg|gif|bmp|svg|webp)[^)]*\)|!\[\[[^\]]*\.(png|jpg|jpeg|gif|bmp|svg|webp)[^\]]*\]\]/i)) typeMatch = false;
						break;
					case 'pdf':
						if (!content.match(/!?\[.*?\]\([^)]*\.pdf[^)]*\)|!?\[\[[^\]]*\.pdf[^\]]*\]\]/i)) typeMatch = false;
						break;
					case 'link': {
						const linkPattern = new RegExp(
							'(?<!!)\\[.*?\\]\\((?![^)]*\\.(png|jpg|jpeg|gif|bmp|svg|webp|pdf)\\b)[^)]+\\)|' +
							'(?<!!)\\[\\[(?![^\\]]*\\.(png|jpg|jpeg|gif|bmp|svg|webp|pdf)\\b)[^\\]]+\\]\\]',
							'i'
						);
						if (!content.match(linkPattern)) typeMatch = false;
						break;
					}
					case 'list':
						if (!content.match(/^\s*[-*+]\s|^\s*\d+\.\s/m)) typeMatch = false;
						break;
					case 'code':
						if (!content.match(/```[\s\S]*?```|`[^`|]+`/)) typeMatch = false;
						break;
					case 'table':
						if (!content.match(/\|[^\n]*\|\n\|[\s:|-]+\|/)) typeMatch = false;
						break;
				}
				if (!typeMatch) continue;
			}

			// Text search with relevance scoring
			if (cleanQuery) {
				const titleLower = f.basename.toLowerCase();
				const contentLower = content.toLowerCase();
				const inTitle = titleLower.includes(cleanQuery);
				const inContent = contentLower.includes(cleanQuery);

				if (!inTitle && !inContent) continue;

				let score = 0;

				// Title matches (high value)
				if (titleLower === cleanQuery) {
					score += 100; // Exact title match
				} else if (titleLower.startsWith(cleanQuery)) {
					score += 80; // Title starts with query
				} else if (inTitle) {
					score += 50; // Title contains query
				}

				// Tag matches
				const tagMatch = tags.some(t => t.toLowerCase().includes(cleanQuery));
				if (tagMatch) {
					score += 30;
				}

				// Content matches — count occurrences, cap contribution
				if (inContent) {
					const occurrences = contentLower.split(cleanQuery).length - 1;
					score += Math.min(occurrences * 3, 20); // Up to 20 pts for body matches
				}

				// Recency bonus — more recent files get slight boost
				const ageHours = (Date.now() - f.stat.mtime) / 3600000;
				if (ageHours < 24) score += 10;
				else if (ageHours < 168) score += 5; // Within a week

				scored.push({ file: f, score });
			} else {
				// No text query — operator-only search, keep original order
				scored.push({ file: f, score: 0 });
			}
		}

		// Sort by relevance score (highest first), then by mtime for ties
		scored.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score;
			return b.file.stat.mtime - a.file.stat.mtime;
		});

		filtered = scored.map(s => s.file);
	}

	return filtered;
}
