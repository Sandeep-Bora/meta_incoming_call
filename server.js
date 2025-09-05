// Suppress dotenv debug logging
process.env.DEBUG = '';
require("dotenv").config({ debug: false });
const express = require("express");
const axios = require("axios");
const path = require("path");
const http = require("http");
const socketIO = require("socket.io");
const fs = require("fs");

// WebRTC imports
const {
    RTCPeerConnection,
    RTCSessionDescription,
    RTCIceCandidate,
    MediaStream,
} = require("wrtc");

// STUN server allows each peer to discover its public IP for NAT traversal
const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
  {
    urls: [
      "turn:global.relay.metered.ca:80",
      "turn:global.relay.metered.ca:443",
      "turn:global.relay.metered.ca:3478",
    ],
    username: "37e1df1e0831b85f190394fc",
    credential: "ifbScPfPyTAJhEJJ"
  },
];

// Production Configuration
const CONFIG = {
    PORT: process.env.PORT || 3000,
    LOG_LEVEL: process.env.LOG_LEVEL || 'INFO',
    MAX_RECORDING_DURATION: parseInt(process.env.MAX_RECORDING_DURATION) || 300000, // 5 minutes
    MAX_AUDIO_CHUNKS: parseInt(process.env.MAX_AUDIO_CHUNKS) || 10000,
    CLEANUP_INTERVAL: parseInt(process.env.CLEANUP_INTERVAL) || 300000, // 5 minutes
    WHATSAPP_API_TIMEOUT: parseInt(process.env.WHATSAPP_API_TIMEOUT) || 30000, // 30 seconds
    WEBRTC_TIMEOUT: parseInt(process.env.WEBRTC_TIMEOUT) || 10000, // 10 seconds
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || "*"
};

const WHATSAPP_API_URL = `https://graph.facebook.com/v23.0/${process.env.PHONE_NUMBER_ID}/calls`;
const ACCESS_TOKEN = `Bearer ${process.env.ACCESS_TOKEN}`;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "sandeep_bora";

// Enhanced Logging System
const LOG_LEVELS = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3
};

const CURRENT_LOG_LEVEL = LOG_LEVELS[CONFIG.LOG_LEVEL] || LOG_LEVELS.INFO;

// Generate correlation ID for request tracking
function generateCorrelationId() {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// Enhanced structured logging with correlation IDs
function log(level, message, meta = {}) {
    if (level >= CURRENT_LOG_LEVEL) {
        const timestamp = new Date().toISOString();
        const levelName = Object.keys(LOG_LEVELS)[level];
        const correlationId = meta.correlationId || 'system';
        const callId = meta.callId || 'none';
        
        const logEntry = {
            timestamp,
            level: levelName,
            message,
            correlationId,
            callId,
            ...meta
        };
        
        const logString = `[${timestamp}] [${levelName}] [${correlationId}] [${callId}] ${message} ${Object.keys(meta).length > 0 ? JSON.stringify(meta) : ''}\n`;
        console.log(logString.trim());
        
        try {
            fs.appendFileSync(path.join(__dirname, 'logs', 'incoming_call.log'), logString);
        } catch (error) {
            console.error('Failed to write to log file:', error.message);
        }
    }
}

// Ensure required directories exist
const requiredDirs = ['logs', 'call-recordings', 'temp'];
requiredDirs.forEach(dir => {
    const dirPath = path.join(__dirname, dir);
    if (!fs.existsSync(dirPath)) {
        try {
            fs.mkdirSync(dirPath, { recursive: true });
        } catch (error) {
            log(LOG_LEVELS.ERROR, `Failed to create directory: ${dir}`, { directory: dir, error: error.message });
            process.exit(1);
        }
    }
});

// Validate required environment variables
const requiredEnvVars = ['PHONE_NUMBER_ID', 'ACCESS_TOKEN', 'VERIFY_TOKEN'];
const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);
if (missingEnvVars.length > 0) {
    log(LOG_LEVELS.ERROR, 'Missing required environment variables', { missing: missingEnvVars });
    process.exit(1);
}

const app = express();

// Trust proxy to get real IP addresses (for deployment behind proxies/load balancers)
app.set('trust proxy', true);

const server = http.createServer(app);
const io = socketIO(server, {
    cors: {
        origin: CONFIG.ALLOWED_ORIGINS === "*" ? "*" : CONFIG.ALLOWED_ORIGINS.split(','),
        methods: ["GET", "POST"]
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000
});

// Production Middleware
// Note: Uncomment these when production dependencies are installed
// app.use(helmet({
//     contentSecurityPolicy: {
//         directives: {
//             defaultSrc: ["'self'"],
//             scriptSrc: ["'self'", "'unsafe-inline'"],
//             styleSrc: ["'self'", "'unsafe-inline'"],
//             imgSrc: ["'self'", "data:", "https:"],
//             connectSrc: ["'self'", "wss:", "ws:"]
//         }
//     }
// }));
// app.use(compression());

// Function to get real client IP (handles proxies, load balancers, etc.)
function getClientIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
           req.headers['x-real-ip'] ||
           req.headers['x-client-ip'] ||
           req.headers['cf-connecting-ip'] || // Cloudflare
           req.headers['x-cluster-client-ip'] ||
           req.connection?.remoteAddress ||
           req.socket?.remoteAddress ||
           req.ip ||
           'unknown';
}

// Request logging middleware
app.use((req, res, next) => {
    const correlationId = generateCorrelationId();
    req.correlationId = correlationId;
    res.setHeader('X-Correlation-ID', correlationId);
    
    const startTime = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - startTime;
        log(LOG_LEVELS.INFO, `${req.method} ${req.path}`, {
            correlationId,
            method: req.method,
            path: req.path,
            statusCode: res.statusCode,
            duration: `${duration}ms`,
            userAgent: req.get('User-Agent'),
            ip: getClientIP(req)
        });
    });
    
    next();
});

// Body parsing with size limits
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, "public"), {
    maxAge: '1d',
    etag: true
}));

// Global state management with cleanup tracking
const globalState = {
    browserPc: null,
    browserStream: null,
    whatsappPc: null,
    whatsappStream: null,
    browserOfferSdp: null,
    whatsappOfferSdp: null,
    browserSocket: null,
    currentCallId: null,
    callTerminated: false,
    activeConnections: new Set(),
    callSessions: new Map(),
    lastCleanup: Date.now()
};

// Cleanup function to prevent memory leaks
function cleanupResources() {
    const now = Date.now();
    const cleanupThreshold = 5 * 60 * 1000; // 5 minutes
    
    // Clean up old call sessions
    for (const [callId, session] of globalState.callSessions.entries()) {
        if (now - session.lastActivity > cleanupThreshold) {
            log(LOG_LEVELS.INFO, 'Cleaning up old call session', { callId, lastActivity: session.lastActivity });
            globalState.callSessions.delete(callId);
        }
    }
    
    globalState.lastCleanup = now;
}

// Periodic cleanup
setInterval(cleanupResources, CONFIG.CLEANUP_INTERVAL);

// Production-ready Audio Recording System
class AudioRecorder {
    constructor(callId, correlationId) {
        this.callId = callId;
        this.correlationId = correlationId;
        this.audioChunks = [];
        this.browserAudioChunks = [];
        this.whatsappAudioChunks = [];
        this.isRecording = false;
        this.recordingStartTime = null;
        this.recordingInterval = null;
        this.audioTracks = new Map();
        this.audioProcessors = new Map();
        this.webrtcTracks = new Map();
        this.realAudioData = {};
        this.hasBrowserAudio = false;
        this.hasWhatsAppAudio = false;
        this.audioBridgeActive = false;
        this.audioBridgeStartTime = null;
        this.audioBridgeEndTime = null;
        this.audioFormat = null;
        this.maxChunksReached = false;
        this.recordingDuration = 0;
        this.createdAt = Date.now();
        
        log(LOG_LEVELS.INFO, 'Audio recording system initialized', {
            callId,
            correlationId,
            maxDuration: CONFIG.MAX_RECORDING_DURATION,
            maxChunks: CONFIG.MAX_AUDIO_CHUNKS
        });
    }

