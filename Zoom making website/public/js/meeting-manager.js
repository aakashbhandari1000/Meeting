import { WebRTCClient, VirtualBackground } from './webrtc-utils.js';

class MeetingManager {
    constructor(roomId, userId, firebaseRTDB, firestore) {
        this.roomId = roomId;
        this.userId = userId;
        this.rtdb = firebaseRTDB;
        this.firestore = firestore;
        this.webrtc = new WebRTCClient(roomId, userId, firebaseRTDB);
        this.virtualBackground = new VirtualBackground();
        this.participants = new Map();
        this.isHost = false;
        this.isRecording = false;
        this.mediaRecorder = null;
        this.recordedChunks = [];
        this.transcriptionEnabled = false;
        this.transcriptionWorker = null;

        // Bind methods
        this.initialize = this.initialize.bind(this);
        this.joinMeeting = this.joinMeeting.bind(this);
        this.leaveMeeting = this.leaveMeeting.bind(this);
        this.handleParticipantJoin = this.handleParticipantJoin.bind(this);
        this.handleParticipantLeave = this.handleParticipantLeave.bind(this);
    }

    // Initialize meeting
    async initialize() {
        try {
            // Initialize WebRTC
            await this.webrtc.initializeLocalStream();
            
            // Set up meeting room in Firestore
            const roomRef = this.firestore.collection('meetings').doc(this.roomId);
            const roomDoc = await roomRef.get();
            
            if (!roomDoc.exists) {
                throw new Error('Meeting room not found');
            }

            const roomData = roomDoc.data();
            this.isHost = roomData.hostId === this.userId;

            // Set up real-time listeners
            this.setupRoomListeners();
            
            return true;
        } catch (error) {
            console.error('Error initializing meeting:', error);
            throw error;
        }
    }

    // Set up real-time listeners for room events
    setupRoomListeners() {
        const roomRef = this.rtdb.ref(`rooms/${this.roomId}`);

        // Listen for new participants
        roomRef.child('participants').on('child_added', (snapshot) => {
            const participantId = snapshot.key;
            const participantData = snapshot.val();
            if (participantId !== this.userId) {
                this.handleParticipantJoin(participantId, participantData);
            }
        });

        // Listen for participant removals
        roomRef.child('participants').on('child_removed', (snapshot) => {
            const participantId = snapshot.key;
            this.handleParticipantLeave(participantId);
        });

        // Listen for offers
        roomRef.child(`offers`).on('child_added', async (snapshot) => {
            const [senderId, receiverId] = snapshot.key.split('_');
            if (receiverId === this.userId) {
                const offer = snapshot.val();
                await this.handleOffer(senderId, offer);
            }
        });

        // Listen for answers
        roomRef.child(`answers`).on('child_added', async (snapshot) => {
            const [senderId, receiverId] = snapshot.key.split('_');
            if (receiverId === this.userId) {
                const answer = snapshot.val();
                await this.handleAnswer(senderId, answer);
            }
        });

        // Listen for ICE candidates
        roomRef.child(`candidates`).on('child_added', async (snapshot) => {
            const [senderId, receiverId] = snapshot.key.split('_');
            if (receiverId === this.userId) {
                const candidate = snapshot.val();
                await this.webrtc.processICECandidate(candidate);
            }
        });

        // Listen for chat messages
        roomRef.child('chat').on('child_added', (snapshot) => {
            const message = snapshot.val();
            this.handleChatMessage(message);
        });

        // Listen for reactions
        roomRef.child('reactions').on('child_added', (snapshot) => {
            const reaction = snapshot.val();
            this.handleReaction(reaction);
        });
    }

    // Join meeting
    async joinMeeting() {
        try {
            const roomRef = this.rtdb.ref(`rooms/${this.roomId}`);
            
            // Add participant to the room
            await roomRef.child(`participants/${this.userId}`).set({
                joined: new Date().toISOString(),
                name: this.userId, // Should be replaced with actual user name
                role: this.isHost ? 'host' : 'participant'
            });

            // If waiting room is enabled and not host, wait for approval
            const meetingDoc = await this.firestore.collection('meetings').doc(this.roomId).get();
            const meetingData = meetingDoc.data();
            
            if (meetingData.waitingRoom && !this.isHost) {
                await this.waitForApproval();
            }

            return true;
        } catch (error) {
            console.error('Error joining meeting:', error);
            throw error;
        }
    }

    // Wait for host approval
    waitForApproval() {
        return new Promise((resolve, reject) => {
            const approvalRef = this.rtdb.ref(`rooms/${this.roomId}/waitingRoom/${this.userId}`);
            
            approvalRef.on('value', (snapshot) => {
                const status = snapshot.val();
                if (status === 'approved') {
                    approvalRef.off();
                    resolve();
                } else if (status === 'rejected') {
                    approvalRef.off();
                    reject(new Error('Meeting access denied by host'));
                }
            });
        });
    }

    // Leave meeting
    async leaveMeeting() {
        try {
            // Remove participant from the room
            await this.rtdb.ref(`rooms/${this.roomId}/participants/${this.userId}`).remove();
            
            // Clean up WebRTC connections
            this.webrtc.cleanup();
            
            // Stop recording if active
            if (this.isRecording) {
                await this.stopRecording();
            }
            
            // Stop transcription if active
            if (this.transcriptionEnabled) {
                this.stopTranscription();
            }
            
            return true;
        } catch (error) {
            console.error('Error leaving meeting:', error);
            throw error;
        }
    }

    // Handle new participant joining
    async handleParticipantJoin(participantId, participantData) {
        try {
            this.participants.set(participantId, participantData);
            
            // Create peer connection for new participant
            await this.webrtc.createPeerConnection(participantId);
            
            // Dispatch event for UI update
            window.dispatchEvent(new CustomEvent('participantJoined', {
                detail: { participantId, participantData }
            }));
        } catch (error) {
            console.error('Error handling participant join:', error);
        }
    }

