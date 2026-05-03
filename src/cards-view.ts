import { ItemView, TFile, TFolder, WorkspaceLeaf, setIcon, MarkdownRenderer, Platform } from 'obsidian';
import type VisualDashboardPlugin from './main';
import { VIEW_TYPE_VISUAL_DASHBOARD } from './utils/types';
import { extractTags, getPreviewText, stripMarkdown } from './utils/markdown';
import { formatDate } from './utils/date';
import { parseSearchOperators, getSearchSuggestions, filterFiles, isSimpleTextSearch, highlightSearchTerms, getCleanQuery, type SearchState } from './utils/search';
import { FILE_FETCH_MULTIPLIER, DEBOUNCE_REFRESH_MS, MAX_PREVIEW_LENGTH, CARD_SIZE, MAX_CARD_HEIGHT } from './utils/constants';

export class VisualDashboardView extends ItemView {
	private miniNotesGrid!: HTMLElement;
	private plugin: VisualDashboardPlugin;
	private draggedCard: HTMLElement | null = null;
	private dragOverTargetCard: HTMLElement | null = null;
	private pendingDragTargetCard: HTMLElement | null = null;
	private pendingDragClientY: number | null = null;
	private dragFrameId: number | null = null;
	private currentFiles: TFile[] = [];
	private settingsChangedHandler: () => void;
	private refreshTimeoutId: number | null = null;
	private eventsRegistered = false;

	// Filter state
	private filterPinned: 'all' | 'pinned' | 'unpinned' = 'all';
	private filterTag: string | null = null;
	private filterFolder: string | null = null;
	private filterSearch: string = '';
	private allTags: string[] = [];
	private allFolders: string[] = [];
	private filterColors: string[] = [];
	private filterOperators: Map<string, string> = new Map();
	private searchSuggestionsEl: HTMLElement | null = null;
	private selectedSuggestionIndex: number = -1;
	private currentSuggestions: Array<{ type: string; value: string; display: string }> = [];
	private currentSuggestionQuery: string = '';
	
	// Undo state
	private deletedNotesStack: { path: string; content: string }[] = [];
	private activeColorDropdown: HTMLElement | null = null;
	private undoToastEl: HTMLElement | null = null;
	private undoToastTimeoutId: number | null = null;

	// Progressive rendering state
	private pendingRichRenders: number[] = [];
	private fileContentsCache: Map<string, string> = new Map();
	private fileMtimeCache: Map<string, number> = new Map();
	private fileTagsCache: Map<string, string[]> = new Map();
	private cardObserver: IntersectionObserver | null = null;