    /**
     * Create an empty WAV file when no audio is recorded
     */
    createEmptyWavFile() {
        const dataSize = 0;
        const header = Buffer.alloc(44);
        
        // RIFF header
        header.write('RIFF', 0);
        header.writeUInt32LE(36 + dataSize, 4);
        header.write('WAVE', 8);
        
        // fmt chunk
        header.write('fmt ', 12);
        header.writeUInt32LE(16, 16);
        header.writeUInt16LE(1, 20); // PCM format
        header.writeUInt16LE(1, 22); // Mono
        header.writeUInt32LE(8000, 24); // Sample rate
        header.writeUInt32LE(16000, 28); // Byte rate
        header.writeUInt16LE(2, 32); // Block align
        header.writeUInt16LE(16, 34); // Bits per sample
        
        // data chunk
        header.write('data', 36);
        header.writeUInt32LE(dataSize, 40);
        
        return Buffer.concat([header, Buffer.alloc(0)]);
    }

    /**
     * Start audio recording ONLY after WebRTC audio bridging is successful
     */
    startAudioRecordingAfterBridging() {
        if (this.isRecording) {
            log(LOG_LEVELS.WARN, 'Audio recording already active, skipping duplicate start');
                return;
            }
            
        log(LOG_LEVELS.INFO, '🎵 Starting audio recording AFTER successful WebRTC audio bridging');
        
        this.isRecording = true;
        this.recordingStartTime = Date.now();
        
        log(LOG_LEVELS.INFO, '✅ Audio recording started after successful audio bridging');
    }

    /**
     * End audio bridge and stop all recording
     */
    endAudioBridgeAndStopCapture() {
        if (!this.audioBridgeActive) {
            log(LOG_LEVELS.WARN, '⚠️ Audio bridge not active, nothing to stop');
                    return;
                }
                
        this.audioBridgeActive = false;
        this.audioBridgeEndTime = Date.now();
        
        if (this.audioBridgeStartTime) {
            const duration = Math.round((this.audioBridgeEndTime - this.audioBridgeStartTime) / 1000);
            log(LOG_LEVELS.INFO, `📊 Audio bridge duration: ${duration} seconds`);
        }

        // Stop recording
        this.stopRecording();
        
        // Emit stop signal to browser
        try {
            io.emit('stop-mic-capture');
            log(LOG_LEVELS.INFO, '📤 Emitted stop-mic-capture to browser');
        } catch (error) {
            log(LOG_LEVELS.ERROR, 'Failed to emit stop-mic-capture:', error);
        }
        
        // 🆕 CRITICAL: Don't clear audio data immediately - wait for final recording
        // The browser will send final audio recording, then we'll clear the data
        log(LOG_LEVELS.INFO, '⏳ Waiting for final audio recording before clearing data');
        
        log(LOG_LEVELS.INFO, '✅ Audio bridge ended - all recording stopped and resources cleaned up');
    }

    stopRecording() {
        if (!this.isRecording) return null;
        
        log(LOG_LEVELS.INFO, 'Stopping audio recording');
        this.isRecording = false;
        
        if (this.recordingInterval) {
            clearInterval(this.recordingInterval);
            this.recordingInterval = null;
        }
        
        const recordingDuration = Date.now() - this.recordingStartTime;
        log(LOG_LEVELS.INFO, `Recording duration: ${recordingDuration}ms`);
        
            return null;
    }

    clearAllAudioData() {
        const chunkCount = this.browserAudioChunks.length + this.whatsappAudioChunks.length;
        
        this.audioChunks = [];
        this.browserAudioChunks = [];
        this.whatsappAudioChunks = [];
        this.audioTracks.clear();
        this.audioProcessors.clear();
        this.webrtcTracks.clear();
        this.realAudioData = {};
        this.hasBrowserAudio = false;
        this.hasWhatsAppAudio = false;
        this.audioFormat = null;
        
        log(LOG_LEVELS.INFO, 'All audio data cleared and state reset', {
            callId: this.callId,
            correlationId: this.correlationId,
            clearedChunks: chunkCount
        });
    }
    
    /**
     * Check if recording has exceeded limits
     */
    checkLimits() {
        const totalChunks = this.browserAudioChunks.length + this.whatsappAudioChunks.length;
        
        if (totalChunks > CONFIG.MAX_AUDIO_CHUNKS && !this.maxChunksReached) {
            this.maxChunksReached = true;
            log(LOG_LEVELS.WARN, 'Maximum audio chunks limit reached', {
                callId: this.callId,
                correlationId: this.correlationId,
                totalChunks,
                maxChunks: CONFIG.MAX_AUDIO_CHUNKS
            });
            return false;
        }
        
        return true;
    }
}

// Initialize audio recorder - will be created per call
let audioRecorder = null;
let audioRecorderCallId = null;

// Global WebRTC variables
let browserOfferSdp = null;
let whatsappOfferSdp = null;
let browserSocket = null;
let browserPc = null;
let browserStream = null;
let whatsappPc = null;
let whatsappStream = null;
let currentCallId = null;
let callTerminated = false;

// Health check endpoint
app.get("/health", (req, res) => {
    const health = {
        status: "healthy",
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        activeConnections: globalState.activeConnections.size,
        callSessions: globalState.callSessions.size,
        lastCleanup: globalState.lastCleanup
    };
    
    res.json(health);
});

// Metrics endpoint
app.get("/metrics", (req, res) => {
    const metrics = {
        timestamp: new Date().toISOString(),
        system: {
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            cpu: process.cpuUsage()
        },
        application: {
            activeConnections: globalState.activeConnections.size,
            callSessions: globalState.callSessions.size,
            lastCleanup: globalState.lastCleanup,
            currentCallId: globalState.currentCallId,
            callTerminated: globalState.callTerminated
        },
        audio: {
            audioRecorderActive: audioRecorder ? true : false,
            audioRecorderCallId: audioRecorderCallId,
            maxRecordingDuration: CONFIG.MAX_RECORDING_DURATION,
            maxAudioChunks: CONFIG.MAX_AUDIO_CHUNKS
        }
    };
    
    res.json(metrics);
});

// Recordings API endpoint
app.get("/api/recordings", (req, res) => {
    try {
        const recordingsDir = path.join(__dirname, 'call-recordings');
        
        if (!fs.existsSync(recordingsDir)) {
            return res.json({ recordings: [] });
        }
        
        const files = fs.readdirSync(recordingsDir);
        const recordingsMap = new Map();
        
        files.forEach(file => {
            if (file.endsWith('.wav') || file.endsWith('.mp3')) {
                const filePath = path.join(recordingsDir, file);
                const stats = fs.statSync(filePath);

                // New filename format: <callId>-<timestamp>.wav or .mp3
                // Example: 1234567890abcdef-2024-06-07T12-34-56-789Z.wav
                const match = file.match(/^(.+?)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.(wav|mp3)$/);
                if (match) {
                    const callId = match[1];
                    const timestamp = match[2].replace(/-/g, ':').replace('T', ' ').replace(/:\d{3}Z$/, '');
                    const format = match[3];
                    
                    if (!recordingsMap.has(callId)) {
                        recordingsMap.set(callId, {
                            callId: callId,
                            timestamp: timestamp,
                            created: stats.birthtime,
                            modified: stats.mtime,
                            files: {}
                        });
                    }
                    
                    const recording = recordingsMap.get(callId);
                    recording.files[format] = {
                        filename: file,
                        format: format,
                        size: stats.size,
                        downloadUrl: `/api/recordings/download/${file}`,
                        playUrl: `/api/recordings/play/${file}`
                    };
                    
                    // Update created time to the earliest file
                    if (new Date(stats.birthtime) < new Date(recording.created)) {
                        recording.created = stats.birthtime;
                    }
                }
            }
        });
        
        // Convert map to array and sort by creation time (newest first)
        const recordings = Array.from(recordingsMap.values()).sort((a, b) => new Date(b.created) - new Date(a.created));
        
        log(LOG_LEVELS.INFO, "Recordings list requested", {
            correlationId: req.correlationId,
            totalRecordings: recordings.length,
            totalFiles: files.filter(f => f.endsWith('.wav') || f.endsWith('.mp3')).length
        });
        
        res.json({ recordings });
        } catch (error) {
        log(LOG_LEVELS.ERROR, "Error fetching recordings list", {
            correlationId: req.correlationId,
            error: error.message
        });
        res.status(500).json({ error: "Failed to fetch recordings" });
    }
});

