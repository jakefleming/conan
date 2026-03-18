// state.js — extracted from index.html

let files = [];
let currentIndex = 0;
let searchQuery = '';
let galleryMode = false;
let currentDir = '';
let orphanCount = 0;

let currentFolder = '';
let recentFolders = [];

let zoomScale = 1;
let zoomX = 0;
let zoomY = 0;
let zoomFitScale = 1;
let zoomNatW = 0;
let zoomNatH = 0;
let rotation = 0; // 0, 90, 180, 270

// Region drawing state
let stagedRegion = null;
let drawingRegion = null;
let drawStartImgX = 0;
let drawStartImgY = 0;
let hoveredCommentRegion = null;

// Persistent annotation state
let showAnnotations = true;
let focusedCommentIndex = null;
let editingRegionIndex = null;
let editDragType = null;
let editStartMouse = null;
let editStartRegion = null;
let selectedRegionIndex = null;

// Queue for describe-region requests to avoid read-modify-write races on .context.json
const describeQueue = [];
let describeProcessing = false;
let describePendingCount = 0;

// ── Voice Input ──
let recognition = null;
let isRecording = false;
let textBeforeRecording = '';
let mediaRecorder = null;
let audioChunks = [];
let lastAudioFilename = null;

// ── Settings ──
let hasApiKey = false;

// ── Summary ──
let summaryRawContent = '';
let summaryLastModified = null;
let summaryEditMode = false;
let summaryVisible = false;
let summaryCurrentVersion = null;
let summaryTotalVersions = 0;

// ── Chat Panel ──
const CHAT_STORAGE_KEY = 'conan-chats';
let chatOpen = false;
let chatHistory = [];
// Chat context is now automatic based on current view state
let chatSending = false;
let chatSessions = []; // [{id, title, messages, ts}]
let activeChatId = null;

// ── Chat Attachments ──
let chatAttachments = []; // [{type:"project",path:"...",thumbUrl:"..."} or {type:"upload",data:"base64",mediaType:"...",name:"...",thumbUrl:"..."}]
let sidebarAttachments = []; // same format as chatAttachments, for file-level sidebar

// ── Chat voice input ──
let chatRecognition = null;
let chatIsRecording = false;
let chatTextBeforeRecording = '';