	// Drawer state
	private drawerEl: HTMLElement | null = null;
	private scrimEl: HTMLElement | null = null;
	private drawerOpen = false;
	private activeFilterFolder: string | null = null;
	private navigatedFolder: string | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: VisualDashboardPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.settingsChangedHandler = () => {
			void this.refreshView();
		};
	}

	getViewType(): string {
		return VIEW_TYPE_VISUAL_DASHBOARD;
	}

	getDisplayText(): string {
		return 'Mini notes';
	}

	getIcon(): string {
		return 'dashboard-grid';
	}

	async onOpen() {
		const container = this.contentEl;
		container.empty();
		container.addClass('visual-dashboard-container');

		// Apply theme color
		this.applyThemeColor();

		// Create header - single row
		const header = this.contentEl.createDiv({ cls: 'dashboard-header' });

		// Title
		const title = header.createEl('h1', { text: this.plugin.data.viewTitle || 'Do Your Best Today!', cls: 'dashboard-title editable-title' });
		title.setAttribute('contenteditable', 'true');
		title.setAttribute('spellcheck', 'false');
		
		// Save title on blur
		title.addEventListener('blur', () => {
			const newTitle = title.textContent?.trim() || 'Do Your Best Today!';
			this.plugin.data.viewTitle = newTitle;
			void this.plugin.savePluginData();
		});
		
		// Save title on Enter key
		title.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				title.blur();
			}
		});
		
		// Reload on double-click
		title.addEventListener('dblclick', () => {
			void this.renderCards();
		});

		// Controls on right
		const controls = header.createDiv({ cls: 'header-controls' });

		// Hamburger menu button (left of search)
		const hamburgerBtn = controls.createEl('button', { cls: 'drawer-hamburger', attr: { 'aria-label': 'Open folder drawer' } });
		setIcon(hamburgerBtn, 'menu');
		hamburgerBtn.addEventListener('click', () => this.toggleDrawer());

		// Search bar with autocomplete
		const searchContainer = controls.createDiv({ cls: 'search-container' });
		const searchWrapper = searchContainer.createDiv({ cls: 'search-wrapper' });
		const searchIcon = searchWrapper.createDiv({ cls: 'search-icon' });
		setIcon(searchIcon, 'search');
		
		const searchInput = searchWrapper.createEl('input', {
			type: 'text',
			placeholder: 'Search notes (try folder:, tag:, color:, type:, is:pinned)',
			cls: 'search-input',
			attr: { 'aria-label': 'Search notes' }
		});
		
		searchInput.value = this.filterSearch;
		
		// Clear button
		const clearBtn = searchWrapper.createEl('button', { cls: 'search-clear-btn', attr: { 'aria-label': 'Clear search' } });
		setIcon(clearBtn, 'x');
		clearBtn.style.display = this.filterSearch ? 'flex' : 'none';
		
		clearBtn.addEventListener('click', () => {
			searchInput.value = '';
			this.filterSearch = '';
			clearBtn.style.display = 'none';
			this.clearAllFilters();
			void this.renderCards();
		});
		
		// Focus search on icon click
		searchIcon.addEventListener('click', () => {
			searchInput.focus();
		});
		
		// Autocomplete suggestions dropdown
		this.searchSuggestionsEl = searchContainer.createDiv({ cls: 'search-suggestions' });
		
		// Show initial suggestions on focus
		searchInput.addEventListener('focus', () => {
			if (!searchInput.value) {
				this.updateSearchSuggestions('');
			}
		});
		
		// Event listeners for search
		searchInput.addEventListener('input', (e) => {
			const target = e.target as HTMLInputElement;
			this.filterSearch = target.value;
			clearBtn.style.display = target.value ? 'flex' : 'none';
			
			// Show suggestions
			this.updateSearchSuggestions(target.value);
			
			// Parse operators and use debounced refresh
			this.updateSearchState(target.value);
			this.debouncedRefresh();
		});
		
		// Close suggestions on blur
		searchInput.addEventListener('blur', () => {
			setTimeout(() => {
				if (this.searchSuggestionsEl) {
					this.searchSuggestionsEl.empty();
					this.searchSuggestionsEl.removeClass('show');
				}
			}, 200);
		});
		
		// Handle keyboard navigation in suggestions
		searchInput.addEventListener('keydown', (e: KeyboardEvent) => {
			if (!this.searchSuggestionsEl || !this.searchSuggestionsEl.hasClass('show')) {
				return;
			}
			
			const suggestions = this.searchSuggestionsEl.querySelectorAll('.search-suggestion-item');
			if (suggestions.length === 0) return;
			
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				this.selectedSuggestionIndex = Math.min(this.selectedSuggestionIndex + 1, suggestions.length - 1);
				this.highlightSuggestion(suggestions);
			} else if (e.key === 'ArrowUp') {
				e.preventDefault();
				this.selectedSuggestionIndex = Math.max(this.selectedSuggestionIndex - 1, 0);
				this.highlightSuggestion(suggestions);
			} else if (e.key === 'Enter' && this.selectedSuggestionIndex >= 0) {
				e.preventDefault();
				const selectedSuggestion = this.currentSuggestions[this.selectedSuggestionIndex];
				if (selectedSuggestion) {
					this.applySuggestion(this.currentSuggestionQuery, selectedSuggestion);
				}
			} else if (e.key === 'Escape') {
				this.searchSuggestionsEl.empty();
				this.searchSuggestionsEl.removeClass('show');
				this.selectedSuggestionIndex = -1;
			}
		});

		// Create new note button
		const createBtn = controls.createEl('button', { cls: 'create-note-btn', attr: { 'aria-label': 'Create new mini note' } });
		setIcon(createBtn, 'plus');
		createBtn.addEventListener('click', async () => {
			await this.plugin.createMiniNote();
		});

		// Breadcrumb bar (visible when navigated into a folder)
		this.contentEl.createDiv({ cls: 'breadcrumb-bar', attr: { style: 'display:none' } });

		// Scrim overlay
		this.scrimEl = this.contentEl.createDiv({ cls: 'drawer-scrim' });
		this.scrimEl.addEventListener('click', () => this.toggleDrawer(false));

		// Drawer
		this.drawerEl = this.contentEl.createDiv({ cls: 'folder-drawer' });

		// Create mini notes grid container
		this.miniNotesGrid = this.contentEl.createDiv({ cls: 'mini-notes-grid' });

		// Render the cards
		await this.renderCards();

		// Register event listeners only once
		if (!this.eventsRegistered) {
			this.setupEventListeners();
			this.eventsRegistered = true;
		}
	}

	private setupEventListeners() {
		// Listen for settings changes using workspace event
		this.registerEvent(
			// @ts-ignore - Custom event type
			this.app.workspace.on('mini-notes:settings-changed', this.settingsChangedHandler)
		);

		// Listen for file changes — invalidate cache + debounced refresh
		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				this.fileMtimeCache.delete(file.path);
				this.debouncedRefresh();
			})
		);
		this.registerEvent(
			this.app.vault.on('create', () => this.debouncedRefresh())
		);
		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				this.fileMtimeCache.delete(file.path);
				this.fileContentsCache.delete(file.path);
				this.debouncedRefresh();
			})
		);
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				this.fileMtimeCache.delete(oldPath);
				this.fileContentsCache.delete(oldPath);
				this.debouncedRefresh();
			})
		);

		// Handle Ctrl+Z / Cmd+Z for undoing deletions
		this.registerDomEvent(document, 'keydown', async (e: KeyboardEvent) => {
			// Only handle if this view is the active one in the workspace
			if (this.app.workspace.getActiveViewOfType(VisualDashboardView) !== this) return;
			
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
				const lastDeleted = this.deletedNotesStack.pop();
				if (lastDeleted) {
					e.preventDefault();
					try {
						// Double check it doesn't already exist
						const fileExists = this.app.vault.getAbstractFileByPath(lastDeleted.path);
						if (!fileExists) {
							await this.app.vault.create(lastDeleted.path, lastDeleted.content);
							void this.renderCards();
						}
					} catch (error) {
						console.error('Failed to restore deleted note:', error);
					}
				}
			}
		});
	}

	private async refreshView() {
		// Update theme color
		this.applyThemeColor();
		
		// Update view title
		const titleElement = this.contentEl.querySelector('.dashboard-title') as HTMLElement;
		if (titleElement) {
			titleElement.textContent = this.plugin.data.viewTitle || 'Do Your Best Today!';
		}
		
		// Re-render cards to reflect setting changes
		await this.renderCards();
	}

	private crossfadeGrid(applyFn: () => void) {
		const grid = this.miniNotesGrid;

		// Phase 1: fade out to fully invisible
		grid.addClass('grid-fading-out');

		// Phase 2: after fade-out completes, swap content while invisible, then fade in
		setTimeout(() => {
			// Set instant-zero so content swap is invisible
			grid.removeClass('grid-fading-out');
			grid.addClass('grid-fading-in');

			applyFn();

			// Force reflow so browser registers opacity:0 on new content
			void grid.offsetHeight;

			// Phase 3: fade in
			grid.removeClass('grid-fading-in');
			// opacity transitions back to 1 via the base .mini-notes-grid rule
		}, 150);
	}

	private debouncedRefresh() {
		if (this.refreshTimeoutId !== null) {
			window.clearTimeout(this.refreshTimeoutId);
		}
		
		this.refreshTimeoutId = window.setTimeout(() => {
			void this.renderCards();
			this.refreshTimeoutId = null;
		}, DEBOUNCE_REFRESH_MS);
	}

	private updateSearchState(query: string) {
		const parsed = parseSearchOperators(query);
		this.filterTag = parsed.filterTag;
		this.filterPinned = parsed.filterPinned;
		this.filterColors = parsed.filterColors;
		this.filterFolder = parsed.filterFolder;
		this.filterOperators = parsed.filterOperators;
	}

	private updateSearchSuggestions(query: string) {
		if (!this.searchSuggestionsEl) return;
		
		this.searchSuggestionsEl.empty();
		this.selectedSuggestionIndex = -1;
		this.currentSuggestionQuery = query;
		
		const suggestions = getSearchSuggestions(query, this.allTags, this.allFolders, this.plugin.data.noteColors);
		this.currentSuggestions = suggestions;
		
		if (suggestions.length > 0) {
			suggestions.forEach((suggestion, index) => {
				const suggestionEl = this.searchSuggestionsEl!.createDiv({ cls: 'search-suggestion-item' });
				suggestionEl.textContent = suggestion.display;
				suggestionEl.addEventListener('mouseenter', () => {
					this.selectedSuggestionIndex = index;
					const allSuggestions = this.searchSuggestionsEl!.querySelectorAll('.search-suggestion-item');
					this.highlightSuggestion(allSuggestions);
				});
				suggestionEl.addEventListener('mousedown', (e) => {
					e.preventDefault();
					this.applySuggestion(query, suggestion);
				});
			});
			this.searchSuggestionsEl.addClass('show');
		} else {
			this.searchSuggestionsEl.removeClass('show');
		}
	}

	private highlightSuggestion(suggestions: NodeListOf<Element>) {
		suggestions.forEach((el, idx) => {
			if (idx === this.selectedSuggestionIndex) {
				el.addClass('selected');
			} else {
				el.removeClass('selected');
			}
		});
	}

	private applySuggestion(query: string, suggestion: { type: string; value: string; display: string }) {
		const words = query.split(' ');
		words[words.length - 1] = suggestion.value;
		// Only add space if it's an incomplete operator (doesn't contain a value after :)
		const isIncompleteOperator = suggestion.value.endsWith(':');
		const newQuery = words.join(' ') + (isIncompleteOperator ? '' : ' ');
		const searchInput = this.contentEl.querySelector('.search-input') as HTMLInputElement;
		if (searchInput) {
			searchInput.value = newQuery;
			this.filterSearch = newQuery;
			// Always update search state and refresh (unless it's an incomplete operator)
			if (!isIncompleteOperator) {
				this.updateSearchState(newQuery);
				this.debouncedRefresh();
				this.searchSuggestionsEl?.empty();
				this.searchSuggestionsEl?.removeClass('show');
				this.selectedSuggestionIndex = -1;
			} else {
				// For incomplete operators, show the next level of suggestions
				this.updateSearchSuggestions(newQuery);
			}
			searchInput.focus();
		}
	}

	private clearAllFilters() {
		this.filterSearch = '';
		this.filterTag = null;
		this.filterFolder = null;
		this.filterPinned = 'all';
		this.filterColors = [];
		this.filterOperators.clear();
		
		const searchInput = this.contentEl.querySelector('.search-input') as HTMLInputElement;
		if (searchInput) {
			searchInput.value = '';
		}
		
		const clearBtn = this.contentEl.querySelector('.search-clear-btn') as HTMLElement;
		if (clearBtn) {
			clearBtn.style.display = 'none';
		}
		
		const pinToggle = this.contentEl.querySelector('.filter-icon[aria-label*=\"pinned\"]') as HTMLElement;
		if (pinToggle) {
			pinToggle.removeClass('active');
		}
		
		const filterChipsContainer = this.contentEl.querySelector('.filter-chips-container') as HTMLElement;
		if (filterChipsContainer) {
			filterChipsContainer.style.display = 'none';
		}
	}

	private showUndoToast(fileName: string) {
		// Remove existing toast
		if (this.undoToastEl) {
			this.undoToastEl.remove();
			this.undoToastEl = null;
		}
		if (this.undoToastTimeoutId !== null) {
			window.clearTimeout(this.undoToastTimeoutId);
		}

		const toast = this.contentEl.createDiv({ cls: 'undo-toast' });
		toast.createSpan({ text: `"${fileName}" moved to trash` });
		const undoBtn = toast.createEl('button', { text: 'Undo', cls: 'undo-toast-btn' });
		undoBtn.addEventListener('click', async () => {
			const lastDeleted = this.deletedNotesStack.pop();
			if (lastDeleted) {
				try {
					const fileExists = this.app.vault.getAbstractFileByPath(lastDeleted.path);
					if (!fileExists) {
						await this.app.vault.create(lastDeleted.path, lastDeleted.content);
						void this.renderCards();
					}
				} catch (error) {
					console.error('Failed to restore deleted note:', error);
				}
			}
			toast.remove();
			this.undoToastEl = null;
		});

		this.undoToastEl = toast;
		// 10s undo window (ADHD-friendly per PRODUCT.md)
		this.undoToastTimeoutId = window.setTimeout(() => {
			toast.addClass('undo-toast-hiding');
			window.setTimeout(() => {
				toast.remove();
				this.undoToastEl = null;
			}, 300);
		}, 10000);
	}

	private toggleDrawer(forceState?: boolean) {
		this.drawerOpen = forceState ?? !this.drawerOpen;
		this.drawerEl?.toggleClass('open', this.drawerOpen);
		this.scrimEl?.toggleClass('open', this.drawerOpen);
		if (this.drawerOpen) {
			this.renderDrawerContents();
		}
	}

	private renderDrawerContents() {
		if (!this.drawerEl) return;
		this.drawerEl.empty();

		const drawerHeader = this.drawerEl.createDiv({ cls: 'drawer-header' });
		drawerHeader.createEl('h2', { text: 'Folders' });

		const drawerScroll = this.drawerEl.createDiv({ cls: 'drawer-scroll' });

		// "All Notes" row — always first
		const allNotesRow = drawerScroll.createDiv({ cls: 'drawer-folder-item' + (this.activeFilterFolder === null && this.navigatedFolder === null ? ' active' : '') });
		const allNotesIcon = allNotesRow.createDiv({ cls: 'drawer-folder-icon' });
		setIcon(allNotesIcon, 'home');
		allNotesRow.createSpan({ cls: 'drawer-folder-name', text: 'All Notes' });
		const totalNotes = this.app.vault.getMarkdownFiles().length;
		allNotesRow.createSpan({ cls: 'drawer-folder-count', text: String(totalNotes) });
		allNotesRow.addEventListener('click', () => {
			this.activeFilterFolder = null;
			this.navigatedFolder = null;
			this.updateBreadcrumb();
			this.toggleDrawer(false);
			void this.renderCards();
		});

		// Bookmarks section
		const bookmarkedFolders = this.plugin.data.bookmarkedFolders;
		if (bookmarkedFolders.length > 0) {
			drawerScroll.createDiv({ cls: 'drawer-divider' });
			drawerScroll.createDiv({ cls: 'drawer-section-label', text: 'Bookmarks' });

			for (const folderPath of bookmarkedFolders) {
				const folder = this.app.vault.getAbstractFileByPath(folderPath);
				if (!folder || !(folder instanceof TFolder)) continue;

				const isActive = this.activeFilterFolder === folderPath || this.navigatedFolder === folderPath;
				const row = drawerScroll.createDiv({ cls: 'drawer-folder-item' + (isActive ? ' active' : '') });

				const iconEl = row.createDiv({ cls: 'drawer-folder-icon' });
				setIcon(iconEl, 'folder');
				row.createSpan({ cls: 'drawer-folder-name', text: folder.name });
				const noteCount = this.countNotesInFolder(folderPath);
				row.createSpan({ cls: 'drawer-folder-count', text: String(noteCount) });

				const starBtn = row.createEl('button', { cls: 'folder-star-btn starred', text: '\u2605', attr: { 'aria-label': 'Remove bookmark' } });
				starBtn.addEventListener('click', (e) => {
					e.stopPropagation();
					void this.plugin.toggleBookmark(folderPath).then(() => this.renderDrawerContents());
				});

				this.attachFolderRowEvents(row, folderPath);
			}
		}

		// Divider + All Folders tree
		drawerScroll.createDiv({ cls: 'drawer-divider' });
		drawerScroll.createDiv({ cls: 'drawer-section-label', text: 'All Folders' });

		const rootFolder = this.app.vault.getRoot();
		this.renderFolderTree(drawerScroll, rootFolder, 0);
	}

	private attachFolderRowEvents(row: HTMLElement, folderPath: string) {
		// Tap = filter
		row.addEventListener('click', () => {
			this.activeFilterFolder = folderPath;
			this.navigatedFolder = null;
			this.updateBreadcrumb();
			this.toggleDrawer(false);
			void this.renderCards();
		});

		// Long-press = navigate
		let longPressTimer: number | null = null;
		row.addEventListener('pointerdown', () => {
			longPressTimer = window.setTimeout(() => {
				this.navigatedFolder = folderPath;
				this.activeFilterFolder = null;
				this.updateBreadcrumb();
				this.toggleDrawer(false);
				void this.renderCards();
			}, 500);
		});
		row.addEventListener('pointerup', () => { if (longPressTimer) window.clearTimeout(longPressTimer); });
		row.addEventListener('pointerleave', () => { if (longPressTimer) window.clearTimeout(longPressTimer); });
	}

	private renderFolderTree(container: HTMLElement, folder: TFolder, depth: number) {
		if (depth > 4) return;
		if (folder.path === this.app.vault.configDir) return;

		const children = folder.children
			.filter((child): child is TFolder => child instanceof TFolder)
			.filter(child => child.path !== this.app.vault.configDir)
			.sort((a, b) => a.name.localeCompare(b.name));

		for (const child of children) {
			const subFolders = child.children.filter((c): c is TFolder => c instanceof TFolder && c.path !== this.app.vault.configDir);
			const hasChildren = subFolders.length > 0;
			const isBookmarked = this.plugin.isBookmarked(child.path);

			const row = container.createDiv({ cls: 'drawer-folder-item' });
			if (depth > 0) row.setAttribute('data-depth', String(depth));

			// Chevron
			if (hasChildren) {
				const chevron = row.createDiv({ cls: 'folder-chevron' });
				setIcon(chevron, 'chevron-right');
				chevron.addEventListener('click', (e) => {
					e.stopPropagation();
					chevron.toggleClass('expanded', !chevron.hasClass('expanded'));
					const subtree = row.nextElementSibling;
					if (subtree?.hasClass('folder-subtree')) {
						(subtree as HTMLElement).toggleClass('collapsed', !subtree.hasClass('collapsed'));
					}
				});
			} else {
				row.createDiv({ cls: 'folder-chevron-spacer' });
			}

			const iconEl = row.createDiv({ cls: 'drawer-folder-icon' });
			setIcon(iconEl, 'folder');
			row.createSpan({ cls: 'drawer-folder-name', text: child.name });

			const noteCount = this.countNotesInFolder(child.path);
			row.createSpan({ cls: 'drawer-folder-count', text: String(noteCount) });

			const starBtn = row.createEl('button', {
				cls: 'folder-star-btn' + (isBookmarked ? ' starred' : ''),
				text: isBookmarked ? '\u2605' : '\u2606',
				attr: { 'aria-label': isBookmarked ? 'Remove bookmark' : 'Add bookmark' }
			});
			starBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				void this.plugin.toggleBookmark(child.path).then(() => this.renderDrawerContents());
			});

			this.attachFolderRowEvents(row, child.path);

			if (hasChildren) {
				const subtree = container.createDiv({ cls: 'folder-subtree collapsed' });
				this.renderFolderTree(subtree, child, depth + 1);
			}
		}
	}

	private countNotesInFolder(folderPath: string): number {
		return this.app.vault.getMarkdownFiles()
			.filter(f => f.path.startsWith(folderPath + '/'))
			.length;
	}

	private updateBreadcrumb() {
		const breadcrumbBar = this.contentEl.querySelector('.breadcrumb-bar') as HTMLElement;
		if (!breadcrumbBar) return;

		const activeFolder = this.navigatedFolder || this.activeFilterFolder;
		if (!activeFolder) {
			breadcrumbBar.style.display = 'none';
			// Reset title
			const titleEl = this.contentEl.querySelector('.dashboard-title') as HTMLElement;
			if (titleEl) titleEl.textContent = this.plugin.data.viewTitle || 'Do Your Best Today!';
			return;
		}

		breadcrumbBar.style.display = 'flex';
		breadcrumbBar.empty();

		const clearBtn = breadcrumbBar.createEl('button', { cls: 'breadcrumb-clear', attr: { 'aria-label': 'Clear folder filter' } });
		setIcon(clearBtn, 'x');
		clearBtn.addEventListener('click', () => {
			this.activeFilterFolder = null;
			this.navigatedFolder = null;
			this.updateBreadcrumb();
			void this.renderCards();
		});

		const parts = activeFolder.split('/');
		const crumbContainer = breadcrumbBar.createDiv({ cls: 'breadcrumb-crumbs' });
		crumbContainer.createSpan({ cls: 'breadcrumb-segment', text: 'Vault' });
		for (const part of parts) {
			crumbContainer.createSpan({ cls: 'breadcrumb-separator', text: ' > ' });
			crumbContainer.createSpan({ cls: 'breadcrumb-segment', text: part });
		}
	}

	private closeAllColorDropdowns(except: HTMLElement | null = null) {
		if (this.activeColorDropdown && this.activeColorDropdown !== except) {
			this.activeColorDropdown.removeClass('show');
		}

		if (!except) {
			this.activeColorDropdown = null;
		}
	}

	private applyThemeColor() {
		const container = this.contentEl;
		let themeColor: string;

		switch (this.plugin.data.themeColor) {
			case 'black':
				themeColor = '#000000';
				break;
			case 'custom':
				themeColor = this.plugin.data.customThemeColor;
				break;
			case 'obsidian':
			default:
				// Use Obsidian's interactive accent color
				themeColor = getComputedStyle(document.body).getPropertyValue('--interactive-accent').trim();
				break;
		}

		// Set CSS custom property for theme color
		container.style.setProperty('--masonry-theme-color', themeColor);
	}

	async renderCards() {
		try {
			// Do not empty the grid immediately, we need to gather the new DOM first for smooth view transitions

			// Get all markdown files, filtered by source folder if specified
			let files = this.app.vault.getMarkdownFiles();
		
			// Filter by source folder if specified ("/" = all notes)
			const sourceFolder = this.plugin.data.sourceFolder.trim();
			if (sourceFolder && sourceFolder !== '/') {
				files = files.filter((file: TFile) => file.path.startsWith(sourceFolder));
			}

			// Apply drawer folder filter (tap = filter, long-press = navigate)
			const drawerFolder = this.navigatedFolder || this.activeFilterFolder;
			if (drawerFolder) {
				files = files.filter((file: TFile) => file.path.startsWith(drawerFolder + '/'));
			}
			
		// Filter out config folder files to avoid reading plugin/config files
		files = files.filter((file: TFile) => !file.path.startsWith(this.app.vault.configDir + '/'));
		
		// When text search is active, fetch more files to filter from.
		// Otherwise, fetch only what we'll display — much faster.
		const hasTextSearch = this.filterSearch && isSimpleTextSearch(this.filterSearch);
		const fetchLimit = hasTextSearch
			? this.plugin.data.maxNotes * FILE_FETCH_MULTIPLIER
			: this.plugin.data.maxNotes;

		files = files
			.sort((a: TFile, b: TFile) => b.stat.mtime - a.stat.mtime)
			.slice(0, fetchLimit);

		// Phase 1: Extract tags from metadataCache (zero disk I/O)
		const fileTagsMap = new Map<string, string[]>();
		const tagSet = new Set<string>();
		for (const file of files) {
			const cache = this.app.metadataCache.getFileCache(file);
			const tags = (cache?.tags?.map(t => t.tag) ?? []);
			const uniqueTags = [...new Set(tags)];
			fileTagsMap.set(file.path, uniqueTags);
			uniqueTags.forEach(tag => tagSet.add(tag));
		}
		this.fileTagsCache = fileTagsMap;

		// Phase 2: Read file content — skip files whose mtime hasn't changed (persistent cache)
		const filesToRead = files.filter(file => {
			const cachedMtime = this.fileMtimeCache.get(file.path);
			return cachedMtime === undefined || cachedMtime !== file.stat.mtime;
		});

		if (filesToRead.length > 0) {
			// Read all stale/new files in one parallel burst — cachedRead is memory-backed
			const results = await Promise.all(
				filesToRead.map(async (file) => {
					try {
						return { path: file.path, mtime: file.stat.mtime, content: await this.app.vault.cachedRead(file) };
					} catch (error) {
						console.warn(`Failed to read file ${file.path}:`, error);
						return { path: file.path, mtime: file.stat.mtime, content: '' };
					}
				})
			);
			for (const { path, mtime, content } of results) {
				this.fileContentsCache.set(path, content);
				this.fileMtimeCache.set(path, mtime);
			}
		}

		// Build the content map for this render from the persistent cache
		const fileContents = new Map<string, string>();
		for (const file of files) {
			fileContents.set(file.path, this.fileContentsCache.get(file.path) ?? '');
		}

		this.allTags = Array.from(tagSet).sort();

		// Get all folders in vault for folder suggestions
		const folderSet = new Set<string>();
		folderSet.add('/'); // Add root
		this.app.vault.getAllLoadedFiles().forEach(file => {
			if ('children' in file && file.children !== undefined) {
				if (file.path && file.path !== '/' && file.path !== '') folderSet.add(file.path);
			}
		});
		this.allFolders = Array.from(folderSet).sort();

		// Apply all filters using search module
		const searchState: SearchState = {
			query: this.filterSearch,
			filterTag: this.filterTag,
			filterPinned: this.filterPinned,
			filterColors: this.filterColors,
			filterFolder: this.filterFolder,
			filterOperators: this.filterOperators
		};
		
		files = filterFiles(
			files,
			fileContents,
			searchState,
			(path) => this.plugin.isPinned(path),
			(path) => this.plugin.data.noteColors[path]
		);

		// Limit after filtering
		files = files.slice(0, this.plugin.data.maxNotes);

		// Separate and sort files by pin status
		const sortByOrder = (a: TFile, b: TFile) => {
			const aOrder = this.plugin.getOrderIndex(a.path);
			const bOrder = this.plugin.getOrderIndex(b.path);

			if (aOrder > -1 && bOrder > -1) return aOrder - bOrder;
			if (aOrder > -1) return -1;
			if (bOrder > -1) return 1;
			return b.stat.mtime - a.stat.mtime;
		};

		const pinnedFiles = files.filter(f => this.plugin.isPinned(f.path)).sort(sortByOrder);
		const unpinnedFiles = files.filter(f => !this.plugin.isPinned(f.path)).sort(sortByOrder);

		// Store the combined order for drag-and-drop
		this.currentFiles = [...pinnedFiles, ...unpinnedFiles];

		if (files.length === 0) {
			this.crossfadeGrid(() => {
				this.miniNotesGrid.empty();
				const emptyState = this.miniNotesGrid.createDiv({ cls: 'dashboard-empty-state' });
				emptyState.createEl('h3', { text: 'No matching notes' });
				emptyState.createEl('p', { text: 'Try adjusting your filters' });
			});
			return;
		}

		let globalIndex = 0;

		// Check if we need sections (both pinned and unpinned exist)
		const needsSections = pinnedFiles.length > 0 && unpinnedFiles.length > 0;
		const fragment = document.createDocumentFragment();

		// Cancel any pending rich renders from previous render cycle
		for (const id of this.pendingRichRenders) {
			cancelIdleCallback(id);
		}
		this.pendingRichRenders = [];

		if (needsSections) {
			// Render pinned section
			if (pinnedFiles.length > 0) {
				const pinnedGrid = fragment.createEl('div', { cls: 'mini-notes-grid-section' });
				for (const file of pinnedFiles) {
					const card = this.createCard(file, globalIndex++);
					if (card) pinnedGrid.appendChild(card);
				}
			}

			// Separator line between sections
			fragment.createEl('div', { cls: 'section-separator' });

			// Render all notes section
			if (unpinnedFiles.length > 0) {
				const notesGrid = fragment.createEl('div', { cls: 'mini-notes-grid-section' });
				for (const file of unpinnedFiles) {
					const card = this.createCard(file, globalIndex++);
					if (card) notesGrid.appendChild(card);
				}
			}
		} else {
			// Single section without header
			const singleGrid = fragment.createEl('div', { cls: 'mini-notes-grid-section' });
			for (const file of [...pinnedFiles, ...unpinnedFiles]) {
				const card = this.createCard(file, globalIndex++);
				if (card) singleGrid.appendChild(card);
			}
		}

		this.crossfadeGrid(() => {
			this.miniNotesGrid.empty();
			this.miniNotesGrid.appendChild(fragment);
		});
		} catch (error) {
			console.error('Error rendering cards:', error);
			const errorMsg = this.miniNotesGrid.createDiv({ cls: 'dashboard-error' });
			const errorText = errorMsg.createEl('p');
			errorText.createSpan({ text: 'Failed to render cards. Please open the console (Ctrl+Shift+I), screenshot the error, and ' });
			const link = errorText.createEl('a', { 
			text: 'Report it on GitHub',
				href: 'https://github.com/rknastenka/mini-notes/issues'
			});
			link.setAttribute('target', '_blank');
			errorText.createSpan({ text: '.' });
		}
	}

	private getPreviewMarkdown(content: string): string {
		// Truncate raw content for preview (keep markdown formatting for proper rendering)
		let previewText = content;
		if (content.length > MAX_PREVIEW_LENGTH) {
			// Find a good break point (end of line) near the limit
			const truncated = content.substring(0, MAX_PREVIEW_LENGTH);
			const lastNewline = truncated.lastIndexOf('\n');
			previewText = lastNewline > MAX_PREVIEW_LENGTH * 0.7
				? truncated.substring(0, lastNewline)
				: truncated;
		}

		// Remove Obsidian tags from preview (they're shown in the footer)
		// split by lines and only remove tags outside code blocks
		const lines = previewText.split('\n');
		let inCodeBlock = false;
		const processedLines = lines.map(line => {
			if (line.trim().startsWith('```')) {
				inCodeBlock = !inCodeBlock;
				return line;
			}
			if (inCodeBlock) return line;

			const inlineCodeParts: string[] = [];
			let tempLine = line.replace(/`[^`]+`/g, (match) => {
				inlineCodeParts.push(match);
				return `\u200B${inlineCodeParts.length - 1}\u200B`;
			});

			tempLine = tempLine.replace(/(\s)#[a-zA-Z][a-zA-Z0-9_-]*/g, '$1');
			tempLine = tempLine.replace(/^#[a-zA-Z][a-zA-Z0-9_-]*/g, '');
			tempLine = tempLine.replace(/\u200B(\d+)\u200B/g, (_, idx) => inlineCodeParts[parseInt(idx)] || '');

			return tempLine;
		});

		return processedLines.join('\n');
	}

	createCard(file: TFile, index: number): HTMLElement | null {
		const card = document.createElement('div');
		card.addClass('dashboard-card');
		card.setAttribute('data-path', file.path);
		card.setAttribute('data-index', index.toString());
		card.setAttribute('draggable', 'true');
		card.setAttribute('role', 'article');
		card.setAttribute('tabindex', '0');
		card.setAttribute('aria-label', file.basename);

		// Add isolated View Transition Name to smoothly animate layout bumps
		const safeCssIdent = 'card-' + file.path.replace(/[^a-zA-Z0-9_-]/g, '-');
		card.style.setProperty('view-transition-name', safeCssIdent);

		try {
			// Use cached content — no async read needed
			const content = this.fileContentsCache.get(file.path) || '';
		const previewText = this.getPreviewMarkdown(content);

		// Check if pinned
		const isPinned = this.plugin.isPinned(file.path);
		if (isPinned) {
			card.addClass('card-pinned');
		}

		// Apply saved color if exists
		const savedColor = this.plugin.data.noteColors[file.path];
		if (savedColor) {
			card.style.backgroundColor = savedColor;
		}

		// Apply max height limit
		card.style.maxHeight = `${MAX_CARD_HEIGHT}px`;
		// Required to prevent card content from exceeding max height - dynamic styling needed per card
		// eslint-disable-next-line obsidianmd/no-static-styles-assignment
		card.style.overflow = 'hidden';

		// Pin button (shows on hover)
		const pinBtn = card.createEl('button', { cls: 'card-pin-btn' + (isPinned ? ' pinned' : ''), attr: { 'aria-label': isPinned ? 'Unpin note' : 'Pin note' } });
		setIcon(pinBtn, 'pin');
		pinBtn.addEventListener('click', (e: MouseEvent) => {
			e.stopPropagation();
			void this.plugin.togglePin(file.path).then(async (nowPinned) => {
				pinBtn.classList.toggle('pinned', nowPinned);
				card.classList.toggle('card-pinned', nowPinned);
				await this.renderCards();
			});
		});

		// Color button (shows on hover) next to pin — toggled via settings
		if (this.plugin.data.showColorButton) {
		const colorBtn = card.createEl('button', { cls: 'card-color-btn', attr: { 'aria-label': 'Change note color' } });
		setIcon(colorBtn, 'palette');

		// Create color palette dropdown using CSS variables
		const pastelColors = [
			'var(--pastel-peach)',    // Peach
			'var(--pastel-yellow)',   // Yellow
			'var(--pastel-green)',    // Green
			'var(--pastel-blue)',     // Blue
			'var(--pastel-purple)',   // Purple
			'var(--pastel-magenta)',  // Pink
			'var(--pastel-gray)'      // Gray (remove color)
		];

		const colorDropdown = card.createDiv({ cls: 'card-color-dropdown', attr: { role: 'menu', 'aria-label': 'Color options' } });

		pastelColors.forEach((color, colorIndex) => {
			const colorCircle = colorDropdown.createEl('button', { cls: 'color-circle', attr: { role: 'menuitem' } });
			colorCircle.style.backgroundColor = color;

			// Last color is for removing
			if (colorIndex === pastelColors.length - 1) {
				colorCircle.addClass('color-circle-clear');
				colorCircle.setAttribute('aria-label', 'Remove color');
			} else {
				colorCircle.setAttribute('aria-label', 'Apply color');
			}

			colorCircle.addEventListener('click', (e: MouseEvent) => {
				e.stopPropagation();

				void (async () => {
					if (colorIndex === pastelColors.length - 1) {
						// Remove color - required to reset dynamically applied background color
						// eslint-disable-next-line obsidianmd/no-static-styles-assignment
						card.style.backgroundColor = '';
						delete this.plugin.data.noteColors[file.path];
					} else {
						// Apply color using CSS variable
						card.style.backgroundColor = color;
						// Store the CSS variable name so it adapts to theme changes
						this.plugin.data.noteColors[file.path] = color;
					}

					await this.plugin.savePluginData();
					this.closeAllColorDropdowns();
				})();
			});
		});

		// Toggle dropdown on click
		colorBtn.addEventListener('click', (e: MouseEvent) => {
			e.stopPropagation();
			const shouldOpen = !colorDropdown.hasClass('show');
			this.closeAllColorDropdowns(colorDropdown);
			colorDropdown.toggleClass('show', shouldOpen);
			this.activeColorDropdown = shouldOpen ? colorDropdown : null;
		});

		// Close dropdown when clicking outside
		card.addEventListener('click', () => {
			if (this.activeColorDropdown === colorDropdown) {
				this.closeAllColorDropdowns();
			}
		});
		} // end showColorButton

		// Card header with file info
		const cardHeader = card.createDiv({ cls: 'card-header' });

		// Title
		const title = cardHeader.createEl('h3', {
			text: file.basename,
			cls: 'card-title'
		});
		title.setAttribute('title', file.basename);

		// Card content — Phase 1: instant plaintext preview
		const cardContent = card.createDiv({ cls: 'card-content' });
		if (previewText.trim()) {
			const previewContainer = cardContent.createDiv({ cls: 'card-preview' });
			// Synchronous plaintext for instant render
			previewContainer.textContent = getPreviewText(content, MAX_PREVIEW_LENGTH);

			// Phase 2: upgrade to rich markdown in background
			// On mobile, use longer timeout — idle windows are tiny (5-10ms)
			const idleTimeout = Platform.isMobile ? 5000 : 3000;
			const richRenderId = requestIdleCallback(() => {
				const richContainer = document.createElement('div');
				richContainer.addClass('card-preview');
				void MarkdownRenderer.render(
					this.app,
					previewText,
					richContainer,
					file.path,
					this
				).then(() => {
					// Only swap if card is still in DOM (not re-rendered)
					if (previewContainer.isConnected) {
						previewContainer.replaceWith(richContainer);

						// Apply search highlighting after rich render
						if (this.filterSearch && isSimpleTextSearch(this.filterSearch)) {
							const cleanQuery = getCleanQuery(this.filterSearch);
							if (cleanQuery) {
								highlightSearchTerms(title, cleanQuery);
								highlightSearchTerms(richContainer, cleanQuery);
							}
						}
					}
				});
			}, { timeout: idleTimeout });
			this.pendingRichRenders.push(richRenderId);

			// Search highlighting on plaintext phase (visible until rich render swaps in)
			if (this.filterSearch && isSimpleTextSearch(this.filterSearch)) {
				const cleanQuery = getCleanQuery(this.filterSearch);
				if (cleanQuery) {
					highlightSearchTerms(title, cleanQuery);
					highlightSearchTerms(previewContainer, cleanQuery);
				}
			}
		} else {
			cardContent.createEl('p', {
				text: 'Empty note...',
				cls: 'card-preview card-preview-empty'
			});
		}

		// Card footer with metadata
		const cardFooter = card.createDiv({ cls: 'card-footer' });

		// Tags on left
		const tagsContainer = cardFooter.createDiv({ cls: 'card-tags' });
		const tags = this.fileTagsCache.get(file.path) || [];
		if (tags.length > 0) {
			tags.slice(0, 3).forEach(tag => {
				tagsContainer.createSpan({ cls: 'card-tag', text: tag });
			});
			if (tags.length > 3) {
				tagsContainer.createSpan({ cls: 'card-tag-more', text: `+${tags.length - 3}` });
			}
		}

		// Date on right
		const dateSpan = cardFooter.createSpan({ cls: 'card-date' });
		dateSpan.createSpan({ text: formatDate(file.stat.mtime) });

		// Middle-click handler to delete the note
		card.addEventListener('auxclick', async (e: MouseEvent) => {
			if (e.button === 1) { // Middle click button
				e.preventDefault();
				try {
					const contentToSave = await this.app.vault.read(file);
					this.deletedNotesStack.push({ path: file.path, content: contentToSave });
				} catch (err) {
					console.error('Could not save note content for undo', err);
				}

				await this.app.fileManager.trashFile(file);
				this.showUndoToast(file.basename);
				void this.renderCards();
			}
		});

		// Click handler to open the note
		card.addEventListener('click', (e: MouseEvent) => {
			// Don't open if clicking interactive elements or during drag
			if ((e.target as HTMLElement).closest('.card-pin-btn, .card-color-btn, .card-color-dropdown')) return;
			// Mobile: open in same leaf so Android back returns to dashboard
			// Desktop: open in new tab (expected behavior)
			if (Platform.isMobile) {
				void this.leaf.openFile(file);
			} else {
				const leaf = this.app.workspace.getLeaf('tab');
				void leaf.openFile(file);
			}
		});

		// Keyboard handler — Enter/Space opens the note
		card.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') {
				if ((e.target as HTMLElement).closest('button')) return;
				e.preventDefault();
				if (Platform.isMobile) {
					void this.leaf.openFile(file);
				} else {
					const leaf = this.app.workspace.getLeaf('tab');
					void leaf.openFile(file);
				}
			}
		});

		// Drag and drop handlers
		card.addEventListener('dragstart', (e: DragEvent) => this.handleDragStart(e, card));
		card.addEventListener('dragend', (e: DragEvent) => this.handleDragEnd(e, card));
		card.addEventListener('dragover', (e: DragEvent) => this.handleDragOver(e, card));
		card.addEventListener('drop', (e: DragEvent) => void this.handleDrop(e, card));
		} catch (error) {
			console.warn(`Skipping card for ${file.path} due to error:`, error);
			return null;
		}

		return card;
	}

	// Drag and Drop Handlers
	handleDragStart(e: DragEvent, card: HTMLElement) {
		this.draggedCard = card;
		this.dragOverTargetCard = null;
		this.pendingDragTargetCard = null;
		this.pendingDragClientY = null;
		card.classList.add('dragging');

		if (e.dataTransfer) {
			e.dataTransfer.effectAllowed = 'move';
			e.dataTransfer.setData('text/plain', card.getAttribute('data-path') || '');
		}
	}

	handleDragEnd(e: DragEvent, card: HTMLElement) {
		void e;
		card.classList.remove('dragging');
		if (this.dragFrameId !== null) {
			window.cancelAnimationFrame(this.dragFrameId);
			this.dragFrameId = null;
		}
		this.pendingDragTargetCard = null;
		this.pendingDragClientY = null;
		this.setDragOverTarget(null);
		this.draggedCard = null;
	}

	handleDragOver(e: DragEvent, card: HTMLElement) {
		e.preventDefault();
		if (e.dataTransfer) {
			e.dataTransfer.dropEffect = 'move';
		}

		if (!this.draggedCard || card === this.draggedCard) return;

		this.pendingDragTargetCard = card;
		this.pendingDragClientY = e.clientY;

		if (this.dragFrameId === null) {
			this.dragFrameId = window.requestAnimationFrame(() => {
				this.dragFrameId = null;
				this.applyPendingDragReorder();
			});
		}
	}

	async handleDrop(e: DragEvent, targetCard: HTMLElement) {
		e.preventDefault();

		if (!this.draggedCard || this.draggedCard === targetCard) return;

		if (this.dragFrameId !== null) {
			window.cancelAnimationFrame(this.dragFrameId);
			this.dragFrameId = null;
		}

		this.pendingDragTargetCard = targetCard;
		this.pendingDragClientY = e.clientY;
		this.applyPendingDragReorder();
		this.setDragOverTarget(null);

		const draggedPath = this.draggedCard.getAttribute('data-path');
		if (!draggedPath) return;

		const currentOrder = this.getCurrentCardOrder();
		if (currentOrder.length === 0) return;

		const previousOrder = this.currentFiles.map(file => file.path);
		if (currentOrder.length === previousOrder.length && currentOrder.every((path, index) => path === previousOrder[index])) {
			return;
		}

		const draggedWasPinned = this.plugin.isPinned(draggedPath);
		const targetPath = targetCard.getAttribute('data-path');
		const targetIsPinned = targetPath ? this.plugin.isPinned(targetPath) : draggedWasPinned;

		await this.plugin.updateOrder(currentOrder);
		this.syncCurrentFilesFromOrder(currentOrder);

		if (draggedWasPinned !== targetIsPinned) {
			await this.renderCards();
		}
	}

	private setDragOverTarget(card: HTMLElement | null) {
		if (this.dragOverTargetCard === card) return;

		if (this.dragOverTargetCard) {
			this.dragOverTargetCard.classList.remove('drag-over');
		}

		this.dragOverTargetCard = card;

		if (this.dragOverTargetCard) {
			this.dragOverTargetCard.classList.add('drag-over');
		}
	}

	private applyPendingDragReorder() {
		const draggedCard = this.draggedCard;
		const targetCard = this.pendingDragTargetCard;
		const clientY = this.pendingDragClientY;

		if (!draggedCard || !targetCard || draggedCard === targetCard || clientY === null) {
			return;
		}

		this.setDragOverTarget(targetCard);

		const targetRect = targetCard.getBoundingClientRect();
		const insertBefore = clientY < targetRect.top + targetRect.height / 2;
		const targetParent = targetCard.parentElement;

		if (!targetParent) {
			return;
		}

		if (insertBefore) {
			if (targetCard.previousElementSibling !== draggedCard) {
				targetParent.insertBefore(draggedCard, targetCard);
			}
		} else {
			const nextSibling = targetCard.nextElementSibling;
			if (nextSibling !== draggedCard) {
				targetParent.insertBefore(draggedCard, nextSibling);
			}
		}
	}

	private getCurrentCardOrder(): string[] {
		const cards = Array.from(this.miniNotesGrid.querySelectorAll('.dashboard-card[data-path]'));
		return cards
			.map(card => card.getAttribute('data-path'))
			.filter((path): path is string => path !== null && path.length > 0);
	}

	private syncCurrentFilesFromOrder(order: string[]) {
		const byPath = new Map(this.currentFiles.map(file => [file.path, file]));
		this.currentFiles = order
			.map(path => byPath.get(path))
			.filter((file): file is TFile => file !== undefined);
	}

async onClose() {
		// Cancel pending rich renders
		for (const id of this.pendingRichRenders) {
			cancelIdleCallback(id);
		}
		this.pendingRichRenders = [];
		this.fileContentsCache.clear();
		this.fileMtimeCache.clear();
		this.fileTagsCache.clear();
		if (this.cardObserver) {
			this.cardObserver.disconnect();
			this.cardObserver = null;
		}

		// Event cleanup handled automatically by registerEvent
		this.contentEl.empty();
	}
}