// Download recording endpoint
app.get("/api/recordings/download/:filename", (req, res) => {
    try {
        const filename = req.params.filename;
        const filePath = path.join(__dirname, 'call-recordings', filename);
        
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: "Recording not found" });
        }
        
        log(LOG_LEVELS.INFO, "Recording download requested", {
            correlationId: req.correlationId,
            filename: filename
        });
        
        res.download(filePath, filename);
        } catch (error) {
        log(LOG_LEVELS.ERROR, "Error downloading recording", {
            correlationId: req.correlationId,
            filename: req.params.filename,
            error: error.message
        });
        res.status(500).json({ error: "Failed to download recording" });
    }
});

// Play recording endpoint (stream audio)
app.get("/api/recordings/play/:filename", (req, res) => {
    try {
        const filename = req.params.filename;
        const filePath = path.join(__dirname, 'call-recordings', filename);
        
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: "Recording not found" });
        }
        
        const stat = fs.statSync(filePath);
        const fileSize = stat.size;
        const range = req.headers.range;
        
        if (range) {
            // Handle range requests for audio streaming
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
            const chunksize = (end - start) + 1;
            const file = fs.createReadStream(filePath, { start, end });
            const head = {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunksize,
                'Content-Type': filename.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav',
            };
            res.writeHead(206, head);
            file.pipe(res);
        } else {
            // Serve entire file
            const head = {
                'Content-Length': fileSize,
                'Content-Type': filename.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav',
            };
            res.writeHead(200, head);
            fs.createReadStream(filePath).pipe(res);
        }
        
        log(LOG_LEVELS.INFO, "Recording stream requested", {
            correlationId: req.correlationId,
            filename: filename,
            hasRange: !!range
        });
        } catch (error) {
        log(LOG_LEVELS.ERROR, "Error streaming recording", {
            correlationId: req.correlationId,
            filename: req.params.filename,
            error: error.message
        });
        res.status(500).json({ error: "Failed to stream recording" });
    }
});

/**
 * Webhook verification endpoint for WhatsApp Business API
 */
app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    log(LOG_LEVELS.INFO, "Call webhook verification request received", {
        mode: mode,
        token: token ? "***" : "none",
        challenge: challenge ? "***" : "none"
    });

    if (mode && token) {
        if (mode === "subscribe" && token === VERIFY_TOKEN) {
            log(LOG_LEVELS.INFO, "Call webhook verified successfully!");
            res.status(200).send(challenge);
        } else {
            log(LOG_LEVELS.WARN, "Call webhook verification failed - invalid token");
            res.sendStatus(403);
        }
    } else {
        log(LOG_LEVELS.WARN, "Call webhook verification failed - missing parameters");
        res.sendStatus(400);
    }
});

/**
 * Handles incoming WhatsApp webhook call events.
 */
