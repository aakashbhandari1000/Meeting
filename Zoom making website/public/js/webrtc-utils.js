// WebRTC Configuration
const configuration = {
    iceServers: [
        {
            urls: [
                'stun:stun1.l.google.com:19302',
                'stun:stun2.l.google.com:19302'
            ]
        }
    ],
    iceCandidatePoolSize: 10
};

// Media Constraints
const defaultMediaConstraints = {
    audio: true,
    video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 }
    }
};

class WebRTCClient {
    constructor(roomId, userId, firebaseRTDB) {
        this.roomId = roomId;
        this.userId = userId;
        this.rtdb = firebaseRTDB;
        this.peerConnections = new Map();
        this.localStream = null;
        this.remoteStreams = new Map();
        this.screenStream = null;
        this.isScreenSharing = false;
        
        // Bind methods
        this.createPeerConnection = this.createPeerConnection.bind(this);
        this.handleNegotiationNeeded = this.handleNegotiationNeeded.bind(this);
        this.handleICECandidate = this.handleICECandidate.bind(this);
        this.handleTrackEvent = this.handleTrackEvent.bind(this);
        this.handleICEConnectionStateChange = this.handleICEConnectionStateChange.bind(this);
    }

    // Initialize local media stream
    async initializeLocalStream(constraints = defaultMediaConstraints) {
        try {
            this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
            return this.localStream;
        } catch (error) {
            console.error('Error accessing media devices:', error);
            throw error;
        }
    }

    // Start screen sharing
    async startScreenSharing() {
        try {
            this.screenStream = await navigator.mediaDevices.getDisplayMedia({
                video: true,
                audio: true
            });
            
            // Replace video track in all peer connections
            const videoTrack = this.screenStream.getVideoTracks()[0];
            for (let [peerId, pc] of this.peerConnections) {
                const sender = pc.getSenders().find(s => s.track.kind === 'video');
                if (sender) {
                    sender.replaceTrack(videoTrack);
                }
            }
            
            this.isScreenSharing = true;
            
            // Handle screen sharing stop
            videoTrack.onended = () => {
                this.stopScreenSharing();
            };
            
            return this.screenStream;
        } catch (error) {
            console.error('Error starting screen share:', error);
            throw error;
        }
    }

    // Stop screen sharing
    async stopScreenSharing() {
        if (this.screenStream) {
            this.screenStream.getTracks().forEach(track => track.stop());
            
            // Revert to camera video in all peer connections
            const videoTrack = this.localStream.getVideoTracks()[0];
            for (let [peerId, pc] of this.peerConnections) {
                const sender = pc.getSenders().find(s => s.track.kind === 'video');
                if (sender) {
                    sender.replaceTrack(videoTrack);
                }
            }
            
            this.isScreenSharing = false;
            this.screenStream = null;
        }
    }

    // Create a new peer connection
    async createPeerConnection(remoteUserId) {
        const peerConnection = new RTCPeerConnection(configuration);
        
        // Add local tracks to the peer connection
        this.localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, this.localStream);
        });

        // Handle ICE candidates
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                this.handleICECandidate(event.candidate, remoteUserId);
            }
        };

        // Handle incoming tracks
        peerConnection.ontrack = (event) => {
            this.handleTrackEvent(event, remoteUserId);
        };

        // Handle connection state changes
        peerConnection.oniceconnectionstatechange = () => {
            this.handleICEConnectionStateChange(peerConnection, remoteUserId);
        };

        // Handle negotiation needed
        peerConnection.onnegotiationneeded = () => {
            this.handleNegotiationNeeded(peerConnection, remoteUserId);
        };

        this.peerConnections.set(remoteUserId, peerConnection);
        return peerConnection;
    }

    // Handle ICE candidate events
    async handleICECandidate(candidate, remoteUserId) {
        try {
            await this.rtdb.ref(`rooms/${this.roomId}/candidates/${this.userId}_${remoteUserId}`).push(candidate);
        } catch (error) {
            console.error('Error handling ICE candidate:', error);
        }
    }

    // Handle incoming tracks
    handleTrackEvent(event, remoteUserId) {
        if (!this.remoteStreams.has(remoteUserId)) {
            this.remoteStreams.set(remoteUserId, new MediaStream());
        }
        const remoteStream = this.remoteStreams.get(remoteUserId);
        event.streams[0].getTracks().forEach(track => {
            remoteStream.addTrack(track);
        });
        
        // Dispatch event for UI update
        window.dispatchEvent(new CustomEvent('remoteStreamUpdated', {
            detail: { userId: remoteUserId, stream: remoteStream }
        }));
    }

    // Handle ICE connection state changes
    handleICEConnectionStateChange(peerConnection, remoteUserId) {
        console.log(`ICE connection state with ${remoteUserId}:`, peerConnection.iceConnectionState);
        
        if (peerConnection.iceConnectionState === 'disconnected' || 
            peerConnection.iceConnectionState === 'failed' ||
            peerConnection.iceConnectionState === 'closed') {
            this.handlePeerDisconnection(remoteUserId);
        }
    }

    // Handle peer disconnection
    handlePeerDisconnection(remoteUserId) {
        if (this.peerConnections.has(remoteUserId)) {
            this.peerConnections.get(remoteUserId).close();
            this.peerConnections.delete(remoteUserId);
        }
        if (this.remoteStreams.has(remoteUserId)) {
            this.remoteStreams.delete(remoteUserId);
            // Dispatch event for UI update
            window.dispatchEvent(new CustomEvent('peerDisconnected', {
                detail: { userId: remoteUserId }
            }));
        }
    }

    // Handle negotiation needed events
    async handleNegotiationNeeded(peerConnection, remoteUserId) {
        try {
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            
            const roomRef = this.rtdb.ref(`rooms/${this.roomId}`);
            await roomRef.child(`offers/${this.userId}_${remoteUserId}`).set({
                type: offer.type,
                sdp: offer.sdp
            });
        } catch (error) {
            console.error('Error during negotiation:', error);
        }
    }

    // Process remote ICE candidates
    async processICECandidate(candidate) {
        try {
            await this.peerConnection.addIceCandidate(candidate);
        } catch (error) {
            console.error('Error adding ICE candidate:', error);
        }
    }

    // Process remote session description
    async processRemoteDescription(description) {
        try {
            await this.peerConnection.setRemoteDescription(description);
            if (description.type === 'offer') {
                const answer = await this.peerConnection.createAnswer();
                await this.peerConnection.setLocalDescription(answer);
                return answer;
            }
        } catch (error) {
            console.error('Error processing remote description:', error);
        }
    }

    // Clean up resources
    cleanup() {
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
        }
        if (this.screenStream) {
            this.screenStream.getTracks().forEach(track => track.stop());
        }
        this.peerConnections.forEach(pc => pc.close());
        this.peerConnections.clear();
        this.remoteStreams.clear();
    }
}

