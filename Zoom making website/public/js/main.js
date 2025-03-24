import {
    auth,
    db,
    storage,
    rtdb,
    signInWithGoogle,
    signInWithEmail,
    registerWithEmail,
    createMeeting,
    joinMeeting,
    sendChatMessage,
    sendReaction,
    uploadFile,
    startRecording
} from './firebase-config.js';

// WebRTC Configuration
const configuration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        {
            urls: 'turn:your-turn-server.com',
            username: 'username',
            credential: 'credential'
        }
    ],
    iceCandidatePoolSize: 10
};

// Global variables
let socket;
let localStream;
let peerConnections = {};
let currentUser = null;
let currentMeetingId = null;
let screenStream = null;
let mediaRecorder;
let virtualBackground = false;
let backgroundBlur = false;
let transcriptionEnabled = false;

// DOM Elements
const authContainer = document.getElementById('auth-container');
const meetingContainer = document.getElementById('meeting-container');
const videoGrid = document.getElementById('video-grid');
const participantsList = document.getElementById('participants-list');
const chatMessages = document.getElementById('chat-messages');
const messageInput = document.getElementById('message-input');
const joinModal = document.getElementById('join-modal');
const waitingRoomList = document.getElementById('waiting-room-list');

// Authentication
document.querySelectorAll('.tab-btn').forEach(button => {
    button.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
        button.classList.add('active');
        document.querySelectorAll('.auth-form').forEach(form => form.classList.add('hidden'));
        document.getElementById(`${button.dataset.tab}-form`).classList.remove('hidden');
    });
});

document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = e.target[0].value;
    const password = e.target[1].value;

    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });

        const data = await response.json();
        if (response.ok) {
            currentUser = data.user;
            localStorage.setItem('token', data.token);
            showMeetingInterface();
        } else {
            alert(data.error);
        }
    } catch (error) {
        console.error('Login error:', error);
        alert('Login failed');
    }
});

document.getElementById('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = e.target[0].value;
    const email = e.target[1].value;
    const password = e.target[2].value;

    try {
        const response = await fetch('/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, email, password })
        });

        const data = await response.json();
        if (response.ok) {
            alert('Registration successful! Please login.');
            document.querySelector('[data-tab="login"]').click();
            e.target.reset();
        } else {
            alert(data.error);
        }
    } catch (error) {
        console.error('Registration error:', error);
        alert('Registration failed');
    }
});

// Meeting Interface
function showMeetingInterface() {
    authContainer.classList.add('hidden');
    meetingContainer.classList.remove('hidden');
    initializeSocket();
    showJoinModal();
}

function showJoinModal() {
    joinModal.classList.remove('hidden');
}

document.getElementById('join-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const meetingCode = document.getElementById('meeting-code').value;
    await joinMeeting(meetingCode);
});