app.post("/webhook", async (req, res) => {
    const correlationId = req.correlationId || generateCorrelationId();
    
    try {
        const entry = req.body?.entry?.[0];
        const change = entry?.changes?.[0];
        
        // Update webhook status to configured since we're receiving webhook events
        if (!globalState.webhookStatus.configured) {
            globalState.webhookStatus.configured = true;
            globalState.webhookStatus.verification.reason = 'Webhook events received - webhook is configured';
            
            // Notify all connected clients that webhook is now configured
            io.emit("realtime-log", {
                type: "success",
                message: "✅ Webhook configured - Ready to receive calls",
                timestamp: new Date().toISOString(),
                details: "Webhook events are being received successfully"
            });
        }
        
        // Only process actual call webhooks, filter out message webhooks
        const isCallWebhook = change?.field === 'calls' || 
                             (change?.value?.calls && change.value.calls.length > 0);
        
        if (isCallWebhook) {
            log(LOG_LEVELS.INFO, "Received CALL webhook POST request", {
                correlationId,
                bodySize: JSON.stringify(req.body).length,
                hasEntry: !!req.body?.entry,
                hasChanges: !!req.body?.entry?.[0]?.changes,
                field: change?.field,
                hasCalls: !!change?.value?.calls?.length,
                hasStatuses: !!change?.value?.statuses?.length
            });
        } else {
            // Silently handle non-call webhooks (messages, etc.) without logging
            return res.sendStatus(200);
        }
        
        // Handle WhatsApp 'calls' webhook statuses
        if (change?.field === 'calls') {
            const statuses = change?.value?.statuses;
            if (Array.isArray(statuses) && statuses.length > 0) {
                const statusItem = statuses[0];
                const waCallId = statusItem?.id;
                const statusLower = (statusItem?.status || '').toLowerCase();
                currentCallId = waCallId || currentCallId;
                console.log(`🎵 Calls status webhook: id=${waCallId}, status=${statusItem?.status}`);
                
                // Try to extract WhatsApp offer SDP (if provided)
                const possibleSdp = statusItem?.session?.sdp || change?.value?.session?.sdp;
                if (possibleSdp) {
                    whatsappOfferSdp = possibleSdp;
                    log(LOG_LEVELS.INFO, '🎵 WhatsApp offer SDP received from calls.status webhook');
                }
                
                if (statusLower === 'accepted') {
                    console.log(`🎵 WhatsApp call ACCEPTED. Call ID: ${waCallId} - Starting audio recording`);
                    
                    // 🆕 CRITICAL: Start audio recording ONLY when call is accepted (not when bridge is established)
                    if (audioRecorder) {
                        audioRecorder.audioBridgeActive = true;
                        audioRecorder.audioBridgeStartTime = Date.now();
                        audioRecorder.startAudioRecordingAfterBridging();
                        log(LOG_LEVELS.INFO, '📞 Audio recording started - call accepted');
                    } else {
                        log(LOG_LEVELS.WARN, '⚠️ No AudioRecorder instance available for accepted call');
                    }
                    
                    // 🆕 CRITICAL: Request browser to start mic capture when call is accepted
                    if (browserSocket) {
                        try {
                            browserSocket.emit('start-mic-capture', {
                                audio: {
                                    echoCancellation: true,
                                    noiseSuppression: true,
                                    autoGainControl: true,
                                    sampleRate: 8000,
                                    channelCount: 1
                                },
                                timesliceMs: 250 // small chunks
                            });
                            log(LOG_LEVELS.INFO, '📞 Requested browser to start mic capture - call accepted');
        } catch (error) {
                            log(LOG_LEVELS.ERROR, 'Failed to request browser mic capture:', error);
                        }
                    }
                    
                    // Emit call accepted to browser - don't show popup again
                    io.emit("call-accepted", { 
                        callId: waCallId, 
                        callerName: "WhatsApp User", 
                        callerNumber: statusItem?.recipient_id || "Unknown" 
                    });
                    
                    // Attempt to initiate bridge if we have both SDPs and a browser socket
                    await initiateWebRTCBridge();
                    return res.sendStatus(200);
                }
                
                if (statusLower === 'ringing') {
                    console.log(`🎵 WhatsApp call RINGING. Call ID: ${waCallId}`);
                    
                    // No need to create AudioRecorder here - it will be created when call connects
                    return res.sendStatus(200);
                }
                
                if (statusLower === 'rejected' || statusLower === 'terminated') {
                    console.log(`🎵 WhatsApp call ${statusLower.toUpperCase()}. Call ID: ${waCallId} - Stopping audio recording`);
                    io.emit("call-ended");
                    
                    if (audioRecorder && audioRecorder.audioBridgeActive) {
                        audioRecorder.endAudioBridgeAndStopCapture();
                    }
                    return res.sendStatus(200);
                }
            }
            console.warn('Calls webhook received but no actionable statuses found in statuses array. Falling through to handle calls events.');
        }
        
        // Only process call events if we have actual call data
        const call = change?.value?.calls?.[0];
        const contact = change?.value?.contacts?.[0];

        if (!call || !call.id || !call.event) {
            // This is not a call event, silently return (could be message status update)
            return res.sendStatus(200);
        }

        const callId = call.id;
        
        if (call.event === "connect") {
            whatsappOfferSdp = call?.session?.sdp;
            const callerName = contact?.profile?.name || "Unknown";
            const callerNumber = contact?.wa_id || "Unknown";

            console.log(`Incoming WhatsApp call from ${callerName} (${callerNumber})`);
            io.emit("call-is-coming", { callId, callerName, callerNumber });
            
            // Reset call terminated flag for new call
            callTerminated = false;

            // 🆕 CRITICAL: Create a NEW AudioRecorder instance ONLY for new calls
            // Check if this is a new call by comparing with the call ID the AudioRecorder was created for
            if (!audioRecorder || audioRecorderCallId !== callId) {
                audioRecorder = new AudioRecorder(callId, correlationId);
                audioRecorderCallId = callId;
                log(LOG_LEVELS.INFO, `Created NEW AudioRecorder instance for call: ${callId}`);
            } else {
                log(LOG_LEVELS.INFO, `Reusing existing AudioRecorder instance for call: ${callId}`);
            }
            
            // Update current call ID
            currentCallId = callId;
            
            // IMPORTANT: Do not start recording yet. Recording will start after WebRTC audio bridge is confirmed.
            log(LOG_LEVELS.INFO, "Recording will start after audio bridge confirmation");

            // Only initiate bridge if we have browser SDP offer
            if (browserOfferSdp) {
                await initiateWebRTCBridge();
            } else {
                log(LOG_LEVELS.INFO, "Waiting for browser SDP offer before initiating WebRTC bridge");
            }

        } else if (call.event === "terminate") {
            console.log(`WhatsApp call terminated. Call ID: ${callId}`);
            io.emit("call-ended");
            
            // Set call terminated flag
            callTerminated = true;

            if (call.duration && call.status) {
                console.log(`Call duration: ${call.duration}s | Status: ${call.status}`);
            }

            // 🆕 CRITICAL: Stop audio recording immediately when call terminates
            if (audioRecorder && audioRecorder.audioBridgeActive) {
                // Force immediate stop - don't wait for browser
                audioRecorder.audioBridgeActive = false;
                audioRecorder.stopRecording();
                log(LOG_LEVELS.INFO, "📞 Audio recording stopped immediately - call terminated");
                
                // Emit stop signal to browser immediately
                try {
                    io.emit('stop-mic-capture');
                    log(LOG_LEVELS.INFO, '📤 Emitted stop-mic-capture to browser immediately');
        } catch (error) {
                    log(LOG_LEVELS.ERROR, 'Failed to emit stop-mic-capture:', error);
                }
                
                // 🆕 CRITICAL: Don't clear audio data immediately - wait for final recording
                // The final recording contains the actual conversation and needs the accumulated chunks
                log(LOG_LEVELS.INFO, '⏳ Preserving audio data for final recording processing');
                
            } else if (audioRecorder && audioRecorder.isRecording) {
                audioRecorder.stopRecording();
                log(LOG_LEVELS.INFO, "Audio recording stopped, waiting for final browser audio");
            }

        } else if (call.event === "accept") {
            console.log(`WhatsApp call accepted. Call ID: ${callId}`);
            
            // 🆕 CRITICAL: Start audio recording when call is accepted via event
            if (audioRecorder) {
                audioRecorder.audioBridgeActive = true;
                audioRecorder.audioBridgeStartTime = Date.now();
                audioRecorder.startAudioRecordingAfterBridging();
                log(LOG_LEVELS.INFO, '📞 Audio recording started - call accepted via event');
            } else {
                log(LOG_LEVELS.WARN, '⚠️ No AudioRecorder instance available for accept event');
            }
            
            // Request browser to start mic capture
            if (browserSocket) {
                try {
                    browserSocket.emit('start-mic-capture', {
                        audio: {
                            echoCancellation: true,
                            noiseSuppression: true,
                            autoGainControl: true,
                            sampleRate: 8000,
                            channelCount: 1
                        },
                        timesliceMs: 250
                    });
                    log(LOG_LEVELS.INFO, '📞 Requested browser to start mic capture - call accepted via event');
        } catch (error) {
                    log(LOG_LEVELS.ERROR, 'Failed to request browser mic capture:', error);
                }
            }
            
        } else {
            console.log(`Unhandled WhatsApp call event: ${call.event}`);
        }
        
        res.sendStatus(200);
        } catch (error) {
        log(LOG_LEVELS.ERROR, 'Webhook error:', {
            correlationId,
            error: error.message,
            stack: error.stack,
            body: req.body
        });
        console.error('Webhook error details:', error);
        res.sendStatus(500);
    }
});

/**
 * Socket.IO connection from browser client.
 */