    // Handle participant leaving
    handleParticipantLeave(participantId) {
        this.participants.delete(participantId);
        this.webrtc.handlePeerDisconnection(participantId);
        
        // Dispatch event for UI update
        window.dispatchEvent(new CustomEvent('participantLeft', {
            detail: { participantId }
        }));
    }

    // Start recording
    async startRecording() {
        try {
            const stream = new MediaStream();
            
            // Add all video tracks to the recording stream
            this.webrtc.localStream.getVideoTracks().forEach(track => stream.addTrack(track));
            this.webrtc.remoteStreams.forEach(remoteStream => {
                remoteStream.getVideoTracks().forEach(track => stream.addTrack(track));
            });
            
            // Add all audio tracks
            this.webrtc.localStream.getAudioTracks().forEach(track => stream.addTrack(track));
            this.webrtc.remoteStreams.forEach(remoteStream => {
                remoteStream.getAudioTracks().forEach(track => stream.addTrack(track));
            });
            
            this.mediaRecorder = new MediaRecorder(stream);
            this.recordedChunks = [];
            
            this.mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    this.recordedChunks.push(event.data);
                }
            };
            
            this.mediaRecorder.onstop = async () => {
                const blob = new Blob(this.recordedChunks, { type: 'video/webm' });
                await this.uploadRecording(blob);
            };
            
            this.mediaRecorder.start();
            this.isRecording = true;
        } catch (error) {
            console.error('Error starting recording:', error);
            throw error;
        }
    }

    // Stop recording
    async stopRecording() {
        if (this.mediaRecorder && this.isRecording) {
            this.mediaRecorder.stop();
            this.isRecording = false;
        }
    }

    // Upload recording to Firebase Storage
    async uploadRecording(blob) {
        try {
            const storage = firebase.storage();
            const recordingRef = storage.ref(`recordings/${this.roomId}/${new Date().toISOString()}.webm`);
            
            const uploadTask = recordingRef.put(blob);
            
            uploadTask.on('state_changed',
                (snapshot) => {
                    const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
                    console.log('Upload progress:', progress);
                },
                (error) => {
                    console.error('Error uploading recording:', error);
                },
                async () => {
                    const downloadURL = await uploadTask.snapshot.ref.getDownloadURL();
                    await this.firestore.collection('meetings').doc(this.roomId).update({
                        recordings: firebase.firestore.FieldValue.arrayUnion({
                            url: downloadURL,
                            timestamp: new Date().toISOString(),
                            duration: this.recordedChunks.length * 100 // Approximate duration
                        })
                    });
                }
            );
        } catch (error) {
            console.error('Error uploading recording:', error);
            throw error;
        }
    }

    // Start transcription
    async startTranscription() {
        try {
            // Initialize Web Speech API
            const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
            const recognition = new SpeechRecognition();
            
            recognition.continuous = true;
            recognition.interimResults = true;
            
            recognition.onresult = async (event) => {
                const transcript = Array.from(event.results)
                    .map(result => result[0].transcript)
                    .join('');
                
                await this.rtdb.ref(`rooms/${this.roomId}/transcription`).push({
                    userId: this.userId,
                    timestamp: new Date().toISOString(),
                    text: transcript
                });
            };
            
            recognition.start();
            this.transcriptionEnabled = true;
        } catch (error) {
            console.error('Error starting transcription:', error);
            throw error;
        }
    }

    // Stop transcription
    stopTranscription() {
        if (this.transcriptionEnabled) {
            this.transcriptionWorker && this.transcriptionWorker.terminate();
            this.transcriptionEnabled = false;
        }
    }

    // Send chat message
    async sendMessage(message, type = 'text') {
        try {
            await this.rtdb.ref(`rooms/${this.roomId}/chat`).push({
                userId: this.userId,
                type,
                content: message,
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            console.error('Error sending message:', error);
            throw error;
        }
    }

    // Send reaction
    async sendReaction(reaction) {
        try {
            await this.rtdb.ref(`rooms/${this.roomId}/reactions`).push({
                userId: this.userId,
                reaction,
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            console.error('Error sending reaction:', error);
            throw error;
        }
    }

    // Toggle participant audio
    async toggleParticipantAudio(participantId, muted) {
        if (this.isHost) {
            await this.rtdb.ref(`rooms/${this.roomId}/participants/${participantId}/audio`).set(muted);
        }
    }

    // Toggle participant video
    async toggleParticipantVideo(participantId, disabled) {
        if (this.isHost) {
            await this.rtdb.ref(`rooms/${this.roomId}/participants/${participantId}/video`).set(disabled);
        }
    }

    // Remove participant (host only)
    async removeParticipant(participantId) {
        if (this.isHost) {
            await this.rtdb.ref(`rooms/${this.roomId}/participants/${participantId}`).remove();
        }
    }

    // Handle chat message
    handleChatMessage(message) {
        window.dispatchEvent(new CustomEvent('chatMessage', {
            detail: message
        }));
    }

    // Handle reaction
    handleReaction(reaction) {
        window.dispatchEvent(new CustomEvent('reaction', {
            detail: reaction
        }));
    }

    // Clean up resources
    cleanup() {
        // Remove all listeners
        this.rtdb.ref(`rooms/${this.roomId}`).off();
        
        // Clean up WebRTC
        this.webrtc.cleanup();
        
        // Stop recording and transcription
        if (this.isRecording) {
            this.stopRecording();
        }
        if (this.transcriptionEnabled) {
            this.stopTranscription();
        }
    }
}

export default MeetingManager; 