document.getElementById('create-meeting').addEventListener('click', async () => {
    try {
        const response = await fetch('/api/meetings', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('token')}`
            }
        });
        const data = await response.json();
        if (response.ok) {
            await joinMeeting(data.meetingId);
        }
    } catch (error) {
        console.error('Create meeting error:', error);
        alert('Failed to create meeting');
    }
});

async function joinMeeting(meetingId) {
    currentMeetingId = meetingId;
    joinModal.classList.add('hidden');
    document.getElementById('meeting-id').textContent = `Meeting ID: ${meetingId}`;
    
    try {
        await initializeMedia();
        socket.emit('join-meeting', { meetingId, userId: currentUser.id });
    } catch (error) {
        console.error('Join meeting error:', error);
        alert('Failed to join meeting');
    }
}

// WebRTC Setup
async function initializeMedia() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: true
        });
        addVideoStream(localStream, currentUser.id);
        
        // Set up audio analysis for active speaker detection
        setupAudioAnalysis(localStream);
        
        // Initialize virtual background if supported
        if (typeof bodyPix !== 'undefined') {
            await initializeVirtualBackground();
        }
    } catch (error) {
        console.error('Media initialization error:', error);
        throw error;
    }
}

function addVideoStream(stream, userId) {
    const videoContainer = document.createElement('div');
    videoContainer.className = 'video-container';
    videoContainer.id = `video-${userId}`;

    const video = document.createElement('video');
    video.srcObject = stream;
    video.autoplay = true;
    video.playsInline = true;

    videoContainer.appendChild(video);
    videoGrid.appendChild(videoContainer);
}

// Socket.IO Setup
function initializeSocket() {
    socket = io();

    socket.on('participant-joined', async ({ userId }) => {
        createPeerConnection(userId);
    });

    socket.on('offer', async ({ offer, userId }) => {
        const pc = peerConnections[userId];
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('answer', { meetingId: currentMeetingId, answer, userId: currentUser.id });
    });

    socket.on('answer', async ({ answer, userId }) => {
        const pc = peerConnections[userId];
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
    });

    socket.on('ice-candidate', async ({ candidate, userId }) => {
        const pc = peerConnections[userId];
        if (pc) {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
        }
    });

    socket.on('participant-left', ({ userId }) => {
        const videoContainer = document.getElementById(`video-${userId}`);
        if (videoContainer) {
            videoContainer.remove();
        }
        if (peerConnections[userId]) {
            peerConnections[userId].close();
            delete peerConnections[userId];
        }
    });

    socket.on('chat-message', ({ message, userId }) => {
        addChatMessage(message, userId);
    });
}

function createPeerConnection(userId) {
    const pc = new RTCPeerConnection(configuration);
    peerConnections[userId] = pc;
    
    localStream.getTracks().forEach(track => {
        pc.addTrack(track, localStream);
    });
    
    pc.onicecandidate = event => {
        if (event.candidate) {
            socket.emit('ice-candidate', {
                meetingId: currentMeetingId,
                candidate: event.candidate,
                userId: currentUser.id
            });
        }
    };
    
    pc.ontrack = event => {
        const stream = event.streams[0];
        addVideoStream(stream, userId);
    };

    // Create and send offer
    pc.createOffer()
        .then(offer => pc.setLocalDescription(offer))
        .then(() => {
            socket.emit('offer', {
                meetingId: currentMeetingId,
                offer: pc.localDescription,
                userId: currentUser.id
            });
        });

    return pc;
}

// UI Controls
document.getElementById('toggle-audio').addEventListener('click', () => {
    const audioTrack = localStream.getAudioTracks()[0];
    audioTrack.enabled = !audioTrack.enabled;
    this.classList.toggle('active');
});

document.getElementById('toggle-video').addEventListener('click', () => {
    const videoTrack = localStream.getVideoTracks()[0];
    videoTrack.enabled = !videoTrack.enabled;
    this.classList.toggle('active');
});

document.getElementById('toggle-screen').addEventListener('click', async () => {
    if (!screenStream) {
        try {
            screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
            const videoTrack = screenStream.getVideoTracks()[0];
            Object.values(peerConnections).forEach(pc => {
                const sender = pc.getSenders().find(s => s.track.kind === 'video');
                if (sender) {
                    sender.replaceTrack(videoTrack);
                }
            });
            this.classList.add('active');
        } catch (error) {
            console.error('Screen sharing error:', error);
        }
    } else {
        screenStream.getTracks().forEach(track => track.stop());
        screenStream = null;
        const videoTrack = localStream.getVideoTracks()[0];
        Object.values(peerConnections).forEach(pc => {
            const sender = pc.getSenders().find(s => s.track.kind === 'video');
            if (sender) {
                sender.replaceTrack(videoTrack);
            }
        });
        this.classList.remove('active');
    }
});

document.getElementById('leave-meeting').addEventListener('click', () => {
    if (currentMeetingId) {
        socket.emit('leave-meeting', { meetingId: currentMeetingId, userId: currentUser.id });
        localStream.getTracks().forEach(track => track.stop());
        if (screenStream) {
            screenStream.getTracks().forEach(track => track.stop());
        }
        Object.values(peerConnections).forEach(pc => pc.close());
        peerConnections = {};
        videoGrid.innerHTML = '';
        currentMeetingId = null;
        showJoinModal();
    }
});

// Chat functionality
document.getElementById('send-message').addEventListener('click', sendMessage);
messageInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        sendMessage();
    }
});

function sendMessage() {
    const message = messageInput.value.trim();
    if (message && currentMeetingId) {
        socket.emit('chat-message', {
            meetingId: currentMeetingId,
            message,
            userId: currentUser.id
        });
        addChatMessage(message, currentUser.id);
        messageInput.value = '';
    }
}

function addChatMessage(message, userId) {
    const messageElement = document.createElement('div');
    messageElement.className = `chat-message ${userId === currentUser.id ? 'own-message' : ''}`;
    messageElement.innerHTML = `
        <span class="message-sender">${userId === currentUser.id ? 'You' : 'User ' + userId}</span>
        <p>${message}</p>
    `;
    chatMessages.appendChild(messageElement);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Check for existing session
const token = localStorage.getItem('token');
if (token) {
    try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        currentUser = {
            id: payload.id,
            email: payload.email
        };
        showMeetingInterface();
    } catch (error) {
        localStorage.removeItem('token');
    }
}

// Virtual background processing
async function initializeVirtualBackground() {
    const net = await bodyPix.load();
    const videoElement = document.createElement('video');
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    async function processFrame() {
        if (virtualBackground || backgroundBlur) {
            const segmentation = await net.segmentPerson(videoElement);
            const backgroundImage = virtualBackground ? await loadImage('path/to/background.jpg') : null;
            
            ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            
            for (let i = 0; i < imageData.data.length; i += 4) {
                if (segmentation.data[i / 4] === 0) {
                    if (virtualBackground && backgroundImage) {
                        const bgPixel = getBackgroundPixel(backgroundImage, i);
                        imageData.data.set(bgPixel, i);
                    } else if (backgroundBlur) {
                        applyBlur(imageData.data, i);
                    }
                }
            }
            
            ctx.putImageData(imageData, 0, 0);
        }
        
        requestAnimationFrame(processFrame);
    }
    
    processFrame();
}

// Active speaker detection
function setupAudioAnalysis(stream) {
    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    const microphone = audioContext.createMediaStreamSource(stream);
    microphone.connect(analyser);
    
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    
    function checkAudioLevel() {
        analyser.getByteFrequencyData(dataArray);
        const audioLevel = dataArray.reduce((acc, val) => acc + val) / dataArray.length;
        
        if (audioLevel > 50) {
            highlightActiveSpeaker(currentUser.id);
        }
        
        requestAnimationFrame(checkAudioLevel);
    }
    
    checkAudioLevel();
}

// Utility functions
function highlightActiveSpeaker(userId) {
    const videoContainers = document.querySelectorAll('.video-container');
    videoContainers.forEach(container => {
        container.classList.remove('active-speaker');
        if (container.dataset.userId === userId) {
            container.classList.add('active-speaker');
        }
    });
}

// Meeting controls
async function createNewMeeting(settings) {
    const meetingId = await createMeeting(currentUser.id, settings);
    currentMeetingId = meetingId;
    
    setupMeetingRoom();
}

async function joinExistingMeeting(meetingId, password) {
    const status = await joinMeeting(meetingId, currentUser.id, currentUser.displayName, password);
    
    if (status === 'waiting') {
        showWaitingRoom();
    } else {
        currentMeetingId = meetingId;
        setupMeetingRoom();
    }
}

// Recording and transcription
async function toggleRecording() {
    if (!mediaRecorder) {
        const stream = await getStreamForRecording();
        mediaRecorder = await startRecording(currentMeetingId, stream);
    } else {
        mediaRecorder.stop();
        mediaRecorder = null;
    }
}

async function toggleTranscription() {
    if (!transcriptionEnabled) {
        const recognition = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
        recognition.continuous = true;
        recognition.interimResults = true;
        
        recognition.onresult = event => {
            const transcript = Array.from(event.results)
                .map(result => result[0].transcript)
                .join('');
            
            updateTranscription(transcript);
        };
        
        recognition.start();
        transcriptionEnabled = true;
    } else {
        recognition.stop();
        transcriptionEnabled = false;
    }
}

// Initialize the app
async function initializeApp() {
    // Set up authentication listeners
    auth.onAuthStateChanged(handleAuthStateChange);
    
    // Set up meeting listeners
    setupMeetingListeners();
    
    // Initialize WebRTC
    await initializeWebRTC();
}

// Authentication handlers
async function handleAuthStateChange(user) {
    if (user) {
        currentUser = user;
        showMeetingInterface();
    } else {
        showAuthInterface();
    }
}

// Meeting initialization
async function initializeWebRTC() {
    try {
        await initializeMedia();
    } catch (error) {
        console.error('Error accessing media devices:', error);
    }
}

// Meeting controls
async function setupMeetingRoom() {
    // Implementation of setupMeetingRoom function
}

async function showWaitingRoom() {
    // Implementation of showWaitingRoom function
}

async function getStreamForRecording() {
    // Implementation of getStreamForRecording function
}

async function updateTranscription(transcript) {
    // Implementation of updateTranscription function
}

// Initialize the app
initializeApp(); 