io.on("connection", (socket) => {
    const correlationId = generateCorrelationId();
    socket.correlationId = correlationId;
    
    log(LOG_LEVELS.INFO, "Socket.IO connection established", {
        correlationId,
        socketId: socket.id,
        clientIP: getClientIP(socket.handshake),
        userAgent: socket.handshake.headers['user-agent']
    });
    
    // Track active connections
    globalState.activeConnections.add(socket.id);
    
    // Send webhook status to new connections
    if (globalState.webhookStatus) {
        socket.emit("realtime-log", {
            type: globalState.webhookStatus.configured ? "success" : "warning",
            message: globalState.webhookStatus.configured ? 
                "✅ Webhook configured - Ready to receive calls" : 
                "⚠️ Webhook not configured - Testing ongoing ...",
            timestamp: new Date().toISOString(),
            details: globalState.webhookStatus.verification?.reason || ""
        });
    }
    
    // Handle disconnection
    socket.on("disconnect", (reason) => {
        log(LOG_LEVELS.INFO, "Socket.IO connection disconnected", {
            correlationId,
            socketId: socket.id,
            reason
        });
        
        globalState.activeConnections.delete(socket.id);
        
        // Clean up any associated call session
        if (socket.callId) {
            globalState.callSessions.delete(socket.callId);
        }
    });

    // SDP offer from browser
    socket.on("browser-offer", async (sdp) => {
        console.log("Received SDP offer from browser.");
        browserOfferSdp = sdp;
        browserSocket = socket;
        await initiateWebRTCBridge();
    });

    // ICE candidate from browser
    socket.on("browser-candidate", async (candidate) => {
        if (!browserPc) {
            console.warn("Cannot add ICE candidate: browser peer connection not initialized.");
            return;
        }

        try {
            // Handle different candidate formats
            let candidateObj;
            
            if (typeof candidate === 'string') {
                // If it's a string, it might be the full candidate line
                if (candidate.startsWith('candidate:')) {
                    // Remove the 'candidate:' prefix if present
                    candidate = candidate.substring(10);
                }
                // Parse the candidate string into an object
                const parts = candidate.split(' ');
                if (parts.length >= 6) {
                    candidateObj = {
                        candidate: candidate,
                        sdpMid: parts[0] || null,
                        sdpMLineIndex: parseInt(parts[1]) || null
                    };
                } else {
                    console.warn("Invalid ICE candidate format:", candidate);
                    return;
                }
            } else if (typeof candidate === 'object' && candidate.candidate) {
                // If it's already an object with candidate property
                candidateObj = candidate;
            } else {
                console.warn("Unknown ICE candidate format:", candidate);
                return;
            }

            // Validate candidate object before adding
            if (!candidateObj.candidate || candidateObj.candidate.trim() === '') {
                console.warn("Empty or invalid candidate string:", candidateObj);
                return;
            }

            console.log("Adding ICE candidate from browser:", {
                candidate: candidateObj.candidate.substring(0, 50) + '...',
                sdpMid: candidateObj.sdpMid,
                sdpMLineIndex: candidateObj.sdpMLineIndex
            });
            
            await browserPc.addIceCandidate(new RTCIceCandidate(candidateObj));
        } catch (err) {
            console.error("Failed to add ICE candidate from browser:", err);
            console.error("Candidate data:", candidate);
            console.error("Error details:", err.message);
        }
    });

    // Reject call from browser
    socket.on("reject-call", async (callId) => {
        const result = await rejectCall(callId);
        console.log("Reject call response:", result);
    });

    // Terminate call from browser
    socket.on("terminate-call", async (callId) => {
        const result = await terminateCall(callId);
        console.log("Terminate call response:", result);
    });

    // Real audio chunk from browser
    socket.on("real-audio-chunk", (data) => {
        try {
            // 🆕 CRITICAL: Ignore audio chunks after call termination
            if (globalState.callTerminated) {
                log(LOG_LEVELS.WARN, "Ignoring audio chunk - call already terminated", {
                    correlationId: socket.correlationId,
                    callId: data.callId
                });
                return;
            }
            
            // Auto-start recording if we have an audio recorder and call is active but recording hasn't started
            if (audioRecorder && !audioRecorder.isRecording && audioRecorder.audioBridgeActive) {
                log(LOG_LEVELS.INFO, "Auto-starting recording on first audio chunk", {
                    correlationId: socket.correlationId,
                    callId: data.callId,
                    audioBridgeActive: audioRecorder.audioBridgeActive
                });
                audioRecorder.startAudioRecordingAfterBridging();
            }
            
            if (audioRecorder && audioRecorder.isRecording) {
                // Check limits before processing
                if (!audioRecorder.checkLimits()) {
                    log(LOG_LEVELS.WARN, "Audio chunk limit reached, stopping recording", {
                        correlationId: socket.correlationId,
                        callId: audioRecorder.callId
                    });
                    audioRecorder.stopRecording();
                    return;
                }
                
                // 🆕 CRITICAL: Store audio format information for proper WAV creation
                if (!audioRecorder.audioFormat) {
                    audioRecorder.audioFormat = {
                        sampleRate: data.sampleRate || 44100,
                        channels: data.channels || 1,
                        type: data.type || 'pcm'
                    };
                    log(LOG_LEVELS.INFO, "Audio format detected", {
                        correlationId: socket.correlationId,
                        callId: audioRecorder.callId,
                        sampleRate: audioRecorder.audioFormat.sampleRate,
                        channels: audioRecorder.audioFormat.channels,
                        type: audioRecorder.audioFormat.type
                    });
                }
                
                audioRecorder.browserAudioChunks.push(Buffer.from(data.audioData, 'base64'));
                audioRecorder.hasBrowserAudio = true;
                
                // Log only occasionally to reduce noise
                if (audioRecorder.browserAudioChunks.length % 50 === 0) {
                    log(LOG_LEVELS.INFO, "Received real audio chunk", {
                        correlationId: socket.correlationId,
                        callId: audioRecorder.callId,
                        chunkSize: data.size,
                        totalChunks: audioRecorder.browserAudioChunks.length
                    });
                }
            } else {
                // Only log this warning occasionally to avoid spam, but provide more context
                if (!audioRecorder) {
                    log(LOG_LEVELS.WARN, "Audio recorder not available for audio chunk", {
                        correlationId: socket.correlationId,
                        callId: data.callId,
                        hasRecorder: false
                    });
                } else if (!audioRecorder.isRecording) {
                    // Log only every 10th occurrence to reduce spam
                    if (!audioRecorder._warningCount) audioRecorder._warningCount = 0;
                    audioRecorder._warningCount++;
                    
                    if (audioRecorder._warningCount % 10 === 1) {
                        log(LOG_LEVELS.WARN, "Audio recorder exists but not recording - audio chunks being ignored", {
                            correlationId: socket.correlationId,
                            callId: data.callId,
                            hasRecorder: true,
                            isRecording: false,
                            audioBridgeActive: audioRecorder.audioBridgeActive,
                            warningCount: audioRecorder._warningCount,
                            callIdMatch: audioRecorder.callId === data.callId
                        });
                    }
                }
            }
        } catch (error) {
            log(LOG_LEVELS.ERROR, "Error processing real audio chunk", {
                correlationId: socket.correlationId,
                callId: data.callId,
                error: error.message
            });
        }
    });

    // 🆕 Real-time WhatsApp remote audio from browser (PCM base64)
    socket.on("whatsapp-audio-chunk", (data) => {
        try {
            log(LOG_LEVELS.INFO, `📥 Received WhatsApp audio chunk: ${data.size} bytes`, {
                correlationId: socket.correlationId,
                callId: data.callId
            });
            
            // Auto-start recording if we have an audio recorder and call is active but recording hasn't started
            if (audioRecorder && !audioRecorder.isRecording && audioRecorder.audioBridgeActive) {
                log(LOG_LEVELS.INFO, "Auto-starting recording on first WhatsApp audio chunk", {
                    correlationId: socket.correlationId,
                    callId: data.callId,
                    audioBridgeActive: audioRecorder.audioBridgeActive
                });
                audioRecorder.startAudioRecordingAfterBridging();
            }
            
            if (audioRecorder && audioRecorder.isRecording) {
                const audioBuffer = Buffer.from(data.audioData, 'base64');
                // Store as WhatsApp audio (right channel)
                audioRecorder.whatsappAudioChunks.push(audioBuffer);
                audioRecorder.hasWhatsAppAudio = true;
                
                log(LOG_LEVELS.DEBUG, `✅ WhatsApp audio chunk processed successfully`, {
                    correlationId: socket.correlationId,
                    callId: data.callId,
                    totalWhatsAppChunks: audioRecorder.whatsappAudioChunks.length
                });
            } else {
                // Only log this warning occasionally to avoid spam
                if (!audioRecorder) {
                    log(LOG_LEVELS.WARN, "Audio recorder not available for WhatsApp audio chunk", {
                        correlationId: socket.correlationId,
                        callId: data.callId,
                        hasRecorder: false
                    });
                } else if (!audioRecorder.isRecording) {
                    // Log only every 10th occurrence to reduce spam
                    if (!audioRecorder._whatsappWarningCount) audioRecorder._whatsappWarningCount = 0;
                    audioRecorder._whatsappWarningCount++;
                    
                    if (audioRecorder._whatsappWarningCount % 10 === 1) {
                        log(LOG_LEVELS.WARN, "Audio recorder exists but not recording for WhatsApp audio - chunks being ignored", {
                            correlationId: socket.correlationId,
                            callId: data.callId,
                            hasRecorder: true,
                            isRecording: false,
                            audioBridgeActive: audioRecorder.audioBridgeActive,
                            warningCount: audioRecorder._whatsappWarningCount,
                            callIdMatch: audioRecorder.callId === data.callId
                        });
                    }
                }
            }
        } catch (error) {
            log(LOG_LEVELS.ERROR, "Error processing WhatsApp audio chunk", {
                correlationId: socket.correlationId,
                callId: data.callId,
                error: error.message
            });
        }
    });

    // Final audio recording from browser
    socket.on("final-audio-recording", (data) => {
        try {
            // 🆕 CRITICAL: Allow final recording even after call termination (it contains the actual conversation)
            if (callTerminated) {
                log(LOG_LEVELS.INFO, `📥 Processing final audio recording after call termination - this contains the actual conversation`);
            }
            
            log(LOG_LEVELS.INFO, `📥 Received final audio recording: ${data.totalSize} bytes, duration: ${data.duration}s`);
            
            // Prevent duplicate recordings - check if we already saved this call
            const callId = data.callId;
            if (socket.recordingSaved) {
                log(LOG_LEVELS.WARN, `⚠️ Recording already saved for call ${callId}, ignoring duplicate`);
                return;
            }
            
            // Handle final audio even if recording was recently stopped
            if (audioRecorder) {
                let wavFile = null;
                
                // 🆕 CRITICAL: Use real-time chunks instead of final recording to avoid "mic on" sound
                if (audioRecorder.browserAudioChunks.length > 0 || audioRecorder.whatsappAudioChunks.length > 0) {
                    log(LOG_LEVELS.INFO, `🎵 Using real-time audio chunks: ${audioRecorder.browserAudioChunks.length} browser + ${audioRecorder.whatsappAudioChunks.length} WhatsApp chunks`);
                    
                    // Create mixed stereo WAV file with browser on left channel and WhatsApp on right channel
                    log(LOG_LEVELS.INFO, `🎵 Creating mixed stereo recording: ${audioRecorder.browserAudioChunks.length} browser chunks (left) + ${audioRecorder.whatsappAudioChunks.length} WhatsApp chunks (right)`);
                    
                    // Create mixed stereo WAV file (browser=left, WhatsApp=right)
                    wavFile = createMixedStereoWavFile(audioRecorder.browserAudioChunks, audioRecorder.whatsappAudioChunks, audioRecorder.audioFormat);
                } else {
                    // Fallback: use final recording if no real-time chunks available
                    log(LOG_LEVELS.INFO, `🎵 No real-time chunks available, using final recording: ${data.audioData?.length || 0} base64 chars`);
                
                // Temporarily allow adding audio chunks
                const wasRecording = audioRecorder.isRecording;
                audioRecorder.isRecording = true;
                    audioRecorder.browserAudioChunks.push(Buffer.from(data.audioData, 'base64'));
                audioRecorder.isRecording = wasRecording;
                
                    // Create simple WAV file with final recording
                    wavFile = createSimpleWavFile(audioRecorder.browserAudioChunks, audioRecorder.audioFormat);
                }
                if (wavFile) {
                    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                    const filename = `${callId}-${timestamp}.wav`;
                    const filepath = path.join(__dirname, 'call-recordings', filename);
                    
                                            try {
                            fs.writeFileSync(filepath, wavFile);
                            
                            // Also create MP3 version for better compatibility
                            const mp3Filename = filename.replace('.wav', '.mp3');
                            const mp3Filepath = path.join(__dirname, 'call-recordings', mp3Filename);
                            
                            try {
                                // Convert WAV to MP3 using ffmpeg
                                const { execSync } = require('child_process');
                                execSync(`ffmpeg -i "${filepath}" -codec:a libmp3lame -b:a 40k -ar 8000 -ac 2 "${mp3Filepath}" -y`, { stdio: 'ignore' });
                                log(LOG_LEVELS.INFO, `🎵 MP3 version created: ${mp3Filename}`);
                            } catch (ffmpegError) {
                                log(LOG_LEVELS.WARN, `Could not create MP3 version: ${ffmpegError.message}`);
                            }
                            
                            // Mark this recording as saved to prevent duplicates
                            socket.recordingSaved = true;
                            
                            log(LOG_LEVELS.INFO, `🎵 Mixed stereo conversation recording saved: ${filename}`, { 
                                filepath, 
                                fileSize: wavFile.length,
                                duration: `${data.duration}s`,
                                totalSize: data.totalSize,
                                browserChunks: audioRecorder.browserAudioChunks.length,
                                whatsappChunks: audioRecorder.whatsappAudioChunks.length,
                                totalChunks: audioRecorder.browserAudioChunks.length + audioRecorder.whatsappAudioChunks.length,
                                hasBrowserAudio: audioRecorder.hasBrowserAudio,
                                hasWhatsAppAudio: audioRecorder.hasWhatsAppAudio,
                                format: 'stereo (browser=left, whatsapp=right)'
                            });
                            console.log(`✅ Mixed stereo recording saved successfully: ${filename}`);
                            console.log(`📊 Stereo mix - Left (Browser): ${audioRecorder.browserAudioChunks.length} chunks, Right (WhatsApp): ${audioRecorder.whatsappAudioChunks.length} chunks`);
                            
                            // Clean up to prevent memory leaks
                            setTimeout(() => {
                                if (socket.recordingSaved) {
                                    delete socket.recordingSaved;
                                }
                            }, 5000);
                            
                        } catch (error) {
                            log(LOG_LEVELS.ERROR, "❌ Failed to save conversation recording", error);
                        }
                } else {
                    log(LOG_LEVELS.WARN, "❌ No WAV file generated from recording");
                }
                
                // 🆕 CRITICAL: Clear audio data AFTER final recording is processed
                if (audioRecorder) {
                    audioRecorder.clearAllAudioData();
                    log(LOG_LEVELS.INFO, '🧹 Cleared all audio data after final recording');
                }
                
            } else {
                log(LOG_LEVELS.WARN, `❌ Audio recorder not available`);
            }
        } catch (error) {
            log(LOG_LEVELS.ERROR, "Error processing final audio recording:", error);
            console.error("❌ Error processing final audio recording:", error);
        }
    });

    // Accept call from browser
    socket.on("accept-call", async (callId) => {
        try {
            const result = await acceptCall(callId);
            log(LOG_LEVELS.INFO, `Call accepted: ${callId}`);
            console.log("Accept call response:", result);
            
            // 🆕 CRITICAL: Broadcast call acceptance to ALL browsers
            io.emit("call-accepted", { 
                callId: callId, 
                callerName: "WhatsApp User", 
                callerNumber: "Unknown" 
            });
            
            // 🆕 CRITICAL: Start audio recording when call is accepted from browser
            if (audioRecorder) {
                audioRecorder.audioBridgeActive = true;
                audioRecorder.audioBridgeStartTime = Date.now();
                audioRecorder.startAudioRecordingAfterBridging();
                log(LOG_LEVELS.INFO, '📞 Audio recording started - call accepted from browser');
            } else {
                log(LOG_LEVELS.WARN, '⚠️ No AudioRecorder instance available for browser accept');
            }
            
            // Request browser to start mic capture
            try {
                socket.emit('start-mic-capture', {
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true,
                        sampleRate: 8000,
                        channelCount: 1
                    },
                    timesliceMs: 250
                });
                log(LOG_LEVELS.INFO, '📞 Requested browser to start mic capture - call accepted from browser');
            } catch (error) {
                log(LOG_LEVELS.ERROR, 'Failed to request browser mic capture:', error);
            }
            
        } catch (error) {
            log(LOG_LEVELS.ERROR, "Error accepting call:", error);
        }
    });
});