// Virtual Background Processing
class VirtualBackground {
    constructor() {
        this.isEnabled = false;
        this.backgroundImage = null;
        this.processor = null;
    }

    async initialize() {
        if (!this.processor) {
            // Load TensorFlow.js and BodyPix model
            await this.loadDependencies();
            this.processor = await bodyPix.load({
                architecture: 'MobileNetV1',
                outputStride: 16,
                multiplier: 0.75,
                quantBytes: 2
            });
        }
    }

    async loadDependencies() {
        // Load TensorFlow.js and BodyPix dynamically
        const scripts = [
            'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@3.11.0/dist/tf.min.js',
            'https://cdn.jsdelivr.net/npm/@tensorflow-models/body-pix@2.2.0/dist/body-pix.min.js'
        ];

        for (const src of scripts) {
            await new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = src;
                script.onload = resolve;
                script.onerror = reject;
                document.head.appendChild(script);
            });
        }
    }

    async processFrame(inputCanvas, outputCanvas, backgroundImage = null) {
        if (!this.isEnabled) return;

        const segmentation = await this.processor.segmentPerson(inputCanvas);
        const foregroundColor = { r: 0, g: 0, b: 0, a: 0 };
        const backgroundColor = { r: 255, g: 255, b: 255, a: 255 };
        const backgroundDarkeningMask = bodyPix.toMask(
            segmentation,
            foregroundColor,
            backgroundColor
        );

        const ctx = outputCanvas.getContext('2d');
        if (backgroundImage) {
            ctx.drawImage(backgroundImage, 0, 0, outputCanvas.width, outputCanvas.height);
        } else {
            ctx.fillStyle = 'black';
            ctx.fillRect(0, 0, outputCanvas.width, outputCanvas.height);
        }

        const imageData = ctx.getImageData(0, 0, outputCanvas.width, outputCanvas.height);
        const pixel = imageData.data;
        for (let i = 0; i < pixel.length; i += 4) {
            const mask = backgroundDarkeningMask.data[i / 4];
            if (mask === 0) {
                const frame = inputCanvas.getContext('2d').getImageData(
                    (i / 4) % outputCanvas.width,
                    Math.floor((i / 4) / outputCanvas.width),
                    1,
                    1
                );
                pixel[i] = frame.data[0];
                pixel[i + 1] = frame.data[1];
                pixel[i + 2] = frame.data[2];
                pixel[i + 3] = frame.data[3];
            }
        }
        ctx.putImageData(imageData, 0, 0);
    }

    setBackground(imageUrl) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                this.backgroundImage = img;
                resolve();
            };
            img.onerror = reject;
            img.src = imageUrl;
        });
    }

    toggle() {
        this.isEnabled = !this.isEnabled;
        return this.isEnabled;
    }
}

// Export the classes and configurations
export {
    WebRTCClient,
    VirtualBackground,
    configuration,
    defaultMediaConstraints
}; 