/**
 * Initiates WebRTC between browser and WhatsApp once both SDP offers are received.
 */
async function initiateWebRTCBridge() {
    if (!browserOfferSdp || !whatsappOfferSdp || !browserSocket) return;

    // --- Setup browser peer connection ---
    browserPc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    browserStream = new MediaStream();

    // Monitor WebRTC connection state to detect when bridge ends
    browserPc.onconnectionstatechange = () => {
        console.log(`🎵 Browser peer connection state: ${browserPc.connectionState}`);
        if (browserPc.connectionState === 'failed' || browserPc.connectionState === 'disconnected' || browserPc.connectionState === 'closed') {
            console.log('🛑 Browser WebRTC connection ended - stopping audio bridge');
            if (audioRecorder) {
                audioRecorder.endAudioBridgeAndStopCapture();
            }
        }
    };

    browserPc.ontrack = (event) => {
        console.log("Audio track received from browser.");
        event.streams[0].getTracks().forEach((track) => {
            browserStream.addTrack(track);
        });
    };

    browserPc.onicecandidate = (event) => {
        if (event.candidate) {
            // Convert RTCIceCandidate to plain object for transmission
            const candidateData = {
                candidate: event.candidate.candidate,
                sdpMid: event.candidate.sdpMid,
                sdpMLineIndex: event.candidate.sdpMLineIndex
            };
            browserSocket.emit("browser-candidate", candidateData);
        }
    };

    await browserPc.setRemoteDescription(new RTCSessionDescription({
        type: "offer",
        sdp: browserOfferSdp
    }));
    console.log("Browser offer SDP set as remote description.");

    // --- Setup WhatsApp peer connection ---
    whatsappPc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    // Monitor WhatsApp WebRTC connection state to detect when bridge ends
    whatsappPc.onconnectionstatechange = () => {
        console.log(`🎵 WhatsApp peer connection state: ${whatsappPc.connectionState}`);
        if (whatsappPc.connectionState === 'failed' || whatsappPc.connectionState === 'disconnected' || whatsappPc.connectionState === 'closed') {
            console.log('🛑 WhatsApp WebRTC connection ended - stopping audio bridge');
            if (audioRecorder) {
                audioRecorder.endAudioBridgeAndStopCapture();
            }
        }
    };

    const waTrackPromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject("Timed out waiting for WhatsApp track"), 10000);
        whatsappPc.ontrack = (event) => {
            clearTimeout(timeout);
            console.log("Audio track received from WhatsApp.");
            whatsappStream = event.streams[0];
            resolve();
        };
    });

    await whatsappPc.setRemoteDescription(new RTCSessionDescription({
        type: "offer",
        sdp: whatsappOfferSdp
    }));
    console.log("WhatsApp offer SDP set as remote description.");

    // Forward browser mic to WhatsApp
    browserStream?.getAudioTracks().forEach((track) => {
        whatsappPc.addTrack(track, browserStream);
    });
    console.log("Forwarded browser audio to WhatsApp.");

    // Wait for WhatsApp to send audio
    await waTrackPromise;

    // Forward WhatsApp audio to browser
    whatsappStream?.getAudioTracks().forEach((track) => {
        browserPc.addTrack(track, whatsappStream);
    });

    // WebRTC audio bridging successfully established
    console.log("🎵 WebRTC audio bridge established successfully - ready for audio capture");
    
    // 🆕 CRITICAL: Do NOT start recording here - recording will start when call is accepted
    // The bridge is established but recording only starts when call is actually accepted
    log(LOG_LEVELS.INFO, "🎵 WebRTC bridge ready - audio recording will start when call is accepted");

    // 🆕 CRITICAL: Do NOT start mic capture here - it will start when call is accepted
    // The browser mic capture will be requested when the call is actually accepted
    log(LOG_LEVELS.INFO, '🎵 WebRTC bridge ready - browser mic capture will start when call is accepted');

    // --- Create SDP answers for both peers ---
    const browserAnswer = await browserPc.createAnswer();
    await browserPc.setLocalDescription(browserAnswer);
    browserSocket.emit("browser-answer", browserAnswer.sdp);
    console.log("Browser answer SDP created and sent.");

    const waAnswer = await whatsappPc.createAnswer();
    await whatsappPc.setLocalDescription(waAnswer);
    const finalWaSdp = waAnswer.sdp.replace("a=setup:actpass", "a=setup:active");
    console.log("WhatsApp answer SDP prepared.");

    // Send pre-accept, and only proceed with accept if successful
    const preAcceptSuccess = await answerCallToWhatsApp(currentCallId, finalWaSdp, "pre_accept");

    if (preAcceptSuccess) {
        setTimeout(async () => {
            const acceptSuccess = await answerCallToWhatsApp(currentCallId, finalWaSdp, "accept");
            if (acceptSuccess && browserSocket) {
                browserSocket.emit("start-browser-timer");
            }
        }, 1000);
    } else {
        console.error("Pre-accept failed. Aborting accept step.");
    }

    // Reset session state
    browserOfferSdp = null;
    whatsappOfferSdp = null;
}

/**
 * Sends "pre-accept" or "accept" response with SDP to WhatsApp API.
 */
async function answerCallToWhatsApp(callId, sdp, action) {
    const body = {
        messaging_product: "whatsapp",
        call_id: callId,
        action,
        session: { sdp_type: "answer", sdp },
    };

    try {
        const response = await axios.post(WHATSAPP_API_URL, body, {
            headers: {
                Authorization: ACCESS_TOKEN,
                "Content-Type": "application/json",
            },
            timeout: CONFIG.WHATSAPP_API_TIMEOUT
        });

        const success = response.data?.success === true;

        if (success) {
            log(LOG_LEVELS.INFO, `Successfully sent '${action}' to WhatsApp`, {
                callId,
                action,
                responseStatus: response.status
            });
            return true;
        } else {
            log(LOG_LEVELS.WARN, `WhatsApp '${action}' response was not successful`, {
                callId,
                action,
                responseData: response.data
            });
            return false;
        }
    } catch (error) {
        log(LOG_LEVELS.ERROR, `Failed to send '${action}' to WhatsApp`, {
            callId,
            action,
            error: error.message,
            isTimeout: error.code === 'ECONNABORTED',
            statusCode: error.response?.status
        });
        return false;
    }
}

/**
 * Rejects the current WhatsApp call.
 */
async function rejectCall(callId) {
    const body = {
        messaging_product: "whatsapp",
        call_id: callId,
        action: "reject",
    };

    try {
        const response = await axios.post(WHATSAPP_API_URL, body, {
            headers: {
                Authorization: ACCESS_TOKEN,
                "Content-Type": "application/json",
            },
        });

        const success = response.data?.success === true;

        if (success) {
            console.log(`Call ${callId} successfully rejected.`);
        } else {
            console.warn(`Call ${callId} reject response was not successful.`);
        }

        return response.data;
    } catch (error) {
        console.error(`Failed to reject call ${callId}:`, error.message);
        return { success: false, error: error.message };
    }
}

/**
 * Terminate WhatsApp call.
 */
 async function terminateCall(callId) {
    const body = {
        messaging_product: "whatsapp",
        call_id: callId,
        action: "terminate",
    };

    try {
        const response = await axios.post(WHATSAPP_API_URL, body, {
            headers: {
                Authorization: ACCESS_TOKEN,
                "Content-Type": "application/json",
            },
        });

        const success = response.data?.success === true;

        if (success) {
            console.log(`Call ${callId} successfully terminated.`);
        } else {
            console.warn(`Call ${callId} terminate response was not successful.`);
        }

        return response.data;
    } catch (error) {
        console.error(`Failed to terminate call ${callId}:`, error.message);
        return { success: false, error: error.message };
    }
}

/**
 * Accept WhatsApp call.
 */
async function acceptCall(callId) {
    const body = {
        messaging_product: "whatsapp",
        call_id: callId,
        action: "accept",
    };

    try {
        const response = await axios.post(WHATSAPP_API_URL, body, {
            headers: {
                Authorization: ACCESS_TOKEN,
                "Content-Type": "application/json",
            },
        });

        const success = response.data?.success === true;

        if (success) {
            console.log(`Call ${callId} successfully accepted.`);
        } else {
            console.warn(`Call ${callId} accept response was not successful.`);
        }

        return response.data;
    } catch (error) {
        console.error(`Failed to accept call ${callId}:`, error.message);
        return { success: false, error: error.message };
    }
}

/**
 * Mix browser and WhatsApp audio chunks into stereo WAV file
 * Browser audio goes to left channel, WhatsApp audio goes to right channel
 */
function createMixedStereoWavFile(browserChunks, whatsappChunks, audioFormat = null) {
    try {
        if ((!browserChunks || browserChunks.length === 0) && (!whatsappChunks || whatsappChunks.length === 0)) {
            return null;
        }

        // Use detected audio format or default to 44.1kHz 16-bit
        const sampleRate = audioFormat?.sampleRate || 44100;
        const bitsPerSample = 16;
        const bytesPerSample = bitsPerSample / 8;
        
        // Combine browser audio (left channel)
        const browserAudio = browserChunks && browserChunks.length > 0 ? Buffer.concat(browserChunks) : Buffer.alloc(0);
        
        // Combine WhatsApp audio (right channel)  
        const whatsappAudio = whatsappChunks && whatsappChunks.length > 0 ? Buffer.concat(whatsappChunks) : Buffer.alloc(0);
        
        // Calculate the maximum length to ensure both channels are the same length
        const maxLength = Math.max(browserAudio.length, whatsappAudio.length);
        
        // If one audio source is longer, pad the shorter one with silence
        const paddedBrowserAudio = Buffer.alloc(maxLength);
        const paddedWhatsappAudio = Buffer.alloc(maxLength);
        
        browserAudio.copy(paddedBrowserAudio, 0, 0, Math.min(browserAudio.length, maxLength));
        whatsappAudio.copy(paddedWhatsappAudio, 0, 0, Math.min(whatsappAudio.length, maxLength));
        
        // Create stereo audio by interleaving left and right channels
        const stereoAudio = Buffer.alloc(maxLength * 2); // Stereo = 2 channels
        
        for (let i = 0; i < maxLength; i += bytesPerSample) {
            // Left channel (browser audio)
            stereoAudio.writeInt16LE(paddedBrowserAudio.readInt16LE(i), i * 2);
            // Right channel (WhatsApp audio)  
            stereoAudio.writeInt16LE(paddedWhatsappAudio.readInt16LE(i), i * 2 + bytesPerSample);
        }
        
        const dataSize = stereoAudio.length;
        const channels = 2; // Stereo
        const byteRate = sampleRate * channels * bytesPerSample;
        const blockAlign = channels * bytesPerSample;
        
        log(LOG_LEVELS.INFO, `🎵 Creating mixed stereo WAV file: ${sampleRate}Hz, ${channels} channels, ${bitsPerSample}-bit, ${dataSize} bytes`, {
            browserChunks: browserChunks?.length || 0,
            whatsappChunks: whatsappChunks?.length || 0,
            browserAudioLength: browserAudio.length,
            whatsappAudioLength: whatsappAudio.length,
            finalLength: maxLength
        });
        
        // WAV header for stereo
        const header = Buffer.alloc(44);
        header.write('RIFF', 0);
        header.writeUInt32LE(36 + dataSize, 4);
        header.write('WAVE', 8);
        header.write('fmt ', 12);
        header.writeUInt32LE(16, 16);
        header.writeUInt16LE(1, 20); // PCM format
        header.writeUInt16LE(channels, 22); // Stereo channels
        header.writeUInt32LE(sampleRate, 24); // Sample rate
        header.writeUInt32LE(byteRate, 28); // Byte rate
        header.writeUInt16LE(blockAlign, 32); // Block align
        header.writeUInt16LE(bitsPerSample, 34); // Bits per sample
        header.write('data', 36);
        header.writeUInt32LE(dataSize, 40);
        
        return Buffer.concat([header, stereoAudio]);
    } catch (error) {
        log(LOG_LEVELS.ERROR, 'Error creating mixed stereo WAV file:', error);
        return null;
    }
}

/**
 * Create a simple WAV file from audio chunks (fallback for single source)
 */
function createSimpleWavFile(audioChunks, audioFormat = null) {
    try {
        if (!audioChunks || audioChunks.length === 0) {
            return null;
        }

        // Combine all audio chunks
        const combinedAudio = Buffer.concat(audioChunks);
        const dataSize = combinedAudio.length;
        
        // Use detected audio format or default to 44.1kHz mono 16-bit
        const sampleRate = audioFormat?.sampleRate || 44100;
        const channels = audioFormat?.channels || 1;
        const bitsPerSample = 16;
        const byteRate = sampleRate * channels * (bitsPerSample / 8);
        const blockAlign = channels * (bitsPerSample / 8);
        
        log(LOG_LEVELS.INFO, `🎵 Creating WAV file: ${sampleRate}Hz, ${channels} channel(s), ${bitsPerSample}-bit, ${dataSize} bytes`);
        
        // WAV header
        const header = Buffer.alloc(44);
        header.write('RIFF', 0);
        header.writeUInt32LE(36 + dataSize, 4);
        header.write('WAVE', 8);
        header.write('fmt ', 12);
        header.writeUInt32LE(16, 16);
        header.writeUInt16LE(1, 20); // PCM format
        header.writeUInt16LE(channels, 22); // Channels
        header.writeUInt32LE(sampleRate, 24); // Sample rate
        header.writeUInt32LE(byteRate, 28); // Byte rate
        header.writeUInt16LE(blockAlign, 32); // Block align
        header.writeUInt16LE(bitsPerSample, 34); // Bits per sample
        header.write('data', 36);
        header.writeUInt32LE(dataSize, 40);
        
        return Buffer.concat([header, combinedAudio]);
    } catch (error) {
        log(LOG_LEVELS.ERROR, 'Error creating simple WAV file:', error);
        return null;
    }
}

// Graceful shutdown handling
function gracefulShutdown(signal) {
    log(LOG_LEVELS.INFO, `${signal} received, shutting down gracefully`);
    
    // Close server with timeout
    const timeout = setTimeout(() => {
        log(LOG_LEVELS.WARN, 'Force closing server after timeout');
        process.exit(1);
    }, 5000); // 5 second timeout
    
    // Close Socket.IO server first
    if (io) {
        io.close(() => {
            log(LOG_LEVELS.INFO, 'Socket.IO server closed');
        });
    }
    
    server.close(() => {
        clearTimeout(timeout);
        log(LOG_LEVELS.INFO, 'Server closed');
        process.exit(0);
    });
    
    // Force close all connections
    server.getConnections((err, count) => {
        if (err) {
            log(LOG_LEVELS.ERROR, 'Error getting connections:', err);
            return;
        }
        log(LOG_LEVELS.INFO, `Closing ${count} active connections`);
    });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Unhandled error handling
process.on('uncaughtException', (error) => {
    log(LOG_LEVELS.ERROR, 'Uncaught exception', { error: error.message, stack: error.stack });
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    log(LOG_LEVELS.ERROR, 'Unhandled rejection', { reason: reason?.message || reason, promise });
});

// Function to verify webhook configuration with WhatsApp
async function verifyWebhookConfiguration() {
    try {
        const phoneNumberId = process.env.PHONE_NUMBER_ID;
        const accessToken = process.env.ACCESS_TOKEN;
        
        if (!phoneNumberId || !accessToken) {
            return { configured: false, reason: 'Missing environment variables' };
        }
        
        // Try to get app info to check webhook configuration
        // The webhook URL is configured at the app level, not phone number level
        const response = await axios.get(`https://graph.facebook.com/v18.0/me`, {
            params: {
                fields: 'id,name',
                access_token: accessToken
            },
            timeout: 5000
        });
        
        // If we can successfully connect to the API, we still can't verify webhook URL
        // The webhook URL is configured at the app level and we can't query it directly
        if (response.data && response.data.id) {
            return { 
                configured: false, 
                reason: 'API connected but webhook URL verification not possible - configure webhook to receive calls' 
            };
        } else {
            return { configured: false, reason: 'Failed to connect to WhatsApp API' };
        }
    } catch (error) {
        // If it's an authentication error, webhook is definitely not configured
        if (error.response?.status === 401 || error.response?.status === 403) {
            return { configured: false, reason: 'Invalid access token - webhook not configured' };
        }
        // For other errors, assume webhook is not configured
        return { configured: false, reason: `API connection failed: ${error.message}` };
    }
}

// Start the server
server.listen(CONFIG.PORT, "0.0.0.0", async () => {
    // Check webhook configuration status
    const webhookUrl = `http://localhost:${CONFIG.PORT}/webhook`;
    const envVarsConfigured = !!(process.env.PHONE_NUMBER_ID && process.env.ACCESS_TOKEN && process.env.VERIFY_TOKEN);
    
    // Verify webhook with WhatsApp
    const webhookVerification = await verifyWebhookConfiguration();
    const webhookFullyConfigured = envVarsConfigured && webhookVerification.configured;
    
    // Store webhook status in global state for new connections
    globalState.webhookStatus = {
        configured: webhookFullyConfigured,
        verification: webhookVerification
    };
    
    console.log(`📊 Webhook Status: ${webhookFullyConfigured ? '✅ READY' : '❌ NOT CONFIGURED'}`);
    console.log(`${webhookFullyConfigured ? '🎉 Ready to receive WhatsApp calls!' : '⚠️  Configure webhook settings to enable call handling'}\n`);
    
    // Emit webhook status to all connected clients
    if (!webhookFullyConfigured) {
        io.emit("realtime-log", {
            type: "warning",
            message: "Webhook not configured - Testing ongoing ...",
            timestamp: new Date().toISOString(),
            details: webhookVerification.reason
        });
    }
});
